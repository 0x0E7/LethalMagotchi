import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../src/db/pool.js';
import { STARTING_STATS } from '../../src/repos/characters.js';
import {
  VALID_CHARACTER,
  authed,
  closeTestPool,
  createTestApp,
  registerAccount,
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

const createCharacter = (account: TestAccount, overrides: Record<string, unknown> = {}) =>
  app.inject(
    authed(account, {
      method: 'POST',
      url: '/api/v1/characters',
      payload: { ...VALID_CHARACTER, ...overrides },
    }),
  );

describe('POST /api/v1/characters', () => {
  it('creates a character with starting stats', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account);

    expect(response.statusCode).toBe(201);
    const { character } = response.json();
    expect(character.nickname).toBe('Bubbles');
    expect(character.speciesId).toBe('otter');
    expect(character.accountId).toBe(account.accountId);
    expect(character.stats).toEqual(STARTING_STATS);
  });

  it('persists the character so a later /me sees it', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const me = await app.inject(authed(account, { method: 'GET', url: '/api/v1/me' }));
    expect(me.statusCode).toBe(200);
    expect(me.json().character.nickname).toBe('Bubbles');
  });

  it('stores the sanitized value, not the raw submission', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, {
      nickname: '  Sir   Reginald  ',
      originCity: '  New   York ',
      originCountry: 'us',
    });

    const { character } = response.json();
    expect(character.nickname).toBe('Sir Reginald');
    expect(character.originCity).toBe('New York');
    expect(character.originCountry).toBe('US');
  });

  it('preserves line breaks in a bio, up to the documented limit', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { bio: 'Line one\nLine two\nLine three' });

    expect(response.statusCode).toBe(201);
    expect(response.json().character.bio).toBe('Line one\nLine two\nLine three');
  });

  it('rejects a bio with too many line breaks', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { bio: 'a\nb\nc\nd\ne\nf' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.bio).toMatch(/line breaks/i);
  });

  it('stores an omitted city as null rather than an empty string', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { originCity: '' });
    expect(response.json().character.originCity).toBeNull();
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      payload: VALID_CHARACTER,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a forged bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: { authorization: 'Bearer not.a.real.jwt' },
      payload: VALID_CHARACTER,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown species before it reaches the database', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { speciesId: 'dragon' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.speciesId).toBeTruthy();
  });

  it('rejects a country outside the allow-list', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { originCountry: 'ZZ' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.originCountry).toBeTruthy();
  });

  it('ignores a client-supplied accountId and uses the token instead', async () => {
    const victim = await registerAccount(app);
    const attacker = await registerAccount(app);

    const response = await createCharacter(attacker, { accountId: victim.accountId });

    expect(response.statusCode).toBe(201);
    expect(response.json().character.accountId).toBe(attacker.accountId);
  });

  it('ignores client-supplied starting stats', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { stats: { hunger: 100, hygiene: 100, energy: 100, mood: 100 } });
    expect(response.json().character.stats).toEqual(STARTING_STATS);
  });
});

describe('one character per account', () => {
  it('rejects a second character with 409 CHARACTER_EXISTS', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const second = await createCharacter(account, { nickname: 'Impostor' });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CHARACTER_EXISTS');
  });

  it('lets exactly one of two simultaneous creates win', async () => {
    // The route inserts optimistically and maps the unique-index violation to a
    // 409 rather than doing a check-then-insert, so a genuine double-submit must
    // not produce two characters.
    const account = await registerAccount(app);

    const responses = await Promise.all([
      createCharacter(account, { nickname: 'First' }),
      createCharacter(account, { nickname: 'Second' }),
    ]);

    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409]);
    expect(responses.find((r) => r.statusCode === 409)!.json().error.code).toBe('CHARACTER_EXISTS');

    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) AS count FROM characters WHERE account_id = $1 AND deleted_at IS NULL',
      [account.accountId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('holds under a wider burst of simultaneous creates', async () => {
    const account = await registerAccount(app);

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => createCharacter(account, { nickname: `Racer ${index}` })),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(5);
  });

  it('does not let one account block another from creating', async () => {
    const first = await registerAccount(app);
    const second = await registerAccount(app);
    await createCharacter(first);

    expect((await createCharacter(second)).statusCode).toBe(201);
  });
});

