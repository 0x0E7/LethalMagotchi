/**
 * Server process for the Playwright suite.
 *
 * Deliberately runs the *production* shape: one origin serving both the API and
 * the built SPA via CLIENT_DIST, which is the configuration the container uses
 * (and the one that used to crash at boot — see app-routing.test.ts).
 *
 * The one thing it does not run at production settings is auth rate limiting.
 * Every browser in the suite shares 127.0.0.1, so real limits (register 5/hr/IP,
 * login 10/15min/IP) would throttle test *setup* rather than anything under test,
 * and would make a second run inside 15 minutes fail. Limits are covered
 * exhaustively and deterministically by the integration suite instead. Everything
 * else — argon2, JWTs, cookie flags, moderation, the character churn guard — is
 * the real thing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { createDummyHash } from '../src/auth/passwords.js';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { seedReferenceData } from '../src/db/seed.js';
import type { Limiters } from '../src/deps.js';
import { RateLimiter } from '../src/rate-limit.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './helpers/env.js';

const port = Number(process.env.E2E_PORT ?? 8099);
const clientDist = path.resolve(fileURLToPath(new URL('../../client/dist', import.meta.url)));

const config: Config = {
  nodeEnv: 'test',
  port,
  host: '127.0.0.1',
  databaseUrl: TEST_DATABASE_URL,
  jwtSecret: TEST_JWT_SECRET,
  clientOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  cookieSecure: false,
  clientDist,
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
};

function e2eLimiters(): Limiters {
  const generous = () => new RateLimiter({ limit: 100_000, windowMs: 60_000 });
  return {
    register: generous(),
    loginByIp: generous(),
    loginByUsername: generous(),
    usernameLookup: generous(),
    // The abuse guard stays at its production setting — it is keyed per account,
    // and each test uses a fresh account.
    characterChurn: new RateLimiter({ limit: 5, windowMs: 24 * 60 * 60_000 }),
    actions: new RateLimiter({ limit: 60, windowMs: 60_000 }),
  };
}

const db = createPool(config.databaseUrl);
await runMigrations(db, () => {});
await seedReferenceData(db);

const app = await buildApp({
  config,
  db,
  dummyPasswordHash: await createDummyHash(),
  limiters: e2eLimiters(),
});

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await app.listen({ port: config.port, host: config.host });
// eslint-disable-next-line no-console
console.log(`e2e server listening on http://127.0.0.1:${port} (client dist: ${clientDist})`);
