import { defineConfig } from 'vitest/config';

// Isolated runner for PPC-SEARCH-01 (PVS single-variable experiment).
//
// Deliberately a SEPARATE config: the production `vitest.config.ts`
// (include = src/**/*.test.ts) stays untouched, so this prototype can never
// leak into the product test suite. Run with:
//
//   npx vitest run --config PPC-SEARCH-01/vitest.config.mts
//
// One worker, no file parallelism: HEAVY_WORKER_CONCURRENCY = 1, and every
// budget is stricter than it needs to be rather than looser.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['PPC-SEARCH-01/**/*.test.mts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    reporter: ['verbose'],
  },
});
