import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['PPC-P2-PREPARED-TRANSITION-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
