import { buildApp } from './app.js';
import { createDummyHash } from './auth/passwords.js';
import { ChatRetentionJob } from './chat/retention.js';
import { ChatService } from './chat/service.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { DuelService } from './duel/service.js';
import { RaidService } from './raid/service.js';
import { createLimiters } from './deps.js';
import { TournamentService } from './tournament/service.js';
import { Hub } from './ws/hub.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const hub = new Hub();
const limiters = createLimiters();
const log = (message: string, meta?: Record<string, unknown>) =>
  console.log(JSON.stringify({ message, ...meta }));

const tournaments = new TournamentService({
  db,
  hub,
  config: config.tournament,
  log,
});

const chat = new ChatService({ db, hub, limiters, log });
const duels = new DuelService({ db, hub, chat, limiters, log });
const raids = new RaidService({ db, hub, limiters, log });
const chatRetention = new ChatRetentionJob({ db, log });

const app = await buildApp({
  config,
  db,
  dummyPasswordHash: await createDummyHash(),
  limiters,
  hub,
  tournaments,
  chat,
  duels,
  raids,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await tournaments.stop();
  await duels.stop();
  await raids.stop();
  await chatRetention.stop();
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

// Duels held in memory cannot survive a restart, so whatever the last process left behind
// is abandoned before the first socket is accepted.
await duels.start();
// Same reasoning for raids: an escrow held by a raid whose runner died with the process
// goes back to the wallet it came from before the first socket is accepted.
await raids.start();

chatRetention.start();

await app.listen({ port: config.port, host: config.host });
