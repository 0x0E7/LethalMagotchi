import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  COUNTRIES,
  OCCUPATION_IDS,
  PERSONALITY_IDS,
  SHOP_ITEMS,
  SHOP_ITEM_IDS,
  SPECIES_IDS,
} from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import { VALID_CHARACTER, authed, closeTestPool, createTestApp, registerAccount } from '../helpers/app.js';

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  ({ app, db } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('GET /api/v1/reference', () => {
  it('is readable without authentication, since character creation needs it first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(response.statusCode).toBe(200);
  });

  it('serves every species id the shared allow-list declares', async () => {
    const { species } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(species.map((entry: { id: string }) => entry.id).sort()).toEqual([...SPECIES_IDS].sort());
  });

  it('serves every personality and occupation id the shared allow-list declares', async () => {
    const payload = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(payload.personalities.map((entry: { id: string }) => entry.id).sort()).toEqual(
      [...PERSONALITY_IDS].sort(),
    );
    expect(payload.occupations.map((entry: { id: string }) => entry.id).sort()).toEqual(
      [...OCCUPATION_IDS].sort(),
    );
  });

  it('serves the full country allow-list the schema validates against', async () => {
    const { countries } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(countries).toHaveLength(COUNTRIES.length);
  });

  it('includes the decay rates the species picker renders pace hints from', async () => {
    const { species } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    for (const entry of species) {
      expect(entry.baseDecayRates).toMatchObject({
        hunger: expect.any(Number),
        hygiene: expect.any(Number),
        energy: expect.any(Number),
        mood: expect.any(Number),
      });
    }
  });

  it('is ETagged and cacheable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(response.headers.etag).toBeTruthy();
    expect(response.headers['cache-control']).toContain('max-age');
  });

  it('answers 304 with an empty body when the client already has the current version', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/reference',
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('answers 200 with the payload when the client has a stale ETag', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/reference',
      headers: { 'if-none-match': '"an-old-etag"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().species.length).toBeGreaterThan(0);
  });

  it('returns a stable ETag across requests so caches actually hit', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/reference' });
    expect(first.headers.etag).toBe(second.headers.etag);
  });
});

describe('shop catalogue over the wire', () => {
  it('serves every shop item id the shared catalogue declares', async () => {
    const { shopItems } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(shopItems.map((item: { id: string }) => item.id).sort()).toEqual([...SHOP_ITEM_IDS].sort());
  });

  it('serves the same prices and effects the shared catalogue prices actions with', async () => {
    // The tray renders from this payload while the server charges from the shared
    // catalogue, so a drift between the two would quote one price and bill another.
    const { shopItems } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    expect(shopItems).toEqual(SHOP_ITEMS.map((item) => expect.objectContaining({ ...item })));
  });

  it('groups items under a picker action the dock can open', async () => {
    const { shopItems } = (await app.inject({ method: 'GET', url: '/api/v1/reference' })).json();
    for (const item of shopItems) expect(['feed', 'entertain']).toContain(item.actionId);
  });
});

describe('reference cache lifetime', () => {
  /** Restores the seeded price whatever the assertions do. */
  async function withRepricedKibble(cost: number, run: () => Promise<void>): Promise<void> {
    await db.query('UPDATE shop_items SET cost = $1 WHERE id = $2', [cost, 'kibble']);
    try {
      await run();
    } finally {
      await db.query('UPDATE shop_items SET cost = $1 WHERE id = $2', [
        SHOP_ITEMS.find((item) => item.id === 'kibble')!.cost,
        'kibble',
      ]);
    }
  }

  it('keeps serving a consistent payload and ETag after the row changes underneath it', async () => {
    // The cache is per process: a price edit is invisible until restart. That is
    // acceptable for seeded data, but it must stay *self*-consistent — never a new
    // ETag with an old body, which would poison client caches.
    const { app: running } = await createTestApp();
    try {
      const warm = await running.inject({ method: 'GET', url: '/api/v1/reference' });

      await withRepricedKibble(99, async () => {
        const stale = await running.inject({ method: 'GET', url: '/api/v1/reference' });
        const item = stale.json().shopItems.find((entry: { id: string }) => entry.id === 'kibble');

        expect(item.cost).toBe(1);
        expect(stale.headers.etag).toBe(warm.headers.etag);
      });
    } finally {
      await running.close();
    }
  });

  it('picks the new price up on the next process, so the staleness is bounded by a restart', async () => {
    await withRepricedKibble(99, async () => {
      const { app: restarted } = await createTestApp();
      try {
        const response = await restarted.inject({ method: 'GET', url: '/api/v1/reference' });
        const item = response.json().shopItems.find((entry: { id: string }) => entry.id === 'kibble');
        expect(item.cost).toBe(99);
      } finally {
        await restarted.close();
      }
    });
  });

  it('charges the shared catalogue price even when the seeded row disagrees', async () => {
    // Pricing is never read from `shop_items` at action time, so a bad row edit can
    // mis-advertise a price but can never overcharge a player's wallet.
    const account = await registerAccount(app);
    await app.inject(authed(account, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }));

    await withRepricedKibble(99, async () => {
      const response = await app.inject(
        authed(account, {
          method: 'POST',
          url: '/api/v1/characters/me/actions/feed',
          payload: { itemId: 'kibble' },
        }),
      );

      expect(response.statusCode).toBe(200);
      expect(response.json().result.coinsSpent).toBe(1);
    });
  });
});
