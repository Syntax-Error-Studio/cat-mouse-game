import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['PPC-P1-CLOSURE-01/probe/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
