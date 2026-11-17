import { defineConfig } from 'vitest/config';

/**
 * PPC-P1-ID-01 performance harness config.
 *
 * Isolated from the production `vitest.config.ts` (`src/**` only) so the
 * two-arm timing harness can live in the report directory without touching the
 * project's test discovery. Node environment, no DOM, single file per run.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['PPC-P1-ID-01/perf/*.test.ts'],
    testTimeout: 600000,
    reporter: ['dot'],
    fileParallelism: false,
  },
});
