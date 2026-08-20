import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  COOLDOWN_SPEC,
  SHOP_ITEMS,
  SHOP_ITEMS_BY_ID,
  effectiveDecayRates,
  type ActionId,
  type ShopItemId,
} from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import { RateLimiter } from '../../src/rate-limit.js';
import {
  VALID_CHARACTER,
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  relaxedLimiters,
  type TestAccount,
} from '../helpers/app.js';

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  ({ app, db } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

interface Player extends TestAccount {
  characterId: string;
}

/** A registered account that already owns the standard otter, ready to act. */
async function newPlayer(overrides: Record<string, unknown> = {}): Promise<Player> {
  const account = await registerAccount(app);
  const created = await app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, ...overrides },
    }),
  );
  if (created.statusCode !== 201) throw new Error(`character setup failed: ${created.body}`);
  return { ...account, characterId: created.json().character.id };
}

function fire(
  player: TestAccount,
  action: string,
  payload: unknown = {},
): Promise<LightMyRequestResponse> {
  return app.inject(
    authed(player, { method: 'POST', url: `/api/v1/characters/me/actions/${action}`, payload }),
  );
}

/**
 * Time travel is done in SQL rather than by waiting: `entertain` is a 2-minute
 * cooldown and `study` a 15-minute one, and the route reads `Date.now()` directly.
 */
