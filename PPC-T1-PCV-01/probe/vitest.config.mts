import { defineConfig } from 'vitest/config';

// RESEARCH-ONLY probe config for PPC-T1-PCV-01. Touches no production config
// and no previous-round artifact. Serial by construction:
//   HEAVY_WORKER_CONCURRENCY = 1, maxWorkers = 1, fileParallelism = false.
export default defineConfig({
  test: {
    include: ['PPC-T1-PCV-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporter: ['verbose'],
  },
});
