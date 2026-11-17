import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['PPC-MCTS-01B/probe/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    reporter: ['verbose'],
    // HEAVY_WORKER_CONCURRENCY = 1: one probe file at a time, one fork.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
