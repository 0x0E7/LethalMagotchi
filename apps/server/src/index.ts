import { buildApp } from './app.js';
import { createDummyHash } from './auth/passwords.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLimiters } from './deps.js';
import { TournamentService } from './tournament/service.js';
import { Hub } from './ws/hub.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const hub = new Hub();

const tournaments = new TournamentService({
  db,
  hub,
  config: config.tournament,
  log: (message, meta) => console.log(JSON.stringify({ message, ...meta })),
});

const app = await buildApp({
  config,
  db,
  dummyPasswordHash: await createDummyHash(),
  limiters: createLimiters(),
  hub,
  tournaments,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await tournaments.stop();
  hub.closeAll();
  await app.close();
  await db.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * Recovery runs to completion before the first request is accepted: until it does, stale
 * `seated_table_id`s and a tournament that is about to be cancelled are still visible. A
 * scheduler that cannot start is not fatal — the instance still serves play, exactly as
 * it does when another instance holds the scheduler lock.
 */
try {
  await tournaments.start();
} catch (error) {
  app.log.error({ err: error }, 'tournament scheduler failed to start; serving without it');
}

await app.listen({ port: config.port, host: config.host });
