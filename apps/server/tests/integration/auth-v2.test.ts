import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { REFRESH_COOKIE_NAME } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { hashRefreshToken } from '../../src/auth/tokens.js';
import {
  VALID_PASSWORD,
  authed,
  closeTestPool,
  createTestApp,
  refreshCookieOf,
  registerAccount,
  uniqueUsername,
} from '../helpers/app.js';

/**
 * The v2 (native mobile / WebGL-bridge) session transport — `v2-architecture.md` §14.3.
 *
 * The load-bearing property under test throughout this file is not "v2 works" — it is "v2 and
 * v1 are the same population, sharing the same accounts, the same refresh-token table, and
 * the same rate-limit budgets, with only the token's *transport* differing." A v2 that quietly
 * forked into a second account system, or that reset the brute-force clock for anyone who
 * called it instead of v1, would both pass a shallow "does the endpoint work" test while
 * failing the actual design constraint (§14.1: one backend, one shared population).
 */

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  // Relaxed limiters by default — `app.inject` reports every request as one IP, and most of
  // this file is not about rate limiting. The one test that is (below) opens its own isolated
  // app with `realLimits: true`, exactly like `auth.test.ts`'s "login rate limiting" block.
  ({ app, db } = await createTestApp());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('POST /api/v2/auth/register', () => {
  it('creates an account and returns the refresh token in the body, not a cookie', async () => {
    const username = uniqueUsername();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username, password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.account.username).toBe(username);
    expect(body.character).toBeNull();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));

    // There is no cookie jar on a native client — the whole point of this route is that the
    // token has nowhere to live but the body.
    expect(response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME)).toBeUndefined();
  });

  it('never returns the password or its hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username: uniqueUsername(), password: VALID_PASSWORD },
    });
    expect(response.body).not.toContain(VALID_PASSWORD);
    expect(response.body).not.toContain('argon2');
    expect(response.json().account).not.toHaveProperty('passwordHash');
  });

  it('stores the refresh token hashed, never in the clear — same table as v1', async () => {
    const username = uniqueUsername();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username, password: VALID_PASSWORD },
    });
    const { refreshToken } = response.json() as { refreshToken: string };

    const { rows } = await db.query<{ token_hash: string }>(
      `SELECT rt.token_hash FROM refresh_tokens rt
       JOIN accounts a ON a.id = rt.account_id
       WHERE a.username_normalized = $1`,
      [username],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(refreshToken);
    expect(rows[0]!.token_hash).toBe(hashRefreshToken(refreshToken));
  });

  it('rejects a duplicate username with 409 USERNAME_TAKEN, same as v1', async () => {
    const username = uniqueUsername();
    await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username, password: VALID_PASSWORD },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username, password: VALID_PASSWORD },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects a malformed body with 422, not a 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username: 'ab', password: 'short' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v2/auth/login', () => {
  it('returns a session with the refresh token in the body', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.account.username).toBe(account.username);
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME)).toBeUndefined();
  });

  it('issues a distinct refresh token from any v1 session on the same account', async () => {
    // Registered through v1, logged in through v2 — proving one account, reachable both ways,
    // per §14.1's "one backend, one shared population."
    const account = await registerAccount(app, { username: uniqueUsername() });

    const v2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });
    expect(v2Login.statusCode).toBe(200);
    expect(v2Login.json().refreshToken).not.toBe(account.refreshToken);
  });

  it('rejects a wrong password with the same generic error as v1', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: 'wrong-password-entirely' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('shares v1s per-username rate-limit bucket, so v2 cannot bypass brute-force protection', async () => {
    const { app: isolated } = await createTestApp({ realLimits: true });
    try {
      const account = await registerAccount(isolated);

      // Trip the limiter over v1 first.
      for (let i = 0; i < 5; i += 1) {
        await isolated.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: account.username, password: 'wrong-password' },
        });
      }

      // The 6th attempt, over v2, with the *correct* password, must still be blocked — if it
      // succeeded, v2 would be a working brute-force bypass for every v1 account.
      const response = await isolated.inject({
        method: 'POST',
        url: '/api/v2/auth/login',
        payload: { username: account.username, password: account.password },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await isolated.close();
    }
  });
});

