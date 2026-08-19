import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './apps/client/e2e',
  // The e2e suite drives a shared server and a shared Postgres; serial execution
  // keeps failures readable and costs little at this suite size.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Serves the built SPA and the API from one origin, exactly like the
    // production container.
    command: 'npx tsx apps/server/tests/e2e-server.ts',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});
