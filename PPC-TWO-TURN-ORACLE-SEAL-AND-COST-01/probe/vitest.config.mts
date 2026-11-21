import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['PPC-TWO-TURN-ORACLE-SEAL-AND-COST-01/probe/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});