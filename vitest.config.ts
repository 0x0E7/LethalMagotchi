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
    /**
     * Integration tests share one Postgres database, and registration close deliberately
     * charges *every* character in it — so two integration files running at once corrupt
     * each other's population. This is a runner-level option: set inside a project it is
     * silently ignored, which is why it lives here rather than next to the project that
     * needs it.
     */
    fileParallelism: false,
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
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
