import { defineConfig } from 'vitest/config';

// RESEARCH-ONLY probe config for PPC-CAT-EVALUATOR-ABLATION-01. Touches no
// production vitest config and no previous-round artifact.
//   npx vitest run --config PPC-CAT-EVALUATOR-ABLATION-01/probe/vitest.config.mts <file>
// Serial by construction (HEAVY_WORKER_CONCURRENCY = 1).
export default defineConfig({
  test: {
    include: ['PPC-CAT-EVALUATOR-ABLATION-01/probe/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
    reporter: ['verbose'],
  },
});