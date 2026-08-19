import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { hashRefreshToken } from '../../src/auth/tokens.js';
import {
  VALID_PASSWORD,
  closeTestPool,
  createTestApp,
  refreshCookieOf,
  registerAccount,
  uniqueUsername,
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

describe('POST /api/v1/auth/register', () => {
  it('creates an account and logs it straight in', async () => {
    const username = uniqueUsername();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.account.username).toBe(username);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.character).toBeNull();
  });

  it('never returns the password or its hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: uniqueUsername(), password: VALID_PASSWORD },
    });
    expect(response.body).not.toContain(VALID_PASSWORD);
    expect(response.body).not.toContain('argon2');
    expect(response.json().account).not.toHaveProperty('passwordHash');
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict cookie scoped to /auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: uniqueUsername(), password: VALID_PASSWORD },
    });

    const cookie = response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: REFRESH_COOKIE_PATH });
    expect(cookie!.value).not.toBe('');
  });

  it('stores the refresh token hashed, never in the clear', async () => {
    const account = await registerAccount(app);
    const { rows } = await db.query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens WHERE account_id = $1',
      [account.accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(account.refreshToken);
    expect(rows[0]!.token_hash).toBe(hashRefreshToken(account.refreshToken));
  });

  it('rejects a duplicate username with 409 USERNAME_TAKEN', async () => {
    const username = uniqueUsername();
    await registerAccount(app, { username });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('USERNAME_TAKEN');
    expect(response.json().error.fields.username).toBeTruthy();
  });

  it('collides case-insensitively at the database index, not just in the client', async () => {
    const username = uniqueUsername();
    await registerAccount(app, { username });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: username.toUpperCase(), password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('collides on NFKC-equivalent spellings (fullwidth vs ASCII)', async () => {
    const username = uniqueUsername('nfkc');
    await registerAccount(app, { username });

    // Fullwidth Latin letters normalize to their ASCII counterparts under NFKC.
    const fullwidth = [...username]
      .map((char) => (/[a-z0-9]/.test(char) ? String.fromCodePoint(char.codePointAt(0)! + 0xfee0) : char))
      .join('');
    expect(fullwidth).not.toBe(username);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: fullwidth, password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('preserves the display casing the player typed while normalizing for uniqueness', async () => {
    const username = uniqueUsername();
    const mixedCase = username.toUpperCase();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: mixedCase, password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().account.username).toBe(mixedCase);
  });

  it('rejects a reserved username with a field-level 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'admin', password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(response.json().error.fields.username).toMatch(/reserved/i);
  });

  it('rejects a password that contains the username', async () => {
    const username = uniqueUsername();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, password: `x-${username}-x-pad` },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.password).toMatch(/username/i);
  });

  it('rejects a common password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: uniqueUsername(), password: 'password123' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.password).toMatch(/common/i);
  });

  it('rejects a malformed body without leaking an internal error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 12345, password: null },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a syntactically invalid JSON body with 400, not 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"username":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns a session for correct credentials', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: account.password },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().account.id).toBe(account.accountId);
    expect(refreshCookieOf(response)).toBeTruthy();
  });

  it('accepts a username typed in different casing', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username.toUpperCase(), password: account.password },
    });

    expect(response.statusCode).toBe(200);
  });

  it('records the login timestamp', async () => {
    const account = await registerAccount(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: account.password },
    });

    const { rows } = await db.query<{ last_login_at: Date | null }>(
      'SELECT last_login_at FROM accounts WHERE id = $1',
      [account.accountId],
    );
    expect(rows[0]!.last_login_at).toBeInstanceOf(Date);
  });

  it('issues a distinct refresh token on every login', async () => {
    const account = await registerAccount(app);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: account.password },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: account.password },
    });

    expect(refreshCookieOf(first)).not.toBe(refreshCookieOf(second));
  });

  it('rejects a wrong password with a generic error', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: 'not-the-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(response.json().error.message).toBe('Invalid username or password.');
  });

  it('returns a byte-identical response for an unknown username, leaking no account existence', async () => {
    const account = await registerAccount(app);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: 'not-the-password' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: uniqueUsername('ghost'), password: 'not-the-password' },
    });

    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownUser.body).toBe(wrongPassword.body);
  });

  it('sets no refresh cookie on a failed login', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: uniqueUsername('ghost'), password: 'not-the-password' },
    });
    expect(refreshCookieOf(response)).toBeUndefined();
  });

  it('spends comparable time on an unknown username as on a wrong password (dummy-hash flattening)', async () => {
    // Without the dummy Argon2 verify, an unknown username would short-circuit at
    // the DB lookup and answer an order of magnitude faster, which is an account
    // enumeration oracle. Argon2id at m=19456,t=2 costs tens of milliseconds; a
    // bare "user not found" costs single-digit milliseconds.
    const account = await registerAccount(app);
    const time = async (username: string): Promise<number> => {
      const startedAt = performance.now();
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password: 'not-the-password' },
      });
      return performance.now() - startedAt;
    };

    // Warm the argon2 native binding so the first call does not skew the ratio.
    await time(account.username);

    const knownUser = await time(account.username);
    const unknownUser = await time(uniqueUsername('ghost'));

    expect(unknownUser).toBeGreaterThan(knownUser * 0.4);
  });
});

