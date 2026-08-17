import { Kysely, sql } from 'kysely';

// ADR 0001 flagged this as an open gap: `/customers/top` is deliberately
// cross-tenant (T5) and therefore cannot be served through app_user's
// RLS-scoped connection at all -- with FORCE ROW LEVEL SECURITY and no
// session var set, app_user gets zero rows, not all tenants' rows. See
// ADR 0007 for the role-vs-reusing-the-bootstrap-superuser tradeoff.
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
  // BYPASSRLS, not a second app_user-shaped role with a customers-only
  // policy exception -- the point of this role is that it's the one place
  // in the system allowed to see every tenant at once, so it should say so
  // directly rather than via a policy carve-out. NOSUPERUSER: it must not
  // gain CREATE ROLE/CREATE POLICY/DDL rights just to read across tenants.
  const appAdminPassword = requireEnv('APP_ADMIN_PASSWORD');
  await sql
    .raw(
      `
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_admin') THEN
            CREATE ROLE app_admin WITH LOGIN PASSWORD ${pgQuoteLiteral(appAdminPassword)} NOSUPERUSER BYPASSRLS;
          END IF;
        END
        $$;
      `
    )
    .execute(db);

  await sql`GRANT CONNECT ON DATABASE billingtest TO app_admin`.execute(db);
  await sql`GRANT USAGE ON SCHEMA public TO app_admin`.execute(db);
  // Read-only, and only the tables /customers/top actually queries --
  // this role never writes, so no INSERT/UPDATE grant, unlike app_user's.
  await sql`GRANT SELECT ON customers TO app_admin`.execute(db);
  await sql`GRANT SELECT ON usage_events TO app_admin`.execute(db);
  await sql`GRANT SELECT ON customer_plans TO app_admin`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Table grants must go before DROP ROLE -- the tables themselves aren't
  // dropped by this migration's down(), so they don't take the grants with
  // them the way 001's down() (which drops the tables) gets for free.
  await sql`REVOKE ALL PRIVILEGES ON customers FROM app_admin`.execute(db);
  await sql`REVOKE ALL PRIVILEGES ON usage_events FROM app_admin`.execute(db);
  await sql`REVOKE ALL PRIVILEGES ON customer_plans FROM app_admin`.execute(db);
  await sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM app_admin`.execute(db);
  await sql`REVOKE ALL PRIVILEGES ON DATABASE billingtest FROM app_admin`.execute(db);
  await sql`DROP ROLE IF EXISTS app_admin`.execute(db);
}
