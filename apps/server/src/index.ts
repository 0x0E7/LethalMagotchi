import { buildApp } from './app.js';
import { createDummyHash } from './auth/passwords.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLimiters } from './deps.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);

const app = await buildApp({
  config,
  db,
  dummyPasswordHash: await createDummyHash(),
  limiters: createLimiters(),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
