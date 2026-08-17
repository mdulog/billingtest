import { Kysely, sql } from 'kysely';

// CREATE ROLE ... PASSWORD does not accept a bind parameter -- Postgres's
// grammar requires a string literal in that position, not an expression.
// The password itself is a trusted, operator-supplied env value (never user
// input), but it's still interpolated as SQL text, so it's quoted the same
// way a hostile string would need to be: escape embedded quotes rather than
// concatenate raw.
function pgQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function up(db: Kysely<any>): Promise<void> {
  // app_user is the role the API connects as at runtime -- deliberately not
  // the superuser/table-owner running this migration. See ADR 0006: a
  // superuser or table owner bypasses RLS unconditionally, which would make
  // every tenant-isolation policy below silently decorative. Guarded with
  // IF NOT EXISTS because CREATE ROLE is cluster-scoped, not database-scoped
  // -- re-running migrations against a second database in the same cluster
  // (e.g. a test database) would otherwise fail with "role already exists".
  const appUserPassword = requireEnv('APP_USER_PASSWORD');
  await sql
    .raw(
      `
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
            CREATE ROLE app_user WITH LOGIN PASSWORD ${pgQuoteLiteral(appUserPassword)} NOSUPERUSER NOBYPASSRLS;
          END IF;
        END
        $$;
      `
    )
    .execute(db);

  await db.schema
    .createTable('customers')
    .addColumn('id', 'text', (col) => col.primaryKey())
    // Denormalized cache of the *current* plan (ADR 0002) -- nullable
    // because "no plan yet observed" is a real state before first ingest,
    // not an error.
    .addColumn('plan', 'text')
    .execute();

  await db.schema
    .createTable('usage_events')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('customer_id', 'text', (col) =>
      col.notNull().references('customers.id').onDelete('cascade')
    )
    .addColumn('event_type', 'text', (col) => col.notNull())
    // Normalized at ingest time (lowercased, trimmed, trailing slash
    // stripped) -- see docs/assumptions.md S7.
    .addColumn('endpoint', 'text', (col) => col.notNull())
    // Normalized at ingest time (lower + trim) -- docs/assumptions.md S9.
    .addColumn('user_email', 'text', (col) => col.notNull())
    // Nullable: some event types (e.g. login) legitimately carry no
    // duration_ms. Absence is not the same as malformed -- see
    // docs/assumptions.md D6/I8.
    .addColumn('duration_ms', 'integer')
    .addColumn('status', 'text')
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
    // Full metadata retained losslessly even after hot fields are promoted
    // to columns -- docs/assumptions.md S6.
    .addColumn('metadata', 'jsonb', (col) => col.notNull())
    .execute();

  // Supports the date-range-scoped queries every endpoint runs, and doubles
  // as the index RLS-scoped scans hit first (customer_id is always in the
  // policy's USING clause).
  await db.schema
    .createIndex('usage_events_customer_occurred_at_idx')
    .on('usage_events')
    .columns(['customer_id', 'occurred_at'])
    .execute();

  // Supports GET /customers/:id/endpoints -- filtering/grouping by endpoint
  // within one customer's data.
  await db.schema
    .createIndex('usage_events_customer_endpoint_idx')
    .on('usage_events')
    .columns(['customer_id', 'endpoint'])
    .execute();

  // Both tables are tenant-scoped and get RLS -- not just usage_events.
  // Without a policy on customers, app_user could SELECT * FROM customers
  // and enumerate every tenant ID and plan regardless of session context,
  // which is exactly the "at the database level" leak ADR 0001 exists to
  // prevent. FORCE matters here because the table owner (this migration's
  // role) would otherwise bypass the policy too.
  for (const table of ['customers', 'usage_events']) {
    await sql`ALTER TABLE ${sql.raw(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${sql.raw(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  }

  await sql`
    CREATE POLICY tenant_isolation ON customers
    USING (id = current_setting('app.current_customer', true))
  `.execute(db);

  await sql`
    CREATE POLICY tenant_isolation ON usage_events
    USING (customer_id = current_setting('app.current_customer', true))
  `.execute(db);

  // Explicit rather than relying on PUBLIC's default grants (A05: don't
  // depend on implicit permissions holding across Postgres versions).
  await sql`GRANT CONNECT ON DATABASE billingtest TO app_user`.execute(db);
  await sql`GRANT USAGE ON SCHEMA public TO app_user`.execute(db);
  // UPDATE is needed, not just SELECT/INSERT: ingestion maintains
  // customers.plan as a denormalized cache (ADR 0002), and plan-history
  // derivation closes a customer_plans interval by updating its
  // valid_period upper bound.
  await sql`GRANT SELECT, INSERT, UPDATE ON customers TO app_user`.execute(db);
  await sql`GRANT SELECT, INSERT, UPDATE ON usage_events TO app_user`.execute(db);
  await sql`GRANT USAGE ON SEQUENCE usage_events_id_seq TO app_user`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS usage_events`.execute(db);
  await sql`DROP TABLE IF EXISTS customers`.execute(db);
  // Table-level grants disappear with the tables; schema/database-level
  // ones don't, and DROP ROLE fails while any privilege remains granted.
  await sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM app_user`.execute(db);
  await sql`REVOKE ALL PRIVILEGES ON DATABASE billingtest FROM app_user`.execute(db);
  await sql`DROP ROLE IF EXISTS app_user`.execute(db);
}