describe('login rate limiting', () => {
  it('blocks a username after 5 failed attempts in the window', async () => {
    const { app: isolated } = await createTestApp({ realLimits: true });
    try {
      const account = await registerAccount(isolated);
      const attempt = () =>
        isolated.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: account.username, password: 'wrong-password' },
        });

      for (let i = 0; i < 5; i += 1) expect((await attempt()).statusCode).toBe(401);

      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
      expect(blocked.headers['retry-after']).toBeTruthy();
    } finally {
      await isolated.close();
    }
  });

  it('blocks a rate-limited username even when the password is correct', async () => {
    const { app: isolated } = await createTestApp({ realLimits: true });
    try {
      const account = await registerAccount(isolated);
      for (let i = 0; i < 5; i += 1) {
        await isolated.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: account.username, password: 'wrong-password' },
        });
      }

      const response = await isolated.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: account.username, password: account.password },
      });
      expect(response.statusCode).toBe(429);
    } finally {
      await isolated.close();
    }
  });

  it('blocks the 6th registration from one IP within the hour', async () => {
    const { app: isolated } = await createTestApp({ realLimits: true });
    try {
      for (let i = 0; i < 5; i += 1) await registerAccount(isolated);
      const blocked = await isolated.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { username: uniqueUsername(), password: VALID_PASSWORD },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await isolated.close();
    }
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the refresh token and returns a fresh access token', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toEqual(expect.any(String));
    const rotated = refreshCookieOf(response);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(account.refreshToken);
  });

  it('rejects a request with no cookie at all', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token that was never issued', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: 'a-token-nobody-ever-issued' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an expired token and revokes it', async () => {
    const account = await registerAccount(app);
    await db.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 day' WHERE token_hash = $1", [
      hashRefreshToken(account.refreshToken),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });

    expect(response.statusCode).toBe(401);
    const { rows } = await db.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1',
      [hashRefreshToken(account.refreshToken)],
    );
    expect(rows[0]!.revoked_at).not.toBeNull();
  });

  it('clears the cookie when the presented token is rejected', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: 'a-token-nobody-ever-issued' },
    });
    expect(refreshCookieOf(response)).toBeUndefined();
    expect(response.cookies.some((cookie) => cookie.name === REFRESH_COOKIE_NAME)).toBe(true);
  });
});

describe('refresh token reuse detection', () => {
  it('rejects a token that has already been rotated away', async () => {
    const account = await registerAccount(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('UNAUTHORIZED');
  });

  // Product decision (2026-08-19): no cascading family-wide revocation on
  // reuse (see the long comment on `rotateRefreshToken`) — a dead token
  // simply can never succeed again, for anyone, and the legitimate
  // successor it was rotated into is never collaterally destroyed by a
  // replay attempt (benign or malicious).
  it('rejects a replayed, already-rotated token without disturbing its legitimate successor', async () => {
    const account = await registerAccount(app);
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });
    const successor = refreshCookieOf(rotated)!;

    // An attacker (or a stale client) replays the already-spent token.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // The legitimate holder's still-unused successor keeps working.
    const legitimateUse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: successor },
    });
    expect(legitimateUse.statusCode).toBe(200);

    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) AS count FROM refresh_tokens WHERE account_id = $1 AND revoked_at IS NULL',
      [account.accountId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  // Product decision (2026-08-19): atomic rotation, accept deterministic
  // 2nd-tab logout. `rotateRefreshToken` now atomically claims the token via
  // `revokeRefreshTokenIfActive` (UPDATE ... WHERE revoked_at IS NULL
  // RETURNING) — only the caller that flips the row gets to issue a
  // successor. The race loser gets a plain 401 and must sign in again; it
  // does NOT trigger family-wide revocation, since that would also kill the
  // winner's brand-new token. Genuine replay (a token already revoked at
  // read time, i.e. not a same-instant race) is unaffected and still nukes
  // the family — see the reuse-detection tests above.
  it('never leaves two live refresh tokens after a concurrent rotation of one token', async () => {
    const account = await registerAccount(app);

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
      }),
    ]);

    // Exactly one side of the race wins (200) and the other is told to sign
    // in again (401) — never 200/200 (forked family) and never 401/401
    // (both callers wrongly logged out).
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 401]);

    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) AS count FROM refresh_tokens WHERE account_id = $1 AND revoked_at IS NULL',
      [account.accountId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('leaves other accounts untouched when one token is replayed', async () => {
    const victim = await registerAccount(app);
    const bystander = await registerAccount(app);

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: victim.refreshToken },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: victim.refreshToken },
    });

    const bystanderRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: bystander.refreshToken },
    });
    expect(bystanderRefresh.statusCode).toBe(200);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the presented token and clears the cookie', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });

    expect(response.statusCode).toBe(204);
    const cleared = response.cookies.find((cookie) => cookie.name === REFRESH_COOKIE_NAME);
    expect(cleared?.value).toBe('');
  });

  it('makes the logged-out token unusable', async () => {
    const account = await registerAccount(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });
    expect(response.statusCode).toBe(401);
  });

  it('succeeds even with no session, so a stuck client can always clear itself', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(response.statusCode).toBe(204);
  });
});

describe('GET /api/v1/auth/username-available', () => {
  it('reports a free username as available', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/username-available?username=${uniqueUsername('free')}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().available).toBe(true);
    expect(response.json().suggestions).toEqual([]);
  });

  it('reports a taken username as unavailable and offers alternatives', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/username-available?username=${account.username}`,
    });

    expect(response.json().available).toBe(false);
    expect(response.json().suggestions.length).toBeGreaterThan(0);
  });

  it('treats a casing variant of a taken username as unavailable', async () => {
    const account = await registerAccount(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/username-available?username=${account.username.toUpperCase()}`,
    });
    expect(response.json().available).toBe(false);
  });

  it('reports a reserved username as unavailable without querying for it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/username-available?username=admin',
    });
    expect(response.json().available).toBe(false);
  });

  it('rejects a missing username parameter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/username-available' });
    expect(response.statusCode).toBe(422);
  });
});
