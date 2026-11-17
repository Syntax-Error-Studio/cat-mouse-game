import { defineConfig } from 'vitest/config';

// PPC-D2-PCV-COUNTERLINE-01 / G2 pilot — serial by construction.
export default defineConfig({
  test: {
    include: ['PPC-D2-PCV-COUNTERLINE-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 7_200_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    reporter: ['verbose'],
  },
});
