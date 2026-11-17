import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['PPC-MCTS-01B/probe/impl/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    reporter: ['verbose'],
    // HEAVY_WORKER_CONCURRENCY = 1: one file at a time, one fork, serial.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
