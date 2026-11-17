import { defineConfig } from 'vitest/config';

// RESEARCH-ONLY erratum probe config. Read-only over prior artifacts; writes
// only inside PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01. Serial by construction.
//   npx vitest run --config PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/probe/vitest.config.mts
export default defineConfig({
  test: {
    include: ['PPC-CAT-EVALUATOR-ABLATION-01-ERRATUM-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    reporter: ['verbose'],
  },
});