async function backdateWatermark(characterId: string, hours: number): Promise<void> {
  await db.query(`UPDATE characters SET last_simulated_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
    characterId,
    String(hours),
  ]);
}

async function backdateCooldown(characterId: string, action: ActionId, secondsAgo: number): Promise<void> {
  await db.query(
    `UPDATE characters
     SET action_cooldowns = jsonb_set(action_cooldowns, ARRAY[$2], to_jsonb($3::text))
     WHERE id = $1`,
    [characterId, action, new Date(Date.now() - secondsAgo * 1000).toISOString()],
  );
}

async function setCoins(characterId: string, coins: number): Promise<void> {
  await db.query('UPDATE characters SET lethal_coins = $2 WHERE id = $1', [characterId, coins]);
}

/** Pins every stat to one value at "now", so an action's deltas are exact. */
async function setStats(characterId: string, value: number): Promise<void> {
  await db.query(
    `UPDATE characters
     SET stats = $2, last_simulated_at = now()
     WHERE id = $1`,
    [
      characterId,
      JSON.stringify({ hunger: value, hygiene: value, energy: value, mood: value, hp: value, education: value }),
    ],
  );
}

async function readRow(characterId: string) {
  const { rows } = await db.query<{
    stats: Record<string, number>;
    lethal_coins: number;
    action_cooldowns: Record<string, string>;
    last_simulated_at: Date;
  }>('SELECT stats, lethal_coins, action_cooldowns, last_simulated_at FROM characters WHERE id = $1', [
    characterId,
  ]);
  return rows[0]!;
}

describe('POST /api/v1/characters/me/actions/:action — success', () => {
  it('feeds the pet, charges the item and reports what moved', async () => {
    const player = await newPlayer();
    await setStats(player.characterId, 40);

    const response = await fire(player, 'feed', { itemId: 'hearty_meal' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result).toMatchObject({
      action: 'feed',
      itemId: 'hearty_meal',
      clipId: 'hearty_meal',
      deltas: { hunger: 30 },
      coinsSpent: 3,
    });
    expect(body.character.stats.hunger).toBeCloseTo(70, 1);
    expect(body.character.lethalCoins).toBe(2);
  });

  it('applies every one of the catalogued shop items with its exact effects', async () => {
    for (const item of SHOP_ITEMS) {
      const player = await newPlayer();
      await setCoins(player.characterId, 20);
      await setStats(player.characterId, 30);

      const response = await fire(player, item.actionId, { itemId: item.id });

      expect(response.statusCode, `${item.id}: ${response.body}`).toBe(200);
      const { result, character } = response.json();
      const expected = Object.fromEntries(item.effects.map((effect) => [effect.stat, effect.value]));

      expect(result.deltas, item.id).toEqual(expected);
      expect(result.clipId, item.id).toBe(item.id);
      expect(character.lethalCoins, item.id).toBe(20 - item.cost);
    }
  });

  it('runs each instant action with its documented effect', async () => {
    const player = await newPlayer();
    await setStats(player.characterId, 30);

    const shower = await fire(player, 'shower');
    expect(shower.statusCode).toBe(200);
    expect(shower.json().result.deltas).toEqual({ hygiene: 70 });
    expect(shower.json().character.stats.hygiene).toBe(100);

    const rest = await fire(player, 'rest');
    expect(rest.json().result.deltas).toEqual({ energy: 30, hunger: -5 });

    const study = await fire(player, 'study');
    expect(study.json().result.deltas).toEqual({ education: 8.4, energy: -8, mood: -3 });
    expect(study.json().result.coinsSpent).toBe(0);
  });

  it('persists the new state so the next read agrees with the action response', async () => {
    const player = await newPlayer();
    await setStats(player.characterId, 50);
    const acted = await fire(player, 'feed', { itemId: 'kibble' });

    const me = await app.inject(authed(player, { method: 'GET', url: '/api/v1/me' }));

    expect(me.json().character.lethalCoins).toBe(acted.json().character.lethalCoins);
    expect(me.json().character.actionCooldowns.feed).toBe(acted.json().character.actionCooldowns.feed);
    expect(me.json().character.stats.hunger).toBeLessThanOrEqual(acted.json().character.stats.hunger);
  });

  it('advances the simulation watermark, so the same decay is never charged twice', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 10);

    const before = await readRow(player.characterId);
    await fire(player, 'shower');
    const after = await readRow(player.characterId);

    expect(after.last_simulated_at.getTime()).toBeGreaterThan(before.last_simulated_at.getTime());
    expect(Date.now() - after.last_simulated_at.getTime()).toBeLessThan(10_000);
  });

  it('acts on the decayed stats, not on the stale row the database still holds', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 10);
    const rates = effectiveDecayRates(VALID_CHARACTER.speciesId, VALID_CHARACTER.personalityId);
    const decayedHunger = 100 - rates.hunger * 10;

    const response = await fire(player, 'feed', { itemId: 'kibble' });

    // Naively feeding the stored 100 would report 100; the pet has been hungry for
    // ten hours and must land near decayed + 10 instead.
    expect(response.json().character.stats.hunger).toBeCloseTo(decayedHunger + 10, 0);
  });

  it('rounds the stats it returns to two decimals', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 7);

    const { stats } = (await fire(player, 'shower')).json().character;

    for (const value of Object.values(stats) as number[]) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
  });

  it('stamps a cooldown that matches the spec for the action just used', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'entertain', { itemId: 'yard_play' });

    const { cooldownEndsAt } = response.json().result;
    const usedAt = Date.parse(response.json().character.actionCooldowns.entertain);
    expect(Date.parse(cooldownEndsAt) - usedAt).toBe(COOLDOWN_SPEC.entertain.seconds * 1000);
  });
});

describe('POST /api/v1/characters/me/actions/:action — rejections', () => {
  it('rejects a picker action fired without an item', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'feed');

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(response.json().error.fields.itemId).toBeTruthy();
  });

  it('rejects an item belonging to a different action', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'feed', { itemId: 'yard_play' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.itemId).toBeTruthy();
  });

  it('rejects an item attached to an instant action', async () => {
    const player = await newPlayer();
    expect((await fire(player, 'shower', { itemId: 'kibble' })).statusCode).toBe(422);
  });

  it('rejects an item id that is not in the catalog', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'feed', { itemId: 'golden_steak' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.itemId).toBeTruthy();
  });

  it('rejects an action id that is not in the catalog', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'meditate');

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.action).toBeTruthy();
  });

  it('charges nothing when the item is rejected', async () => {
    const player = await newPlayer();
    await fire(player, 'feed', { itemId: 'yard_play' });

    const row = await readRow(player.characterId);
    expect(row.lethal_coins).toBe(5);
    expect(row.action_cooldowns).toEqual({});
  });

  it('refuses an item the player cannot afford, and says how short they are', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'feed', { itemId: 'feast' });

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('INSUFFICIENT_FUNDS');
    expect(response.json().error.message).toMatch(/6 LethalCoins/);
    expect(response.json().error.message).toMatch(/1 more needed/);
  });

  it('leaves the wallet and the cooldown alone when the purchase fails', async () => {
    const player = await newPlayer();
    await fire(player, 'feed', { itemId: 'feast' });

    const row = await readRow(player.characterId);
    expect(row.lethal_coins).toBe(5);
    expect(row.action_cooldowns.feed).toBeUndefined();
  });

  it('blocks a repeat of the same action while its cooldown runs', async () => {
    const player = await newPlayer();
    await fire(player, 'feed', { itemId: 'kibble' });

    const response = await fire(player, 'feed', { itemId: 'kibble' });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('ACTION_ON_COOLDOWN');
    expect(response.json().error.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.headers['retry-after']).toBeTruthy();
  });

  it('words the shower cooldown as a daily one', async () => {
    const player = await newPlayer();
    await fire(player, 'shower');

    const response = await fire(player, 'shower');
    expect(response.statusCode).toBe(429);
    expect(response.json().error.message).toMatch(/already done today/i);
  });

  it('words a short cooldown differently from the daily one', async () => {
    const player = await newPlayer();
    await fire(player, 'study');

    expect((await fire(player, 'study')).json().error.message).toMatch(/give them a moment/i);
  });

  it('does not charge coins for an attempt that lands on cooldown', async () => {
    const player = await newPlayer();
    await setCoins(player.characterId, 10);
    await fire(player, 'feed', { itemId: 'hearty_meal' });

    await fire(player, 'feed', { itemId: 'hearty_meal' });

    expect((await readRow(player.characterId)).lethal_coins).toBe(7);
  });

  it('lets the action through again once the cooldown has expired', async () => {
    const player = await newPlayer();
    await fire(player, 'study');
    await backdateCooldown(player.characterId, 'study', COOLDOWN_SPEC.study.seconds + 1);

    expect((await fire(player, 'study')).statusCode).toBe(200);
  });

  it('keeps cooldowns per action, so a fed pet can still shower', async () => {
    const player = await newPlayer();
    await fire(player, 'feed', { itemId: 'kibble' });

    expect((await fire(player, 'shower')).statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/characters/me/actions/shower',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a forged bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/characters/me/actions/shower',
      headers: { authorization: 'Bearer not.a.real.jwt' },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an account that has no character yet', async () => {
    const account = await registerAccount(app);
    const response = await fire(account, 'shower');

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_CHARACTER');
  });

  it('returns 404 once the character has been deleted', async () => {
    const player = await newPlayer();
    await app.inject(authed(player, { method: 'DELETE', url: '/api/v1/characters/me' }));

    expect((await fire(player, 'shower')).statusCode).toBe(404);
  });

  it('only ever acts on the caller’s own character', async () => {
    const owner = await newPlayer();
    const other = await newPlayer();
    await setCoins(other.characterId, 20);

    await fire(other, 'feed', { itemId: 'feast' });

    expect((await readRow(owner.characterId)).lethal_coins).toBe(5);
  });
});

describe('POST /api/v1/characters/me/actions/:action — request body', () => {
  it('accepts an empty body for an instant action', async () => {
    const player = await newPlayer();
    expect((await fire(player, 'shower', {})).statusCode).toBe(200);
  });

  it('accepts an explicit null item for an instant action', async () => {
    const player = await newPlayer();
    expect((await fire(player, 'rest', { itemId: null })).statusCode).toBe(200);
  });

  it('rejects a client-supplied cost instead of honouring it', async () => {
    // Prices are server-side catalogue lookups; a body key that is not `itemId` at
    // all must be refused rather than quietly ignored.
    const player = await newPlayer();
    const response = await fire(player, 'feed', { itemId: 'feast', cost: 0 });

    expect(response.statusCode).toBe(422);
    expect((await readRow(player.characterId)).lethal_coins).toBe(5);
  });

  it('rejects a client-supplied stat block', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'shower', { stats: { hp: 100, hunger: 100 } });

    expect(response.statusCode).toBe(422);
  });

  it('rejects a client-supplied wallet top-up', async () => {
    const player = await newPlayer();
    const response = await fire(player, 'shower', { lethalCoins: 9999 });

    expect(response.statusCode).toBe(422);
    expect((await readRow(player.characterId)).lethal_coins).toBe(5);
  });

  it('rejects a malformed JSON body', async () => {
    const player = await newPlayer();
    const response = await app.inject(
      authed(player, {
        method: 'POST',
        url: '/api/v1/characters/me/actions/shower',
        headers: { 'content-type': 'application/json' },
        payload: '{"itemId":',
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('action flood guard', () => {
  it('rate-limits a burst of actions per account, above and beyond cooldowns', async () => {
    const { app: isolated } = await createTestApp({
      limiters: { ...relaxedLimiters(), actions: new RateLimiter({ limit: 2, windowMs: 60_000 }) },
    });
    try {
      const account = await registerAccount(isolated);
      await isolated.inject(
        authed(account, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }),
      );

      const attempt = () =>
        isolated.inject(
          authed(account, { method: 'POST', url: '/api/v1/characters/me/actions/shower', payload: {} }),
        );

      expect((await attempt()).statusCode).toBe(200);
      // Second attempt is inside the shower cooldown, but still spends a token.
      expect((await attempt()).statusCode).toBe(429);

      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await isolated.close();
    }
  });

  it('is scoped per account, so one player cannot lock another out', async () => {
    const { app: isolated } = await createTestApp({
      limiters: { ...relaxedLimiters(), actions: new RateLimiter({ limit: 1, windowMs: 60_000 }) },
    });
    try {
      const heavy = await registerAccount(isolated);
      const bystander = await registerAccount(isolated);
      for (const account of [heavy, bystander]) {
        await isolated.inject(
          authed(account, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }),
        );
      }

      await isolated.inject(
        authed(heavy, { method: 'POST', url: '/api/v1/characters/me/actions/shower', payload: {} }),
      );
      await isolated.inject(
        authed(heavy, { method: 'POST', url: '/api/v1/characters/me/actions/rest', payload: {} }),
      );

      const response = await isolated.inject(
        authed(bystander, { method: 'POST', url: '/api/v1/characters/me/actions/shower', payload: {} }),
      );
      expect(response.statusCode).toBe(200);
    } finally {
      await isolated.close();
    }
  });
});

describe('concurrent actions', () => {
  it('lets exactly one of two simultaneous fires of the same action win', async () => {
    const player = await newPlayer();
    await setCoins(player.characterId, 20);

    const responses = await Promise.all([
      fire(player, 'feed', { itemId: 'kibble' }),
      fire(player, 'feed', { itemId: 'kibble' }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429]);
    expect((await readRow(player.characterId)).lethal_coins).toBe(19);
  });

  it('holds under a wider burst, charging the wallet exactly once', async () => {
    const player = await newPlayer();
    await setCoins(player.characterId, 20);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => fire(player, 'feed', { itemId: 'hearty_meal' })),
    );

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(5);
    expect((await readRow(player.characterId)).lethal_coins).toBe(17);
  });

  it('does not let a simultaneous different action lose its write', async () => {
    // Both actions are legal at once; the row lock must serialise them rather than
    // letting the second overwrite the first's cooldown with a stale copy.
    const player = await newPlayer();
    await setCoins(player.characterId, 20);

    const responses = await Promise.all([fire(player, 'feed', { itemId: 'kibble' }), fire(player, 'shower')]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const row = await readRow(player.characterId);
    expect(row.action_cooldowns.feed).toBeTruthy();
    expect(row.action_cooldowns.shower).toBeTruthy();
    expect(row.lethal_coins).toBe(19);
  });

  it('applies both stat changes when two different actions land together', async () => {
    const player = await newPlayer();
    await setStats(player.characterId, 30);

    await Promise.all([fire(player, 'shower'), fire(player, 'rest')]);

    const row = await readRow(player.characterId);
    expect(row.stats.hygiene).toBeCloseTo(100, 3);
    expect(row.stats.energy).toBeCloseTo(60, 1);
  });
});

describe('neglect and HP', () => {
  it('reports decayed stats and a dented HP after a day and change away', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 26);

    const { character } = (await app.inject(authed(player, { method: 'GET', url: '/api/v1/me' }))).json();

    expect(character.stats.hunger).toBe(0);
    expect(character.stats.energy).toBe(0);
    expect(character.stats.hp).toBeGreaterThan(0);
    expect(character.stats.hp).toBeLessThan(100);
  });

  it('does not persist decay on a read, so the numbers do not drift between reads', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 26);
    const before = await readRow(player.characterId);

    const first = await app.inject(authed(player, { method: 'GET', url: '/api/v1/me' }));
    const second = await app.inject(authed(player, { method: 'GET', url: '/api/v1/me' }));

    expect((await readRow(player.characterId)).stats).toEqual(before.stats);
    expect(second.json().character.stats.hygiene).toBeCloseTo(first.json().character.stats.hygiene, 1);
  });

  it('bottoms HP out at zero after a month of neglect, never below', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 30 * 24);

    const { character } = (await app.inject(authed(player, { method: 'GET', url: '/api/v1/me' }))).json();

    expect(character.stats).toMatchObject({ hunger: 0, hygiene: 0, energy: 0, mood: 0, hp: 0 });
  });

  it('keeps a zero-HP pet fully playable — there is no death state yet', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 30 * 24);

    const response = await fire(player, 'shower');

    expect(response.statusCode).toBe(200);
    expect(response.json().character.stats.hygiene).toBe(100);
    expect(response.json().character.stats.hp).toBe(0);
  });

  it('cannot heal a zero-HP pet with actions alone — only recovered care regenerates HP', async () => {
    const player = await newPlayer();
    await setCoins(player.characterId, 20);
    await backdateWatermark(player.characterId, 30 * 24);

    await fire(player, 'feed', { itemId: 'feast' });

    expect((await readRow(player.characterId)).stats.hp).toBe(0);
  });

  it('regenerates HP once every care stat is back above the comfort line', async () => {
    const player = await newPlayer();
    await db.query(
      `UPDATE characters
       SET stats = '{"hunger":90,"hygiene":90,"energy":90,"mood":50,"hp":40,"education":10}'::jsonb,
           last_simulated_at = now() - interval '2 hours'
       WHERE id = $1`,
      [player.characterId],
    );

    const { character } = (await app.inject(authed(player, { method: 'GET', url: '/api/v1/me' }))).json();

    expect(character.stats.hp).toBeCloseTo(44, 1);
  });

  it('commits the neglect damage the moment the player finally acts', async () => {
    const player = await newPlayer();
    await backdateWatermark(player.characterId, 26);

    await fire(player, 'shower');

    const row = await readRow(player.characterId);
    expect(row.stats.hp).toBeLessThan(100);
    expect(row.stats.hunger).toBe(0);
  });
});

describe('economy invariants', () => {
  it('never lets the wallet go negative, whatever the player buys', async () => {
    const player = await newPlayer();
    await setCoins(player.characterId, 1);

    for (const item of SHOP_ITEMS) {
      await db.query(`UPDATE characters SET action_cooldowns = '{}'::jsonb WHERE id = $1`, [
        player.characterId,
      ]);
      await fire(player, item.actionId, { itemId: item.id });
      expect((await readRow(player.characterId)).lethal_coins).toBeGreaterThanOrEqual(0);
    }
  });

  it('prices from the server catalogue, not from anything the client sends', async () => {
    const player = await newPlayer();
    await setCoins(player.characterId, 20);

    const response = await fire(player, 'entertain', { itemId: 'night_out' });

    expect(response.json().result.coinsSpent).toBe(SHOP_ITEMS_BY_ID.night_out.cost);
    expect(response.json().character.lethalCoins).toBe(20 - SHOP_ITEMS_BY_ID.night_out.cost);
  });

  it('grants no coins for any action — actions are a sink, never a faucet', async () => {
    const player = await newPlayer();
    const free: [ActionId, ShopItemId | null][] = [
      ['shower', null],
      ['rest', null],
      ['study', null],
      ['entertain', 'yard_play'],
    ];

    for (const [action, itemId] of free) {
      await fire(player, action, itemId ? { itemId } : {});
    }

    expect((await readRow(player.characterId)).lethal_coins).toBe(5);
  });
});
