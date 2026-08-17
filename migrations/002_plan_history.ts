import { Kysely, sql } from 'kysely';

// See ADR 0002. customers.plan alone can only answer "what plan right now" --
// billing queries need "what plan when this event occurred", and B3's
// asymmetry (upgrades immediate, downgrades/cancellations wait for period
// end) means those two questions have different answers mid-period.
export async function up(db: Kysely<any>): Promise<void> {
  // Required for the EXCLUDE constraint below: combining a scalar equality
  // check (customer_id) with a range-overlap check (valid_period) needs
  // btree_gist to let a btree-comparable column participate in a GiST index.
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);

  await db.schema
    .createTable('customer_plans')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('customer_id', 'text', (col) =>
      col.notNull().references('customers.id').onDelete('cascade')
    )
    .addColumn('plan', 'text', (col) => col.notNull())
    .addColumn('valid_period', sql`tstzrange`, (col) => col.notNull())
    .execute();

  // Makes overlapping plan periods for one customer unrepresentable at the
  // database level -- not an ingestion-time promise, a constraint violation.
  await sql`
    ALTER TABLE customer_plans
    ADD CONSTRAINT customer_plans_no_overlap
    EXCLUDE USING gist (customer_id WITH =, valid_period WITH &&)
  `.execute(db);

  // Same tenant-isolation treatment as migration 001's tables -- customer_plans
  // is exactly as tenant-scoped as usage_events and customers.
  await sql`ALTER TABLE customer_plans ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE customer_plans FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`
    CREATE POLICY tenant_isolation ON customer_plans
    USING (customer_id = current_setting('app.current_customer', true))
  `.execute(db);

  await sql`GRANT SELECT, INSERT, UPDATE ON customer_plans TO app_user`.execute(db);
  await sql`GRANT USAGE ON SEQUENCE customer_plans_id_seq TO app_user`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS customer_plans`.execute(db);
}
