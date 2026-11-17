import { defineConfig } from 'vitest/config';

/**
 * Benchmark-only config: ONE file, ONE worker, no parallelism. Every driver
 * invocation of this config is a fresh Node process that runs a single arm
 * sweep and exits before the next one starts.
 */
export default defineConfig({
  test: {
    include: ['PPC-P2-PREPARED-TRANSITION-01/probe/benchD1.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
