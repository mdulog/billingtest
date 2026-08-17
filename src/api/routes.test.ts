import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { Database } from '../db/types.js';
import { deriveDedupeKey } from '../ingest/dedupeKey.js';
import { registerUsageSummaryRoute } from './usage.js';
import { registerEndpointsRoute } from './endpoints.js';
import { registerTopCustomersRoute } from './top.js';
import { registerErrorHandler } from './errorHandler.js';

// Real Fastify app + real Postgres, exactly like src/db/rls.test.ts -- an
// endpoint test that mocked the DB would prove nothing about RLS actually
// scoping the query, which is the whole point of routing every handler
// through withTenant (db/connection.ts).
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
const adminDb = connect(requireEnv('ADMIN_DATABASE_URL'));
const superuserDb = connect(requireEnv('MIGRATE_DATABASE_URL'));

let app: FastifyInstance;

beforeAll(async () => {
  const migrator = new Migrator({
    db: superuserDb,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(process.cwd(), 'migrations'),
    }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;

  await sql`delete from customer_plans`.execute(superuserDb);
  await sql`delete from usage_events`.execute(superuserDb);
  await sql`delete from customers`.execute(superuserDb);

  await superuserDb
    .insertInto('customers')
    .values([
      { id: 'cust_upgrade', plan: 'enterprise' },
      { id: 'cust_other_tenant', plan: 'growth' },
    ])
    .execute();

  // The worked example from docs/plan.md Phase 4, used early here to prove
  // the join + RLS scoping through the actual HTTP path: 100 pro events,
  // an upgrade, then 200 enterprise events, all inside one month. A
  // month-wide summary must return two rows (100/pro, 200/enterprise), not
  // 300 lumped under enterprise.
  await sql`
    insert into customer_plans (customer_id, plan, valid_period)
    values
      ('cust_upgrade', 'pro', tstzrange('2026-07-01', '2026-07-15', '[)')),
      ('cust_upgrade', 'enterprise', tstzrange('2026-07-15', null, '[)'))
  `.execute(superuserDb);

  const proEvents = Array.from({ length: 100 }, (_, i) => ({
    customer_id: 'cust_upgrade',
    event_type: 'api_call',
    endpoint: '/v1/reports/generate',
    user_email: 'jane@acmeco.com',
    duration_ms: 100,
    status: 'success',
    occurred_at: new Date(Date.UTC(2026, 6, 10, 0, 0, i)),
    metadata: JSON.stringify({}),
    dedupe_key: `pro-${i}`,
  }));
  const enterpriseEvents = Array.from({ length: 200 }, (_, i) => ({
    customer_id: 'cust_upgrade',
    event_type: 'api_call',
    endpoint: '/v1/usage/query',
    user_email: 'jane@acmeco.com',
    duration_ms: 50,
    status: 'success',
    occurred_at: new Date(Date.UTC(2026, 6, 20, 0, 0, i)),
    metadata: JSON.stringify({}),
    dedupe_key: `ent-${i}`,
  }));
  await superuserDb.insertInto('usage_events').values([...proEvents, ...enterpriseEvents]).execute();

  await superuserDb
    .insertInto('usage_events')
    .values({
      customer_id: 'cust_other_tenant',
      event_type: 'api_call',
      endpoint: '/v1/reports/generate',
      user_email: 'sam@northwind.io',
      duration_ms: 214,
      status: 'success',
      occurred_at: new Date('2026-07-14T18:32:11Z'),
      metadata: JSON.stringify({}),
      dedupe_key: deriveDedupeKey({
        eventType: 'api_call',
        endpoint: '/v1/reports/generate',
        userEmail: 'sam@northwind.io',
        occurredAt: new Date('2026-07-14T18:32:11Z'),
      }),
    })
    .execute();

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerUsageSummaryRoute(app, appDb);
  registerEndpointsRoute(app, appDb);
  registerTopCustomersRoute(app, adminDb);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await appDb.destroy();
  await adminDb.destroy();
  await superuserDb.destroy();
});

describe('GET /customers/:customerId/usage', () => {
  test('splits a mid-month upgrade into two plan buckets, not one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/cust_upgrade/usage?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.byPlan).toEqual(
      expect.arrayContaining([
        { plan: 'enterprise', eventCount: 200, totalDurationMs: 10000 },
        { plan: 'pro', eventCount: 100, totalDurationMs: 10000 },
      ])
    );
    expect(body.byPlan).toHaveLength(2);
  });

  test('never returns another tenant\'s rows, proving RLS scoping through the HTTP path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/cust_upgrade/usage?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z',
    });

    const body = response.json();
    const totalEvents = body.byPlan.reduce((sum: number, row: { eventCount: number }) => sum + row.eventCount, 0);
    expect(totalEvents).toBe(300);
  });

  test('rejects from >= to with 400, not a query against an empty/inverted range', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/cust_upgrade/usage?from=2026-08-01T00:00:00Z&to=2026-07-01T00:00:00Z',
    });

    expect(response.statusCode).toBe(400);
  });

  test('rejects a malformed date with 400 from schema validation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/cust_upgrade/usage?from=not-a-date&to=2026-08-01T00:00:00Z',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /customers/:customerId/endpoints', () => {
  test('breaks usage down per endpoint for one customer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/cust_upgrade/endpoints?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.endpoints).toEqual(
      expect.arrayContaining([
        { endpoint: '/v1/usage/query', eventCount: 200, totalDurationMs: 10000 },
        { endpoint: '/v1/reports/generate', eventCount: 100, totalDurationMs: 10000 },
      ])
    );
  });
});

describe('GET /customers/top', () => {
  test('ranks across tenants using the admin (BYPASSRLS) connection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/top?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&limit=10',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.customers[0]).toEqual({
      customerId: 'cust_upgrade',
      plan: 'enterprise',
      eventCount: 300,
      totalDurationMs: 20000,
    });
    expect(body.customers.map((c: { customerId: string }) => c.customerId)).toContain('cust_other_tenant');
  });

  test('caps limit at the schema maximum with a 400, not a truncated result', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/customers/top?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&limit=1000',
    });

    expect(response.statusCode).toBe(400);
  });
});
