import { Kysely, PostgresDialect, sql } from 'kysely';
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

// Every RLS-scoped route (everything except /customers/top, which uses the
// separate app_admin connection -- ADR 0007) goes through this. `set_config`
// with `is_local = true` is the parameterized equivalent of `SET LOCAL
// app.current_customer = $1` -- plain `SET LOCAL app.current_customer =
// ${customerId}` isn't valid Postgres grammar (SET doesn't take a bind
// parameter in that position), and building the statement by string-
// concatenating a URL path parameter would turn the one place this
// service's entire tenant-isolation story lives into a SQL injection
// vector (A03). Scoped to one transaction so it can never leak to another
// request on a pooled connection (ADR 0001).
export async function withTenant<T>(
  db: Kysely<Database>,
  customerId: string,
  fn: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.current_customer', ${customerId}, true)`.execute(trx);
    return fn(trx);
  });
}
