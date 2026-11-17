import { defineConfig } from 'vitest/config';

// RESEARCH-ONLY probe config. It does not touch the production vitest config:
// the probe suite lives outside `src/` and is run explicitly with
//   npx vitest run --config PPC-CAT-STRATEGY-01/probe/vitest.config.mts
// Serial by construction (RESOURCE_SAFETY: HEAVY_WORKER_CONCURRENCY = 1).
export default defineConfig({
  test: {
    include: ['PPC-CAT-STRATEGY-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    reporter: ['verbose'],
  },
});
