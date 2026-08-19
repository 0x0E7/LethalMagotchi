import { runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { TEST_DATABASE_URL } from './env.js';

/**
 * `docker-compose.dev.yml` only provisions the dev database, so on a fresh
 * machine the dedicated test database will not exist yet. Create it on demand
 * rather than making every contributor run a manual psql step.
 */
async function ensureDatabaseExists(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const databaseName = url.pathname.slice(1);

  const probe = createPool(TEST_DATABASE_URL);
  try {
    await probe.query('SELECT 1');
    return;
  } catch (error) {
    // 3D000 = invalid_catalog_name, i.e. the database is simply not there yet.
    if ((error as { code?: string }).code !== '3D000') throw error;
  } finally {
    await probe.end();
  }

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = createPool(adminUrl.toString());
  try {
    await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Runs once per `vitest run`, before any integration test file. Every step is
 * idempotent, so this is safe on a warm database and needs no teardown.
 */
export async function setup(): Promise<void> {
  await ensureDatabaseExists();

  const pool = createPool(TEST_DATABASE_URL);
  try {
    await runMigrations(pool, () => {});
    await seedReferenceData(pool);
  } finally {
    await pool.end();
  }
}
