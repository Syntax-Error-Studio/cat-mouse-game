import { defineConfig } from 'vitest/config';

// Isolated runner for PPC-MOUSE-01 (shared search kernel + M0 mouse controller).
//
// Deliberately a SEPARATE config: the production `vitest.config.ts`
// (include = src/**/*.test.ts) stays untouched, so this prototype can never
// leak into the product suite. Run with:
//
//   npx vitest run --config PPC-MOUSE-01/vitest.config.mts
//
// HEAVY_WORKER_CONCURRENCY = 1: one fork, no file parallelism, so no two heavy
// searches can ever be alive at the same time.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['PPC-MOUSE-01/**/*.test.mts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    reporter: ['verbose'],
  },
});
