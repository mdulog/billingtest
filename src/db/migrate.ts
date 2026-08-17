import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';

// Standalone CLI entrypoint, not part of the Fastify app -- console.* is the
// right tool here, same as src/server.ts's top-level startup failure handler
// (no pino logger exists outside a running Fastify instance).

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function migrateToLatest(): Promise<void> {
  // Deliberately a separate credential from the API's DATABASE_URL (which
  // points at app_user, a non-superuser). Migrations create roles and
  // policies, which requires the bootstrap superuser -- see ADR 0006.
  const databaseUrl = requireEnv('MIGRATE_DATABASE_URL');

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(process.cwd(), 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((result) => {
    if (result.status === 'Success') {
      console.log(`migration "${result.migrationName}" executed successfully`);
    } else if (result.status === 'Error') {
      console.error(`migration "${result.migrationName}" failed`);
    }
  });

  await db.destroy();

  if (error) {
    console.error('migration run failed');
    console.error(error);
    process.exit(1);
  }
}

migrateToLatest();
