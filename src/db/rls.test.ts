import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { Database } from './types.js';
import { deriveDedupeKey } from '../ingest/dedupeKey.js';
import { withTenant } from './connection.js';

// Two connections, deliberately: app_user is the role the API actually runs
// as (subject to RLS), superuser is the migration/bootstrap role (bypasses
// RLS unconditionally). The isolation proof in this file only means anything
// if both are exercised -- see the third case in "cross-tenant" below.
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

const appDb = connect(requireEnv('DATABASE_URL'));
const superuserDb = connect(requireEnv('MIGRATE_DATABASE_URL'));

beforeAll(async () => {
  const migrator = new Migrator({
    db: superuserDb,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(process.cwd(), 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();
  results?.forEach((result) => {
    if (result.status === 'Error') {
      console.error(`migration "${result.migrationName}" failed`);
    }
  });
  if (error) throw error;

  // Fixture data: two tenants, one event each, inserted as the superuser so
  // this setup doesn't depend on RLS already working correctly.
  await sql`delete from usage_events`.execute(superuserDb);
  await sql`delete from customers`.execute(superuserDb);
  await superuserDb
    .insertInto('customers')
    .values([
      { id: 'cust_a', plan: 'pro' },
      { id: 'cust_b', plan: 'growth' },
    ])
    .execute();
  await superuserDb
    .insertInto('usage_events')
    .values([
      {
        customer_id: 'cust_a',
        event_type: 'api_call',
        endpoint: '/v1/reports/generate',
        user_email: 'jane@acmeco.com',
        duration_ms: 214,
        status: 'success',
        occurred_at: new Date('2026-07-14T18:32:11Z'),
        // Kysely's JSONColumnType defaults the insert/update type to
        // `string` (see kysely/dist/util/column-type.d.ts) -- pg's driver
        // would JSON.stringify a plain object for us either way, but
        // stringifying explicitly keeps the declared type honest.
        metadata: JSON.stringify({ duration_ms: 214, status: 'success' }),
        dedupe_key: deriveDedupeKey({
          eventType: 'api_call',
          endpoint: '/v1/reports/generate',
          userEmail: 'jane@acmeco.com',
          occurredAt: new Date('2026-07-14T18:32:11Z'),
        }),
      },
      {
        customer_id: 'cust_b',
        event_type: 'api_call',
        endpoint: '/v1/reports/generate',
        user_email: 'sam@northwind.io',
        duration_ms: 90,
        status: 'success',
        occurred_at: new Date('2026-07-14T18:33:00Z'),
        metadata: JSON.stringify({ duration_ms: 90, status: 'success' }),
        dedupe_key: deriveDedupeKey({
          eventType: 'api_call',
          endpoint: '/v1/reports/generate',
          userEmail: 'sam@northwind.io',
          occurredAt: new Date('2026-07-14T18:33:00Z'),
        }),
      },
    ])
    .execute();
});

afterAll(async () => {
  await appDb.destroy();
  await superuserDb.destroy();
});

describe('tenant isolation on usage_events', () => {
  test('app_user with tenant context set sees only that tenant, with no customer_id predicate', async () => {
    const rows = await appDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.current_customer', ${'cust_a'}, true)`.execute(trx);
      return trx.selectFrom('usage_events').selectAll().execute();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.customer_id).toBe('cust_a');
  });

  test('app_user with no tenant context set sees nothing (fail-closed)', async () => {
    const rows = await appDb.transaction().execute(async (trx) => {
      return trx.selectFrom('usage_events').selectAll().execute();
    });

    expect(rows).toHaveLength(0);
  });

  test('superuser connection sees both tenants regardless of RLS -- proves the isolation test above would catch a role misconfiguration', async () => {
    const rows = await superuserDb.selectFrom('usage_events').selectAll().execute();

    const customerIds = rows.map((row) => row.customer_id).sort();
    expect(customerIds).toEqual(['cust_a', 'cust_b']);
  });

  // The two tests above prove RLS filters correctly, but each ran in its
  // own transaction and pg's pool (default size 10) doesn't guarantee they
  // shared a physical connection -- so neither one actually distinguishes
  // "SET LOCAL is scoped to its transaction" from "the fail-closed test
  // just happened to land on a fresh connection." ADR 0001's whole claim is
  // about connection reuse, so the proof needs a pool that forces it.
  test('SET LOCAL app.current_customer does not leak to the next transaction on a reused pooled connection', async () => {
    const singleConnDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 1 }),
      }),
    });

    try {
      // Through the real production path (withTenant), not a hand-rolled
      // set_config -- this has to prove the code that ships, not a stand-in.
      const scopedRows = await withTenant(singleConnDb, 'cust_a', (trx) =>
        trx.selectFrom('usage_events').selectAll().execute()
      );
      expect(scopedRows).toHaveLength(1);
      expect(scopedRows[0]?.customer_id).toBe('cust_a');

      // Same pool, max: 1 -- this transaction can only run on the physical
      // connection the tenant-scoped one above just released. If SET LOCAL
      // had leaked (i.e. a plain SET had been used instead), this would
      // still see cust_a's row.
      const unscopedRows = await singleConnDb
        .transaction()
        .execute((trx) => trx.selectFrom('usage_events').selectAll().execute());
      expect(unscopedRows).toHaveLength(0);
    } finally {
      await singleConnDb.destroy();
    }
  });
});

describe('tenant isolation on customers', () => {
  test('app_user with tenant context set cannot enumerate other tenants', async () => {
    const rows = await appDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.current_customer', ${'cust_a'}, true)`.execute(trx);
      return trx.selectFrom('customers').selectAll().execute();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('cust_a');
  });
});

describe('customer_plans exclusion constraint', () => {
  test('rejects overlapping valid_period rows for the same customer', async () => {
    await sql`delete from customer_plans`.execute(superuserDb);

    await sql`
      insert into customer_plans (customer_id, plan, valid_period)
      values ('cust_a', 'pro', tstzrange('2026-01-01', '2026-06-01', '[)'))
    `.execute(superuserDb);

    await expect(
      sql`
        insert into customer_plans (customer_id, plan, valid_period)
        values ('cust_a', 'enterprise', tstzrange('2026-03-01', '2026-09-01', '[)'))
      `.execute(superuserDb)
    ).rejects.toThrow(/exclusion/i);
  });

  test('app_user with tenant context set cannot see another tenant\'s plan history', async () => {
    await sql`delete from customer_plans`.execute(superuserDb);
    await sql`
      insert into customer_plans (customer_id, plan, valid_period)
      values
        ('cust_a', 'pro', tstzrange('2026-01-01', '2026-06-01', '[)')),
        ('cust_b', 'growth', tstzrange('2026-01-01', null, '[)'))
    `.execute(superuserDb);

    const rows = await appDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.current_customer', ${'cust_a'}, true)`.execute(trx);
      return trx.selectFrom('customer_plans').selectAll().execute();
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.customer_id).toBe('cust_a');
  });
});
