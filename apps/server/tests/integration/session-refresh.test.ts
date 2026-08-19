import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { api, setAccessToken } from '../../../client/src/api/client.js';
import { REFRESH_COOKIE_NAME } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { closeTestPool, createTestApp, registerAccount, type TestAccount } from '../helpers/app.js';
import { createFetchHarness, type FetchHarness } from '../helpers/browser-fetch.js';

/**
 * Regression coverage for the session-killing bug found during development.
 *
 * React StrictMode double-invokes effects in development, so `SessionProvider`'s
 * session-restore effect fired two `/auth/refresh` calls carrying the *same*
 * refresh token. Refresh tokens rotate on use and reuse is treated as theft, so
 * the second call tripped family-wide revocation and silently logged the player
 * out on every dev page load.
 *
 * The fix (apps/client/src/api/client.ts) shares a single in-flight refresh
 * promise between concurrent callers. These tests assert the observable
 * contract — one network refresh, surviving session — against the real client
 * module and a real server, so they keep holding through refactors of either.
 */
const REFRESH_PATH = '/api/v1/auth/refresh';
const ME_PATH = '/api/v1/me';

let app: FastifyInstance;
let db: Db;
let harness: FetchHarness;
let account: TestAccount;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ app, db } = await createTestApp());
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  await closeTestPool();
});

beforeEach(async () => {
  harness = createFetchHarness(app);
  globalThis.fetch = harness.fetch;
  account = await registerAccount(app);
  harness.setCookie(REFRESH_COOKIE_NAME, account.refreshToken);
  setAccessToken(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setAccessToken(null);
});

async function unrevokedTokenCount(): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    'SELECT count(*) AS count FROM refresh_tokens WHERE account_id = $1 AND revoked_at IS NULL',
    [account.accountId],
  );
  return Number(rows[0]!.count);
}

describe('concurrent session restore (React StrictMode double-invoke)', () => {
  it('sends only one refresh to the server for two simultaneous restores', async () => {
    await Promise.all([api.restoreSession(), api.restoreSession()]);
    expect(harness.callsTo(REFRESH_PATH)).toBe(1);
  });

  it('returns a live session to both callers', async () => {
    const [first, second] = await Promise.all([api.restoreSession(), api.restoreSession()]);

    expect(first?.account.id).toBe(account.accountId);
    expect(second?.account.id).toBe(account.accountId);
  });

  it('leaves the session usable afterwards instead of silently logging the player out', async () => {
    await Promise.all([api.restoreSession(), api.restoreSession()]);

    const me = await api.me();
    expect(me.account.id).toBe(account.accountId);
  });

  it('does not trip family-wide revocation — one live refresh token remains', async () => {
    await Promise.all([api.restoreSession(), api.restoreSession()]);
    expect(await unrevokedTokenCount()).toBe(1);
  });

  it('survives a third simultaneous restore, not just two', async () => {
    const results = await Promise.all([api.restoreSession(), api.restoreSession(), api.restoreSession()]);

    expect(harness.callsTo(REFRESH_PATH)).toBe(1);
    expect(results.every((result) => result?.account.id === account.accountId)).toBe(true);
  });
});

describe('concurrent authenticated requests behind an expired access token', () => {
  beforeEach(() => {
    setAccessToken('an.expired.token');
  });

  it('refreshes once for two requests that both hit 401', async () => {
    await Promise.all([api.me(), api.me()]);
    expect(harness.callsTo(REFRESH_PATH)).toBe(1);
  });

  it('retries and succeeds on both requests', async () => {
    const [first, second] = await Promise.all([api.me(), api.me()]);

    expect(first.account.id).toBe(account.accountId);
    expect(second.account.id).toBe(account.accountId);
  });

  it('retries each failed request exactly once (two initial calls plus two retries)', async () => {
    await Promise.all([api.me(), api.me()]);
    expect(harness.callsTo(ME_PATH)).toBe(4);
  });

  it('keeps the token family intact', async () => {
    await Promise.all([api.me(), api.me()]);
    expect(await unrevokedTokenCount()).toBe(1);
  });
});

describe('sequential refreshes still rotate normally', () => {
  it('performs a separate refresh per restore when they do not overlap', async () => {
    await api.restoreSession();
    await api.restoreSession();

    expect(harness.callsTo(REFRESH_PATH)).toBe(2);
    expect(await unrevokedTokenCount()).toBe(1);
  });
});

describe('a genuinely invalid session', () => {
  it('reports no session rather than looping on refresh', async () => {
    harness.cookies.delete(REFRESH_COOKIE_NAME);

    const restored = await api.restoreSession();

    expect(restored).toBeNull();
    expect(harness.callsTo(REFRESH_PATH)).toBe(1);
  });

  it('reports no session for both concurrent callers, with one refresh attempt', async () => {
    harness.cookies.delete(REFRESH_COOKIE_NAME);

    const results = await Promise.all([api.restoreSession(), api.restoreSession()]);

    expect(results).toEqual([null, null]);
    expect(harness.callsTo(REFRESH_PATH)).toBe(1);
  });

  it('allows a later refresh attempt once a valid cookie is present again', async () => {
    harness.cookies.delete(REFRESH_COOKIE_NAME);
    await api.restoreSession();

    harness.setCookie(REFRESH_COOKIE_NAME, account.refreshToken);
    const restored = await api.restoreSession();

    expect(restored?.account.id).toBe(account.accountId);
  });
});
