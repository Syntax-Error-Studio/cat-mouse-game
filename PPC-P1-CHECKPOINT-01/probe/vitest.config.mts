import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['PPC-P1-CHECKPOINT-01/probe/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