describe('bio moderation', () => {
  it('rejects a blocked term in the bio with 422 BIO_REJECTED', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { bio: 'you are a faggot' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('BIO_REJECTED');
    expect(response.json().error.fields.bio).toBeTruthy();
  });

  it('rejects a leetspeak evasion of a blocked term', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { bio: 'f4gg0t energy' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('BIO_REJECTED');
  });

  it('rejects a blocked term in the nickname', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { nickname: 'Faggot' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.nickname).toBeTruthy();
  });

  it('rejects a blocked term in the city', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, { originCity: 'Faggot Falls' });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.originCity).toBeTruthy();
  });

  it('creates nothing when moderation rejects the submission', async () => {
    const account = await registerAccount(app);
    await createCharacter(account, { bio: 'you are a faggot' });

    const me = await app.inject(authed(account, { method: 'GET', url: '/api/v1/me' }));
    expect(me.json().character).toBeNull();
  });

  it('does not false-positive on innocuous wording', async () => {
    const account = await registerAccount(app);
    const response = await createCharacter(account, {
      bio: 'Grew up on a grape farm. My therapist says I should socialise more.',
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('PATCH /api/v1/characters/me', () => {
  it('updates a mutable field', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const response = await app.inject(
      authed(account, { method: 'PATCH', url: '/api/v1/characters/me', payload: { nickname: 'Squeak' } }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().character.nickname).toBe('Squeak');
  });

  it('leaves untouched fields alone', async () => {
    const account = await registerAccount(app);
    const created = await createCharacter(account);

    const response = await app.inject(
      authed(account, { method: 'PATCH', url: '/api/v1/characters/me', payload: { nickname: 'Squeak' } }),
    );

    expect(response.json().character.bio).toBe(created.json().character.bio);
    expect(response.json().character.speciesId).toBe(created.json().character.speciesId);
  });

  it('cannot change the species', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const response = await app.inject(
      authed(account, {
        method: 'PATCH',
        url: '/api/v1/characters/me',
        payload: { nickname: 'Squeak', speciesId: 'dragon' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().character.speciesId).toBe('otter');
  });

  it('cannot rewrite the stats', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const response = await app.inject(
      authed(account, {
        method: 'PATCH',
        url: '/api/v1/characters/me',
        payload: { nickname: 'Squeak', stats: { hunger: 100, hygiene: 100, energy: 100, mood: 100 } },
      }),
    );

    expect(response.json().character.stats).toEqual(STARTING_STATS);
  });

  it('rejects an empty patch', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const response = await app.inject(
      authed(account, { method: 'PATCH', url: '/api/v1/characters/me', payload: {} }),
    );
    expect(response.statusCode).toBe(422);
  });

  it('runs moderation on edits, not just on creation', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const response = await app.inject(
      authed(account, { method: 'PATCH', url: '/api/v1/characters/me', payload: { bio: 'f a g g o t' } }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('BIO_REJECTED');
  });

  it('returns 404 when the account has no character', async () => {
    const account = await registerAccount(app);
    const response = await app.inject(
      authed(account, { method: 'PATCH', url: '/api/v1/characters/me', payload: { nickname: 'Ghost' } }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_CHARACTER');
  });

  it('only ever touches the caller’s own character', async () => {
    const owner = await registerAccount(app);
    const other = await registerAccount(app);
    await createCharacter(owner, { nickname: 'Owned' });
    await createCharacter(other, { nickname: 'Other' });

    await app.inject(
      authed(other, { method: 'PATCH', url: '/api/v1/characters/me', payload: { nickname: 'Hijacked' } }),
    );

    const ownerMe = await app.inject(authed(owner, { method: 'GET', url: '/api/v1/me' }));
    expect(ownerMe.json().character.nickname).toBe('Owned');
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/characters/me',
      payload: { nickname: 'Ghost' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('DELETE /api/v1/characters/me', () => {
  it('soft-deletes and reports the account as character-less', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);

    const response = await app.inject(authed(account, { method: 'DELETE', url: '/api/v1/characters/me' }));
    expect(response.statusCode).toBe(204);

    const me = await app.inject(authed(account, { method: 'GET', url: '/api/v1/me' }));
    expect(me.json().character).toBeNull();
  });

  it('keeps the row for the retention window instead of hard-deleting it', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);
    await app.inject(authed(account, { method: 'DELETE', url: '/api/v1/characters/me' }));

    const { rows } = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM characters WHERE account_id = $1',
      [account.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeInstanceOf(Date);
  });

  it('allows recreating afterwards, with fresh stats and a new id', async () => {
    const account = await registerAccount(app);
    const first = await createCharacter(account);
    await app.inject(authed(account, { method: 'DELETE', url: '/api/v1/characters/me' }));

    const second = await createCharacter(account, { speciesId: 'crow', nickname: 'Nevermore' });

    expect(second.statusCode).toBe(201);
    expect(second.json().character.id).not.toBe(first.json().character.id);
    expect(second.json().character.speciesId).toBe('crow');
    expect(second.json().character.stats).toEqual(STARTING_STATS);
  });

  it('returns 404 on a second delete', async () => {
    const account = await registerAccount(app);
    await createCharacter(account);
    await app.inject(authed(account, { method: 'DELETE', url: '/api/v1/characters/me' }));

    const response = await app.inject(authed(account, { method: 'DELETE', url: '/api/v1/characters/me' }));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NO_CHARACTER');
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/characters/me' });
    expect(response.statusCode).toBe(401);
  });
});

describe('create/delete abuse guard', () => {
  it('blocks the 6th create/delete cycle in a day with 429 CREATE_LIMIT_REACHED', async () => {
    const { app: isolated } = await createTestApp({ realLimits: true });
    try {
      const account = await registerAccount(isolated);

      for (let cycle = 0; cycle < 5; cycle += 1) {
        const created = await isolated.inject(
          authed(account, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }),
        );
        expect(created.statusCode).toBe(201);
        await isolated.inject(authed(account, { method: 'DELETE', url: '/api/v1/characters/me' }));
      }

      const blocked = await isolated.inject(
        authed(account, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }),
      );

      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('CREATE_LIMIT_REACHED');
      expect(blocked.headers['retry-after']).toBeTruthy();
    } finally {
      await isolated.close();
    }
  });

  it('is scoped per account, so one player cannot exhaust another’s allowance', async () => {
    const { app: isolated } = await createTestApp({ realLimits: true });
    try {
      const heavy = await registerAccount(isolated);
      const bystander = await registerAccount(isolated);

      for (let cycle = 0; cycle < 5; cycle += 1) {
        await isolated.inject(
          authed(heavy, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }),
        );
        await isolated.inject(authed(heavy, { method: 'DELETE', url: '/api/v1/characters/me' }));
      }

      const response = await isolated.inject(
        authed(bystander, { method: 'POST', url: '/api/v1/characters', payload: VALID_CHARACTER }),
      );
      expect(response.statusCode).toBe(201);
    } finally {
      await isolated.close();
    }
  });
});

describe('GET /api/v1/me', () => {
  it('returns the account with a null character before creation', async () => {
    const account = await registerAccount(app);
    const response = await app.inject(authed(account, { method: 'GET', url: '/api/v1/me' }));

    expect(response.statusCode).toBe(200);
    expect(response.json().account.username).toBe(account.username);
    expect(response.json().character).toBeNull();
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an access token signed with a different secret', async () => {
    const account = await registerAccount(app);
    const { app: otherApp } = await createTestApp({ config: { jwtSecret: 'a-completely-different-secret' } });
    try {
      const response = await otherApp.inject(authed(account, { method: 'GET', url: '/api/v1/me' }));
      expect(response.statusCode).toBe(401);
    } finally {
      await otherApp.close();
    }
  });
});
