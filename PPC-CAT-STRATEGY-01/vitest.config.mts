import { defineConfig } from 'vitest/config';

// Isolated runner for PPC-CAT-STRATEGY-01 (read-only research probe).
//
// A SEPARATE config so the research probe can never leak into the product test
// suite (production `vitest.config.ts` keeps include = src/**\/*.test.ts).
//
//   npx vitest run --config PPC-CAT-STRATEGY-01/vitest.config.mts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['PPC-CAT-STRATEGY-01/**/*.test.mts'],
    testTimeout: 900000,
    hookTimeout: 900000,
    reporter: ['verbose'],
    // One file, sequential: every test writes its own JSON artifact and the
    // later stages read the earlier ones. No parallelism inside the probe.
    fileParallelism: false,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