describe('POST /api/v2/auth/refresh', () => {
  it('rotates the refresh token and returns a fresh access token plus a fresh refresh token', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const v2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });
    const { refreshToken } = v2Login.json() as { refreshToken: string };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/refresh',
      payload: { refreshToken },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.refreshToken).not.toBe(refreshToken);
  });

  it('rejects a token that has already been rotated away — same single-use rule as v1', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const v2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });
    const { refreshToken } = v2Login.json() as { refreshToken: string };

    await app.inject({ method: 'POST', url: '/api/v2/auth/refresh', payload: { refreshToken } });
    // The same token, presented again.
    const replay = await app.inject({ method: 'POST', url: '/api/v2/auth/refresh', payload: { refreshToken } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token that was never issued', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/refresh',
      payload: { refreshToken: 'not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a v1 cookie session presented as a v2 body token — they are the same table, and the same single-use rule applies either way', async () => {
    // Not a special case in the code: a v1 refresh token is just a row in `refresh_tokens`,
    // and `performRefresh` does not care which route reads it. This proves that by using one
    // to rotate through the v2 endpoint directly, and confirms it is subsequently spent.
    const account = await registerAccount(app, { username: uniqueUsername() });
    const viaV2 = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/refresh',
      payload: { refreshToken: account.refreshToken },
    });
    expect(viaV2.statusCode).toBe(200);

    const viaV1Cookie = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: account.refreshToken },
    });
    expect(viaV1Cookie.statusCode).toBe(401);
  });
});

describe('POST /api/v2/auth/logout', () => {
  it('revokes the presented token', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const v2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });
    const { refreshToken } = v2Login.json() as { refreshToken: string };

    const logout = await app.inject({ method: 'POST', url: '/api/v2/auth/logout', payload: { refreshToken } });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/refresh',
      payload: { refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('requires a token — there is no cookie fallback to log out of', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v2/auth/logout', payload: {} });
    expect(response.statusCode).toBe(422);
  });
});

describe('cross-transport identity — the actual point of this file', () => {
  it('lets a v1-registered account sign in through v2, and vice versa', async () => {
    const viaV1 = await registerAccount(app, { username: uniqueUsername() });
    const v1ThenV2 = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: viaV1.username, password: viaV1.password },
    });
    expect(v1ThenV2.statusCode).toBe(200);

    const username2 = uniqueUsername();
    const viaV2 = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/register',
      payload: { username: username2, password: VALID_PASSWORD },
    });
    expect(viaV2.statusCode).toBe(201);

    const v2ThenV1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: username2, password: VALID_PASSWORD },
    });
    expect(v2ThenV1.statusCode).toBe(200);
    expect(refreshCookieOf(v2ThenV1)).toEqual(expect.any(String));
  });

  it('a refresh token does not double as an access token, even carried the way v1 carries one', async () => {
    // The two token kinds must not be interchangeable: a refresh token is long-lived and
    // single-use-then-rotated, an access token is short-lived and freely reusable for 15
    // minutes. If a refresh token alone could authenticate a resource request, stealing it
    // would grant standing access rather than only the ability to mint one access token at a
    // time through `/refresh`.
    const account = await registerAccount(app, { username: uniqueUsername() });
    const v2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });
    const { refreshToken } = v2Login.json() as { refreshToken: string };

    const asBearer = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${refreshToken}` },
    });
    expect(asBearer.statusCode).toBe(401);

    const asV1Cookie = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      cookies: { [REFRESH_COOKIE_NAME]: refreshToken },
    });
    // No access token was presented on this request at all — a refresh-token cookie alone
    // does not authenticate a resource request in either version.
    expect(asV1Cookie.statusCode).toBe(401);
  });

  it('a v2-issued access token authenticates ordinary API requests exactly like a v1 one', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const v2Login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { username: account.username, password: account.password },
    });
    const { accessToken } = v2Login.json() as { accessToken: string };

    const me = await app.inject(
      authed({ ...account, accessToken }, { method: 'GET', url: '/api/v1/me' }),
    );
    expect(me.statusCode).toBe(200);
    expect(me.json().account.username).toBe(account.username);
  });
});

describe('v1 is untouched — the actual proof this workstream promised', () => {
  it('v1 register still sets a cookie and still omits refreshToken from the JSON body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: uniqueUsername(), password: VALID_PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    expect(refreshCookieOf(response)).toEqual(expect.any(String));
    // The security property `SessionResult`'s docstring names directly: this field must never
    // reach a browser-readable body, or `httpOnly` on the cookie is protecting nothing.
    expect(response.json()).not.toHaveProperty('refreshToken');
  });

  it('v1 login still sets a cookie and still omits refreshToken from the JSON body', async () => {
    const account = await registerAccount(app, { username: uniqueUsername() });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: account.username, password: account.password },
    });
    expect(refreshCookieOf(response)).toEqual(expect.any(String));
    expect(response.json()).not.toHaveProperty('refreshToken');
  });

  it('v1 refresh still reads the cookie and still clears it on rejection', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE_NAME]: 'not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
    const cookie = response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME);
    expect(cookie?.value).toBe('');
  });
});
