import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DuelCardsResponse } from '@lethalmagotchi/shared';
import type { Db } from '../../src/db/pool.js';
import {
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
  testPool,
  uniqueUsername,
  VALID_CHARACTER,
  type TestAccount,
} from '../helpers/app.js';

interface Player extends TestAccount {
  characterId: string;
  nickname: string;
}

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  db = testPool();
  ({ app } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

/** Nicknames are not unique, so fixtures carry a suffix to be findable on their own. */
function uniqueNickname(label: string): string {
  return `${label}${randomUUID().slice(0, 6)}`;
}

async function makePlayer(nickname: string, withCharacter = true): Promise<Player> {
  const account = await registerAccount(app, { username: uniqueUsername('dir') });
  let characterId = '';
  if (withCharacter) {
    const response = await app.inject(
      authed(account, {
        method: 'POST',
        url: '/api/v1/characters',
        payload: { ...VALID_CHARACTER, nickname },
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
    characterId = response.json().character.id;
  }
  return { ...account, characterId, nickname };
}

function search(viewer: Player, q?: string) {
  const query = q === undefined ? '' : `?q=${encodeURIComponent(q)}`;
  return app.inject(authed(viewer, { method: 'GET', url: `/api/v1/players${query}` }));
}

function nicknames(response: { json: () => DuelCardsResponse }): string[] {
  return response.json().cards.map((card) => card.nickname);
}

describe('the people directory', () => {
  it('finds a player by name who has never said anything', async () => {
    // The whole point: before this endpoint the only way to reach someone was to catch them
    // posting in the Town Square, so a quiet player was unreachable for a DM or an invite.
    const quiet = await makePlayer(uniqueNickname('Quiet'));
    const viewer = await makePlayer(uniqueNickname('Viewer'));

    const response = await search(viewer, quiet.nickname);
    expect(response.statusCode, response.body).toBe(200);
    expect(nicknames(response)).toContain(quiet.nickname);
  });

  it('matches a fragment rather than only a prefix', async () => {
    const target = await makePlayer(uniqueNickname('Marigold'));
    const viewer = await makePlayer(uniqueNickname('Viewer'));

    const response = await search(viewer, target.nickname.slice(3, 9));
    expect(nicknames(response)).toContain(target.nickname);
  });

  it('ignores case', async () => {
    const target = await makePlayer(uniqueNickname('Sunflower'));
    const viewer = await makePlayer(uniqueNickname('Viewer'));

    const response = await search(viewer, target.nickname.toUpperCase());
    expect(nicknames(response)).toContain(target.nickname);
  });

  it('never returns the searcher to themselves', async () => {
    // A directory whose first entry is you is one you have to look past every time.
    const viewer = await makePlayer(uniqueNickname('Selfsearch'));

    const response = await search(viewer, viewer.nickname);
    expect(nicknames(response)).not.toContain(viewer.nickname);
  });

  it('leaves a deleted character out', async () => {
    const gone = await makePlayer(uniqueNickname('Departed'));
    const viewer = await makePlayer(uniqueNickname('Viewer'));
    await db.query('UPDATE characters SET deleted_at = now() WHERE id = $1', [gone.characterId]);

    const response = await search(viewer, gone.nickname);
    expect(nicknames(response)).not.toContain(gone.nickname);
  });

  it('treats a LIKE wildcard as text, not as a wildcard', async () => {
    // Unescaped, a search for "%" matches every player and turns the directory into a
    // scrape of the whole population — the one thing the result cap exists to prevent.
    const target = await makePlayer(uniqueNickname('Wildcard'));
    const viewer = await makePlayer(uniqueNickname('Viewer'));

    const response = await search(viewer, '%');
    expect(response.statusCode, response.body).toBe(200);
    expect(nicknames(response)).not.toContain(target.nickname);
  });

  it('carries the public card and nothing more', async () => {
    const target = await makePlayer(uniqueNickname('Carded'));
    const viewer = await makePlayer(uniqueNickname('Viewer'));

    const response = await search(viewer, target.nickname);
    const body = response.json() as DuelCardsResponse;
    const card = body.cards.find((entry) => entry.nickname === target.nickname);
    expect(card).toBeDefined();
    // The same vetted shape the Town Square already renders: a wealth band, never a balance.
    expect(card).toHaveProperty('wealthBand');
    expect(card).not.toHaveProperty('lethalCoins');
    expect(card).not.toHaveProperty('username');
  });

  it('refuses a caller with no character', async () => {
    const bare = await makePlayer(uniqueNickname('Charless'), false);

    const response = await search(bare, 'anyone');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_CHARACTER');
  });

  it('refuses an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/players' });
    expect(response.statusCode).toBe(401);
  });

  it('answers an empty search with who is online, not with everybody', async () => {
    // Nobody holds a socket in this suite, so "online" is empty — which is the point: an
    // empty term must not fall through to listing the whole population.
    const viewer = await makePlayer(uniqueNickname('Viewer'));
    await makePlayer(uniqueNickname('Offline'));

    const response = await search(viewer);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().cards).toEqual([]);
  });
});

describe('the directory under the real rate limit', () => {
  it('throttles a caller walking it quickly', async () => {
    const { app: strict } = await createTestApp({ realLimits: true });
    try {
      const account = await registerAccount(strict, { username: uniqueUsername('dirlim') });
      await strict.inject(
        authed(account, {
          method: 'POST',
          url: '/api/v1/characters',
          payload: { ...VALID_CHARACTER, nickname: uniqueNickname('Limited') },
        }),
      );

      const codes: number[] = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await strict.inject(
          authed(account, { method: 'GET', url: `/api/v1/players?q=a${attempt}` }),
        );
        codes.push(response.statusCode);
      }

      expect(codes).toContain(429);
    } finally {
      await strict.close();
    }
  });
});
