import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { CharacterCreateInput } from '@lethalmagotchi/shared';
import { buildApp } from '../../src/app.js';
import { createDummyHash } from '../../src/auth/passwords.js';
import type { Config } from '../../src/config.js';
import { REFRESH_COOKIE_NAME } from '../../src/config.js';
import { createPool, type Db } from '../../src/db/pool.js';
import { createLimiters, type Limiters } from '../../src/deps.js';
import { RateLimiter } from '../../src/rate-limit.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './env.js';

/** One pool per test *file* (vitest worker), closed by `closeTestPool` in afterAll. */
let pool: Db | null = null;

export function testPool(): Db {
  pool ??= createPool(TEST_DATABASE_URL);
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Argon2id at OWASP settings costs ~50ms; hash the dummy password once per worker. */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= createDummyHash();
  return dummyHashPromise;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 0,
    host: '127.0.0.1',
    databaseUrl: TEST_DATABASE_URL,
    jwtSecret: TEST_JWT_SECRET,
    clientOrigins: ['http://localhost:5173'],
    cookieSecure: false,
    clientDist: undefined,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    ...overrides,
  };
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  limiters: Limiters;
  config: Config;
}

/**
 * Every test in a file shares one client IP (`app.inject` reports 127.0.0.1), so
 * production limits would throttle the *fixtures* rather than the behaviour under
 * test. Suites that are actually about rate limiting opt into the real numbers
 * with `createTestApp({ realLimits: true })`.
 */
function relaxedLimiters(): Limiters {
  const generous = () => new RateLimiter({ limit: 100_000, windowMs: 60_000 });
  return {
    register: generous(),
    loginByIp: generous(),
    loginByUsername: generous(),
    usernameLookup: generous(),
    characterChurn: generous(),
  };
}

/**
 * A fully wired app with its own limiter set (so one test's rate-limit spending
 * never leaks into the next) against the shared test database. No port binding —
 * callers drive it with `app.inject()`.
 */
export async function createTestApp(
  options: { config?: Partial<Config>; realLimits?: boolean; limiters?: Limiters } = {},
): Promise<TestApp> {
  const config = testConfig(options.config);
  const db = testPool();
  const limiters = options.limiters ?? (options.realLimits ? createLimiters() : relaxedLimiters());
  const app = await buildApp({ config, db, dummyPasswordHash: await dummyHash(), limiters });
  return { app, db, limiters, config };
}

/** Usernames must satisfy ^[a-z0-9_]{3,20}$; keep them unique so tests never collide. */
export function uniqueUsername(prefix = 'qa'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export const VALID_PASSWORD = 'correct-horse-battery-9';

export const VALID_CHARACTER: CharacterCreateInput = {
  speciesId: 'otter',
  nickname: 'Bubbles',
  bio: 'Professional rock collector.',
  originCountry: 'NL',
  originCity: 'Utrecht',
  occupationId: 'chef',
  personalityId: 'goofball',
};

export function refreshCookieOf(response: LightMyRequestResponse): string | undefined {
  const cookie = response.cookies.find((entry) => entry.name === REFRESH_COOKIE_NAME);
  return cookie?.value === '' ? undefined : (cookie?.value as string | undefined);
}

export interface TestAccount {
  username: string;
  password: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerAccount(
  app: FastifyInstance,
  overrides: { username?: string; password?: string } = {},
): Promise<TestAccount> {
  const username = overrides.username ?? uniqueUsername();
  const password = overrides.password ?? VALID_PASSWORD;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password },
  });
  if (response.statusCode !== 201) {
    throw new Error(`registerAccount failed (${response.statusCode}): ${response.body}`);
  }
  const body = response.json();
  return {
    username,
    password,
    accountId: body.account.id,
    accessToken: body.accessToken,
    refreshToken: refreshCookieOf(response)!,
  };
}

export function authed(account: TestAccount, options: InjectOptions): InjectOptions {
  return {
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${account.accessToken}` },
  };
}
