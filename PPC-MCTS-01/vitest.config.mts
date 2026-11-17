import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['PPC-MCTS-01/tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporter: ['dot'],
  },
});
