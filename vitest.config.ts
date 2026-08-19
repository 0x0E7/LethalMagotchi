import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests run against packages/shared *source*, not its built dist/. CI runs
// `npm test` before `npm run build`, and source-level resolution gives real
// stack frames instead of generated ones.
const alias = {
  '@lethalmagotchi/shared': path.resolve(root, 'packages/shared/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['apps/server/tests/integration/**/*.test.ts'],
          globalSetup: ['./apps/server/tests/helpers/global-setup.ts'],
          // Integration tests share one Postgres database. Files run serially so a
          // failure points at one scenario rather than at connection contention.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
