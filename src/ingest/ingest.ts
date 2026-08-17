import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../db/types.js';
import { ingestEvents } from './ingestEvents.js';

// Standalone CLI entrypoint, same shape as src/db/migrate.ts -- console.*
// is the right tool here, no pino logger exists outside a running Fastify
// instance.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// docs/assumptions.md D1/CLAUDE.md: the real usage_events.json belongs at
// the repo root when available; the synthetic fixture is the fallback so
// schema/ingestion work isn't blocked while it's absent. USAGE_EVENTS_PATH
// overrides both, mainly for the integration test.
async function resolveInputPath(): Promise<string> {
  const override = process.env.USAGE_EVENTS_PATH;
  if (override) return override;

  const rootFile = path.join(process.cwd(), 'usage_events.json');
  try {
    await fs.access(rootFile);
    return rootFile;
  } catch {
    return path.join(process.cwd(), 'fixtures', 'usage_events.sample.json');
  }
}

async function main(): Promise<void> {
  // Deliberately the same bootstrap superuser credential as
  // MIGRATE_DATABASE_URL, kept as its own named variable rather than reused
  // -- see docs/assumptions.md (ingest connection role entry) and ADR 0005.
  // Both RLS policies are USING-only, so they apply to INSERT; ingestion
  // writes rows for many customers in one run, so it can't run as app_user
  // without re-issuing SET LOCAL per customer group. Connecting as the
  // superuser bypasses RLS unconditionally instead -- the second
  // legitimate non-RLS-scoped path alongside /customers/top (T5).
  const databaseUrl = requireEnv('INGEST_DATABASE_URL');
  const inputPath = await resolveInputPath();

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }),
  });

  try {
    console.log(`ingest: reading ${inputPath}`);
    const raw = JSON.parse(await fs.readFile(inputPath, 'utf8')) as unknown[];

    const startedAt = Date.now();
    const summary = await ingestEvents(raw, db);
    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify({
        msg: 'ingest run complete',
        inputPath,
        durationMs,
        ...summary,
      })
    );
  } catch (err) {
    console.error('ingest run failed');
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main();
