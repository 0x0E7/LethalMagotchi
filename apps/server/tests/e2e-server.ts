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
import { DEFAULT_TOURNAMENT_CONFIG } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { seedReferenceData } from '../src/db/seed.js';
import type { Limiters } from '../src/deps.js';
import { RateLimiter } from '../src/rate-limit.js';
import { TournamentService } from '../src/tournament/service.js';
import { Hub } from '../src/ws/hub.js';
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
  trustProxy: false,
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  /**
   * The socket and the whole table protocol are always the real thing. Only the
   * *scheduler* is opt-in: the standard e2e suite keeps it off so no background
   * tournament charges characters mid-spec, while `scripts/verify-poker.mjs` turns it on
   * with a short interval to drive a real multi-browser tournament end to end.
   */
  tournament: {
    ...DEFAULT_TOURNAMENT_CONFIG,
    enabled: process.env.E2E_TOURNAMENTS === 'on',
    mode: 'interval',
    intervalMs: Number(process.env.E2E_TOURNAMENT_INTERVAL_MS ?? 60_000),
    registrationLeadMs: Number(process.env.E2E_TOURNAMENT_LEAD_MS ?? 20_000),
    turnMs: Number(process.env.E2E_TOURNAMENT_TURN_MS ?? 20_000),
    showdownMs: Number(process.env.E2E_TOURNAMENT_SHOWDOWN_MS ?? 2_500),
    roundBreakMs: Number(process.env.E2E_TOURNAMENT_ROUND_BREAK_MS ?? 6_000),
  },
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
    wsMessages: new RateLimiter({ limit: 120, windowMs: 10_000, maxBackoffMs: 60_000 }),
    wsSource: new RateLimiter({
      limit: 300,
      windowMs: 10_000,
      maxBackoffMs: 15 * 60_000,
      strikeDecayMs: 10 * 60_000,
    }),
    wsResync: new RateLimiter({ limit: 10, windowMs: 10_000, maxBackoffMs: 60_000 }),
  };
}

const db = createPool(config.databaseUrl);
await runMigrations(db, () => {});
await seedReferenceData(db);

const hub = new Hub();
// The socket and the table protocol are the real thing; only the *scheduler* stays off
// (never started), so no background tournament charges characters mid-spec.
const tournaments = new TournamentService({ db, hub, config: config.tournament });

const app = await buildApp({
  config,
  db,
  dummyPasswordHash: await createDummyHash(),
  limiters: e2eLimiters(),
  hub,
  tournaments,
});

const shutdown = async () => {
  await tournaments.stop();
  hub.closeAll();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// Same order as `src/index.ts`: boot recovery finishes before anything is served, so a
// suite that waits on /healthz is guaranteed to see a cleaned-up schedule. A killed
// previous run leaves tournaments in `running`, and those block scheduling until they are
// cancelled.
try {
  await tournaments.start();
} catch (error) {
  app.log.error({ err: error }, 'tournament scheduler failed to start; serving without it');
}

await app.listen({ port: config.port, host: config.host });
// eslint-disable-next-line no-console
console.log(`e2e server listening on http://127.0.0.1:${port} (client dist: ${clientDist})`);
