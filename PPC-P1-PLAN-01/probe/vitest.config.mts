import { defineConfig } from 'vitest/config';

/**
 * PPC-P1-PLAN-01 probe runner.
 *
 * The repo's own `vitest.config.ts` only includes `src/**\/*.test.ts`, so the
 * pre/post witnesses under `PPC-P1-PLAN-01/probe/` need their own config (same
 * pattern as PPC-P1-TIME-01/probe and PPC-P1-TIME-02/trace).
 *
 * `fileParallelism: false`: one worker, so a witness run is a single process
 * and its wall-clock/step facts are not interleaved with another file.
 */
export default defineConfig({
  test: {
    include: ['PPC-P1-PLAN-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
