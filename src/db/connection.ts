import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './types.js';

// Structural subset of Fastify's pino-backed logger. Keeping this interface
// (rather than importing Fastify's type) is what lets src/db stay free of
// an HTTP-layer dependency while still logging at the required severity
// with named holes instead of string interpolation.
export interface PoolLogger {
  fatal(fields: Record<string, unknown>, message: string): void;
}

// One pool per process. Tenant scoping (SET LOCAL app.current_customer,
// per the RLS policy in migration 001) is applied per-request in Phase 3 --
// it has to run inside the same transaction as the query it scopes, so it
// belongs at the call site, not here.
export function createDb(databaseUrl: string, logger: PoolLogger): Kysely<Database> {
  const pool = new Pool({ connectionString: databaseUrl });

  pool.on('error', (err) => {
    // A pooled client can emit 'error' outside any query (e.g. connection
    // dropped while idle). Uncaught, this crashes the process, so it must
    // be handled -- and a background connection failure is not routine,
    // hence fatal rather than error.
    logger.fatal({ err }, 'Postgres pool emitted an error on an idle connection');
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export async function closeDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}
