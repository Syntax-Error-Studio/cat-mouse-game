import { defineConfig } from 'vitest/config';

// Node environment: the rule-kernel / simulator tests are pure TypeScript with
// no DOM dependency. UI component tests (if added later) can use a separate
// project or environment override.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Search benchmarks (D2/D3/D4) can exceed the 5s default in a full suite
    // run due to GC/context pressure; 30s matches the explicit timeouts used
    // by the D3 tests and keeps correctness failures (not just slowness) visible.
    testTimeout: 30000,
    // Keep CI noise low; the AI refactor adds many focused unit tests.
    reporter: ['dot'],
  },
});
