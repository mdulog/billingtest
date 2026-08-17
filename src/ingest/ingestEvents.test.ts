import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { beforeAll, afterEach, afterAll, describe, expect, test } from 'vitest';
import type { Database } from '../db/types.js';
import { ingestEvents } from './ingestEvents.js';

// Runs against the same bootstrap superuser role migrate.ts uses -- per
// ADR 0005 / docs/assumptions.md, this is the connection ingestEvents()
// is designed to run under (RLS is USING-only, so app_user would need
// per-customer SET LOCAL to write at all; the superuser path bypasses RLS
// unconditionally instead, alongside /customers/top).
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function connect(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }),
  });
}

const db = connect(requireEnv('MIGRATE_DATABASE_URL'));

const TEST_CUSTOMERS = ['cust_ingest_1', 'cust_ingest_2'];

async function cleanTestCustomers(): Promise<void> {
  await sql`delete from ingest_rejects where customer_id = any(${TEST_CUSTOMERS})`.execute(db);
  await sql`delete from usage_events where customer_id = any(${TEST_CUSTOMERS})`.execute(db);
  await sql`delete from customer_plans where customer_id = any(${TEST_CUSTOMERS})`.execute(db);
  await sql`delete from customers where id = any(${TEST_CUSTOMERS})`.execute(db);
}

beforeAll(async () => {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(process.cwd(), 'migrations'),
    }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;

  await cleanTestCustomers();
});

afterEach(cleanTestCustomers);

afterAll(async () => {
  await db.destroy();
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_id: 'cust_ingest_1',
    event_type: 'api_call',
    endpoint: '/v1/reports/generate',
    user_email: 'jane@acmeco.com',
    plan: 'pro',
    occurred_at: '2026-07-14T18:32:11Z',
    metadata: { duration_ms: 214, status: 'success' },
    ...overrides,
  };
}

