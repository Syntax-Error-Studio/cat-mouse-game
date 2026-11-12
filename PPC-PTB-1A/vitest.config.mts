import { defineConfig } from 'vitest/config';

// Isolated runner for the PPC-PTB-1A certificate probe.
//
// Deliberately a SEPARATE config: the production `vitest.config.ts`
// (include = src/**\/*.test.ts) stays untouched, so the research probe can
// never leak into the product test suite. Run with:
//
//   npx vitest run --config PPC-PTB-1A/vitest.config.mts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['PPC-PTB-1A/**/*.test.mts'],
    testTimeout: 600000,
    reporter: ['verbose'],
  },
});
