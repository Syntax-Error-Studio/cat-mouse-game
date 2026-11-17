import { defineConfig } from 'vitest/config';

// READ-ONLY tail certification config. Serial by construction.
export default defineConfig({
  test: {
    include: ['PPC-T2-PCV-TAIL-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporter: ['verbose'],
  },
});
