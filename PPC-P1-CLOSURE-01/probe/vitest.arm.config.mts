import { defineConfig } from 'vitest/config';

// Isolated control arm: a frozen copy of `src/` with the six production files
// restored to their HEAD blob (see ARM_MANIFEST.json). Used ONLY to measure the
// same test against pre-change source without touching the working tree.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['PPC-P1-CLOSURE-01/arm-head/src/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    reporter: ['dot'],
  },
});
