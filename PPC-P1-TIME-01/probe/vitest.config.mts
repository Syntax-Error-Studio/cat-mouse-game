import { defineConfig } from 'vitest/config';

/**
 * PPC-P1-TIME-01 probe runner.
 *
 * The repo's own `vitest.config.ts` only includes `src/**\/*.test.ts`, so the
 * research probes that live under `PPC-P1-TIME-01/probe/` need their own config
 * (same pattern as PPC-P1-ID-01/perf). Nothing here is part of the shipped test
 * suite.
 */
export default defineConfig({
  test: {
    include: ['PPC-P1-TIME-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
