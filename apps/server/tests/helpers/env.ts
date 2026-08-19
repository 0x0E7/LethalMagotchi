/**
 * Test environment constants shared by the vitest global setup, the integration
 * helpers, and the Playwright e2e server.
 *
 * The DSN is the same one docker-compose.dev.yml exposes, pointed at a separate
 * `_test` database so a test run never touches dev data.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://lethal:lethal@localhost:5432/lethalmagotchi_test';

export const TEST_JWT_SECRET = 'test-only-secret-at-least-16-chars';