describe('ingestEvents', () => {
  test('inserts a customer and event from a well-formed record', async () => {
    const summary = await ingestEvents([record()], db);

    expect(summary).toMatchObject({
      recordsRead: 1,
      validRecords: 1,
      rejectedRecords: 0,
      eventsUpserted: 1,
      customersUpserted: 1,
    });

    const events = await db
      .selectFrom('usage_events')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ duration_ms: 214, status: 'success' });

    const customer = await db
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', 'cust_ingest_1')
      .executeTakeFirst();
    expect(customer?.plan).toBe('pro');
  });

  test('a malformed record is quarantined to ingest_rejects with its reason and the customer_id preserved', async () => {
    const { event_type, ...withoutEventType } = record();
    const summary = await ingestEvents([withoutEventType], db);

    expect(summary).toMatchObject({
      rejectedRecords: 1,
      rejectsByReason: { missing_event_type: 1 },
      eventsUpserted: 0,
    });

    const rejects = await db
      .selectFrom('ingest_rejects')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toBe('missing_event_type');
  });

  test('two records that only differ in metadata collapse to one row, within a single run (ADR 0005 I2)', async () => {
    const first = record({ metadata: { duration_ms: 214, status: 'success' } });
    const second = record({ metadata: { duration_ms: 260, status: 'success' } });

    const summary = await ingestEvents([first, second], db);

    expect(summary).toMatchObject({
      recordsRead: 2,
      validRecords: 2,
      dedupedWithinRun: 1,
      eventsUpserted: 1,
    });

    const events = await db
      .selectFrom('usage_events')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.duration_ms).toBe(260);
  });

  test('re-running with a corrected duration_ms updates the existing row instead of inserting a second one', async () => {
    await ingestEvents([record({ metadata: { duration_ms: 214, status: 'success' } })], db);
    const summary = await ingestEvents([record({ metadata: { duration_ms: 999, status: 'success' } })], db);

    expect(summary.eventsUpserted).toBe(1);

    const events = await db
      .selectFrom('usage_events')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.duration_ms).toBe(999);
  });

  test('re-running the exact same input twice is idempotent', async () => {
    const input = [record()];
    await ingestEvents(input, db);
    await ingestEvents(input, db);

    const events = await db
      .selectFrom('usage_events')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(events).toHaveLength(1);
  });

  test('a mid-period upgrade produces two customer_plans intervals and customers.plan reflects the latest', async () => {
    const events = [
      record({ plan: 'pro', occurred_at: '2026-06-01T00:00:00Z' }),
      record({ plan: 'enterprise', occurred_at: '2026-06-15T00:00:00Z' }),
    ];

    const summary = await ingestEvents(events, db);
    expect(summary.rejectedPlanTransitions).toBe(0);

    const intervals = await sql<{ plan: string; valid_period: string }>`
      select plan, valid_period::text from customer_plans
      where customer_id = 'cust_ingest_1' order by valid_period
    `.execute(db);
    expect(intervals.rows).toHaveLength(2);
    expect(intervals.rows[0]?.plan).toBe('pro');
    expect(intervals.rows[1]?.plan).toBe('enterprise');

    const customer = await db
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', 'cust_ingest_1')
      .executeTakeFirst();
    expect(customer?.plan).toBe('enterprise');
  });

  test('a mid-period downgrade is rejected as dirty data -- one interval, plan unchanged (B2/S3)', async () => {
    const events = [
      record({ plan: 'enterprise', occurred_at: '2026-06-01T00:00:00Z' }),
      record({ plan: 'pro', occurred_at: '2026-06-15T00:00:00Z' }),
    ];

    const summary = await ingestEvents(events, db);
    expect(summary.rejectedPlanTransitions).toBe(1);

    const intervals = await db
      .selectFrom('customer_plans')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.plan).toBe('enterprise');
  });

  test('re-deriving plan history on rerun replaces stale intervals rather than conflicting with them', async () => {
    await ingestEvents([record({ plan: 'pro', occurred_at: '2026-06-01T00:00:00Z' })], db);
    await ingestEvents(
      [
        record({ plan: 'pro', occurred_at: '2026-06-01T00:00:00Z' }),
        record({ plan: 'enterprise', occurred_at: '2026-06-15T00:00:00Z' }),
      ],
      db
    );

    const intervals = await db
      .selectFrom('customer_plans')
      .selectAll()
      .where('customer_id', '=', 'cust_ingest_1')
      .execute();
    expect(intervals).toHaveLength(2);
  });

  test('a redelivery of a row whose dedupe_key was computed by migration 003\'s SQL backfill formula updates it, not duplicates it', async () => {
    // Simulates a row that existed before migration 003 landed and got its
    // dedupe_key backfilled by SQL (not by deriveDedupeKey() at insert
    // time) -- the exact scenario that surfaced a real bug during
    // development: deriveDedupeKey()'s field separator silently became a
    // NUL byte instead of a space, so its output diverged from the SQL
    // formula for identical fields, and a redelivery inserted a duplicate
    // row instead of updating the pre-existing one. This test pins the two
    // formulas' agreement going forward using migration 003's actual SQL
    // expression, not a reimplementation of it.
    await db.insertInto('customers').values({ id: 'cust_ingest_1', plan: 'pro' }).execute();

    await sql`
      insert into usage_events
        (customer_id, event_type, endpoint, user_email, duration_ms, status, occurred_at, metadata, dedupe_key)
      values (
        'cust_ingest_1', 'api_call', '/v1/legacy/pre-existing', 'legacy@acmeco.com', 100, 'success',
        '2026-05-01T00:00:00Z', '{}',
        encode(
          sha256(
            (
              'api_call' || ' ' || '/v1/legacy/pre-existing' || ' ' || 'legacy@acmeco.com' || ' ' ||
              to_char(timezone('UTC', '2026-05-01T00:00:00Z'::timestamptz), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )::bytea
          ),
          'hex'
        )
      )
    `.execute(db);

    const summary = await ingestEvents(
      [
        record({
          endpoint: '/v1/legacy/pre-existing',
          user_email: 'legacy@acmeco.com',
          occurred_at: '2026-05-01T00:00:00Z',
          metadata: { duration_ms: 777, status: 'success' },
        }),
      ],
      db
    );

    expect(summary.eventsUpserted).toBe(1);

    const rows = await db
      .selectFrom('usage_events')
      .selectAll()
      .where('endpoint', '=', '/v1/legacy/pre-existing')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.duration_ms).toBe(777);
  });

  test('events across two customers in one run are each attributed correctly', async () => {
    const summary = await ingestEvents(
      [record({ customer_id: 'cust_ingest_1' }), record({ customer_id: 'cust_ingest_2', plan: 'free' })],
      db
    );

    expect(summary.customersUpserted).toBe(2);

    const customers = await db
      .selectFrom('customers')
      .selectAll()
      .where('id', 'in', TEST_CUSTOMERS)
      .execute();
    expect(customers.map((c) => c.plan).sort()).toEqual(['free', 'pro']);
  });
});
