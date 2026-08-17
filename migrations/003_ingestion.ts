import { Kysely, sql } from 'kysely';

// See ADR 0005 (now fully resolved) and docs/assumptions.md I1-I3. The
// dedupe key is derived from normalized identifying fields, excluding
// metadata -- so a redelivery that only corrects duration_ms/status hits the
// same key and is treated as a correction (ON CONFLICT ... DO UPDATE in the
// ingest script), not a second billable event.
export async function up(db: Kysely<any>): Promise<void> {
  // Added nullable first, not NOT NULL in one step -- this migration can
  // run against a usage_events that already has rows (any deployment past
  // migration 001/002 before this one lands), and `ADD COLUMN ... NOT
  // NULL` with no DEFAULT fails outright in that case ("column contains
  // null values"). Standard three-step: nullable -> backfill -> SET NOT
  // NULL.
  await db.schema.alterTable('usage_events').addColumn('dedupe_key', 'text').execute();

  // Backfills existing rows using the exact same formula as
  // src/ingest/dedupeKey.ts (event_type, endpoint, user_email,
  // occurred_at -- metadata excluded, per ADR 0005 I2), so a future
  // redelivery of a pre-existing event still lands on the same key and
  // hits ON CONFLICT DO UPDATE rather than inserting a duplicate. Postgres
  // 17 has `sha256(bytea)` in core (verified -- no pgcrypto needed).
  // `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` reproduces JS
  // `Date.prototype.toISOString()` byte-for-byte (verified against the
  // application's own output for the same timestamp), which is the other
  // half of what has to match for this to be safe.
  await sql`
    UPDATE usage_events
    SET dedupe_key = encode(
      sha256(
        (
          event_type || ' ' || endpoint || ' ' || user_email || ' ' ||
          to_char(timezone('UTC', occurred_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )::bytea
      ),
      'hex'
    )
    WHERE dedupe_key IS NULL
  `.execute(db);

  await db.schema.alterTable('usage_events').alterColumn('dedupe_key', (col) => col.setNotNull()).execute();

  // Only after backfill+NOT NULL: a UNIQUE constraint added earlier would
  // fail outright on the NULLs this migration is in the middle of filling.
  await sql`
    ALTER TABLE usage_events
    ADD CONSTRAINT usage_events_customer_dedupe_key_key
    UNIQUE (customer_id, dedupe_key)
  `.execute(db);

  // Quarantine for records that fail normalization (docs/assumptions.md I5).
  // Deliberately NOT RLS-scoped like customers/usage_events/customer_plans:
  // I6 rejects any event with a missing/malformed customer_id, so reject
  // rows routinely have a NULL or garbage customer_id -- a tenant policy of
  // `customer_id = current_setting(...)` would make exactly those rows
  // unwritable and unreadable, the opposite of what a quarantine table is
  // for. This table is also never queried by the API (app_user gets no
  // grant on it below), so access control here is privilege-based -- deny
  // by omission -- rather than a policy that can't cleanly express a NULL
  // tenant. Only the ingest/migrate superuser role can read or write it.
  await db.schema
    .createTable('ingest_rejects')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('customer_id', 'text')
    .addColumn('reason', 'text', (col) => col.notNull())
    // Full original record, losslessly -- same rationale as S6 for
    // metadata: discarding it at rejection time is irreversible and this
    // is exactly the data you'd want on hand to debug an upstream schema
    // change (see plan.md's reject-rate-shift alarm).
    .addColumn('raw_event', 'jsonb', (col) => col.notNull())
    .addColumn('rejected_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('ingest_rejects_reason_idx')
    .on('ingest_rejects')
    .column('reason')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ingest_rejects').execute();
  await sql`ALTER TABLE usage_events DROP CONSTRAINT usage_events_customer_dedupe_key_key`.execute(
    db
  );
  await db.schema.alterTable('usage_events').dropColumn('dedupe_key').execute();
}
