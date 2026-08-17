import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests hit a real Postgres (per docs/plan.md P4) and run
    // sequentially against one database -- parallel test files racing on
    // the same connection/schema would produce flaky, order-dependent
    // failures rather than real signal.
    fileParallelism: false,
  },
});
