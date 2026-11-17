import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['PPC-P1-OPENING-STACK-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
