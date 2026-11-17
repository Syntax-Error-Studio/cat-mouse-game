import { defineConfig } from 'vitest/config';

// RESEARCH-ONLY probe config for PPC-CAT-STRATEGY-SEAL-01. It does not touch the
// production vitest config and does not modify any previous-round artifact:
//   npx vitest run --config PPC-CAT-STRATEGY-SEAL-01/probe/vitest.config.mts
// Serial by construction (RESOURCE_SAFETY: HEAVY_WORKER_CONCURRENCY = 1).
export default defineConfig({
  test: {
    include: ['PPC-CAT-STRATEGY-SEAL-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    reporter: ['verbose'],
  },
});