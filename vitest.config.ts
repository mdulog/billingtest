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
    // Same local-only dev credentials as docker-compose.yml/.env.example --
    // not secrets. Unlike the dev/migrate/ingest scripts (deliberately no
    // dotenv, per .env.example), the test suite sets these itself: `npm test`
    // must work on a clean checkout after only `podman compose up -d db`,
    // and several tests here run `delete from usage_events`/`customers` --
    // forcing the target every run, rather than trusting an inherited shell
    // var, is what keeps a stray exported DATABASE_URL from a different
    // project pointed at the wrong database from being destructive here.
    env: {
      DATABASE_URL: 'postgres://app_user:app_user_dev_password@localhost:5432/billingtest',
      ADMIN_DATABASE_URL: 'postgres://app_admin:app_admin_dev_password@localhost:5432/billingtest',
      MIGRATE_DATABASE_URL: 'postgres://postgres:postgres_dev_only@localhost:5432/billingtest',
    },
  },
});
