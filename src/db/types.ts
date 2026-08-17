import type { ColumnType, Generated, JSONColumnType } from 'kysely';

// Filled in table-by-table as each migration lands (see migrations/), not
// generated speculatively ahead of the schema that defines it.
export interface Database {
  customers: CustomersTable;
  usage_events: UsageEventsTable;
  customer_plans: CustomerPlansTable;
}

export interface CustomersTable {
  // Natural key -- docs/assumptions.md D7 treats customer_id as a stable,
  // opaque, already-unique string from the source data.
  id: string;
  // Denormalized cache of the *current* plan (ADR 0002). Nullable: no plan
  // has necessarily been observed yet for a customer row created ahead of
  // its first event.
  plan: string | null;
}

export interface UsageEventsTable {
  // node-pg returns bigint/int8 (bigserial's underlying type) as a string by
  // default, since it doesn't fit safely in a JS number.
  id: Generated<string>;
  customer_id: string;
  event_type: string;
  endpoint: string;
  user_email: string;
  // Nullable: some event types legitimately carry no duration_ms (D6/I8).
  duration_ms: number | null;
  status: string | null;
  // pg parses timestamptz into a JS Date on select; either a Date or an
  // ISO string is accepted on insert/update.
  occurred_at: ColumnType<Date, Date | string, Date | string>;
  metadata: JSONColumnType<Record<string, unknown>>;
}

export interface CustomerPlansTable {
  id: Generated<string>;
  customer_id: string;
  plan: string;
  // tstzrange has no native pg-node type mapping without a custom type
  // parser -- represented here as its Postgres range-literal text
  // (e.g. '["2026-01-01 00:00:00+00","2026-06-01 00:00:00+00")'). Queries
  // that construct one should use `tstzrange(...)` in SQL rather than
  // building the literal by hand in application code.
  valid_period: string;
}
