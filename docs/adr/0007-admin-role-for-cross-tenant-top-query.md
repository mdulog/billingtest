# 7. Dedicated BYPASSRLS role for the cross-tenant top-customers query

**Status:** Accepted
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` T5 · ADR 0001, ADR 0006 · `docs/plan.md` Phase 3

## Context and Problem Statement

ADR 0001 forced `customers`, `usage_events`, and `customer_plans` to
`FORCE ROW LEVEL SECURITY` with a policy on `current_setting('app.current_customer')`.
`GET /customers/top` is deliberately cross-tenant (T5) — it ranks usage
across every customer, not one. With `FORCE` in effect, `app_user` cannot
serve this at all: with no session var set, `current_setting(..., true)`
is `NULL`, and `customer_id = NULL` is never true, so the query returns
zero rows rather than every tenant's rows. This isn't a bug to route
around — it's the fail-closed behavior ADR 0001 exists to guarantee — but
it means this one query needs a different connection path, not a
workaround on the existing one.

## Decision Drivers

- The same silent-failure concern ADR 0006 raised about the API's main
  connection applies here in reverse: whatever serves `/customers/top`
  must be able to see all tenants *on purpose*, not by accident of a
  broader grant.
- Least privilege still applies — this role exists to answer one
  cross-tenant read, not to become a second superuser.
- Reusing the bootstrap superuser credential (`MIGRATE_DATABASE_URL`) for
  a second purpose inside the running API would hand the API process
  `CREATEROLE`/`CREATEDB`-adjacent privileges it never needs, just to get
  the one property (bypassing RLS) it actually wants.

## Considered Options

1. **Reuse the bootstrap superuser credential inside the API process** for
   this one route. Simplest wiring, but grants the API far more than
   "read every tenant's usage" — a compromised API process could drop
   tables or create roles.
2. **A dedicated role with `BYPASSRLS`**, `NOSUPERUSER`, and `SELECT`-only
   grants on exactly the three tables `/customers/top` reads.
3. **Keep `app_user`, but add a policy exception** (e.g. a second policy
   with `USING (true)` gated by a different session flag). Rejected —
   two policies on one table whose combined effect depends on a flag the
   caller sets is a strictly harder thing to audit than "this role can
   see everything, that role can't," and it reintroduces exactly the
   per-request discipline RLS was chosen to avoid.

## Decision Outcome

Chosen: **2**. `migrations/004_admin_role.ts` creates `app_admin`
(`LOGIN`, `NOSUPERUSER`, `BYPASSRLS`), granted `SELECT` only — no
`INSERT`/`UPDATE`, since this role never writes — on `customers`,
`usage_events`, and `customer_plans`. `BYPASSRLS` requires a superuser to
grant, so this migration runs under the same bootstrap credential as
migration 001. The API gets a second connection (`ADMIN_DATABASE_URL`),
used exclusively by the `/customers/top` handler; every other route keeps
using the RLS-scoped `app_user` connection.

## Consequences

**Good:**
- The cross-tenant path is explicit at the connection level, not buried
  in a query that happens to omit a `WHERE customer_id`. Reading
  `createDb(config.adminDatabaseUrl, ...)` at a call site is itself a
  signal "this code intentionally spans tenants."
- Compromise of the main API connection (`app_user`) still can't read
  cross-tenant — `BYPASSRLS` lives only on the credential the admin route
  uses, not on the one every other route shares.

**Bad:**
- A third credential to provision and document (alongside the bootstrap
  superuser and `app_user`), and a second `Kysely` instance to keep alive
  and shut down cleanly in `src/server.ts`.
- If a future route mistakenly reuses the admin connection for a
  tenant-scoped query, it silently sees every tenant's data — there's no
  RLS backstop on this connection by design. This is the same shape of
  risk ADR 0006 flagged for the superuser: the guarantee is only as good
  as which connection each handler is wired to.

**Supersedes:** the "not yet added" note in ADR 0001's `/customers/top`
paragraph — that role is this one.
