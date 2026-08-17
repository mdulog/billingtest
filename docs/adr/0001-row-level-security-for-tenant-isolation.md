# 1. Row-level security for tenant isolation

**Status:** Accepted
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` T1–T4, T6 · `docs/plan.md` Phase 1

## Context and Problem Statement

The spec requires isolating one customer's data from another's "at the
database level," not merely in application code. What database-enforced
mechanism achieves that within a 2–4h exercise, and what does it cost?

## Decision Drivers

- The phrase "at the database level" is explicit in the spec — application
  `WHERE customer_id = $1` discipline is not database-level isolation; it's
  a convention that a single missed clause silently breaks.
- Budget: a few hours, not a platform migration.
- Failure mode matters more than the mechanism: a forgotten filter should
  fail closed (return nothing), not fail open (leak another tenant's rows).

## Considered Options

1. **Application-level filtering only** — every query includes
   `WHERE customer_id = $1`. Cheapest, but isolation lives entirely in
   code discipline; nothing stops a missing clause from leaking data, and
   it doesn't answer "at the database level" as asked.
2. **Row-Level Security (RLS)** with a per-request session variable.
   Postgres-native, moderate setup cost, enforced on every query
   automatically once configured.
3. **Schema-per-tenant** — one schema (or database) per customer.
   Strongest isolation, but operationally heavy at this scale (migrations
   run N times, connection routing per tenant) and disproportionate for a
   take-home.

## Decision Outcome

Chosen option: **RLS (2)**.

```sql
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events
  USING (customer_id = current_setting('app.current_customer', true));
```

Per request, inside the same transaction as the query:
`SET LOCAL app.current_customer = $1`.

`SET LOCAL`, not `SET` — with a pooled connection, a plain `SET` persists
past the transaction and leaks tenant context to whichever request borrows
that connection next.

This requires the API to connect as a **non-superuser role** — see ADR
0006; superusers and the table owner (absent `FORCE`) bypass RLS entirely,
which would make this policy silently decorative.

**Applies to every tenant-scoped table, not just `usage_events`.**
`customers` and `customer_plans` (added in migration 002, ADR 0002) get the
identical `ENABLE`/`FORCE`/policy treatment. Without a policy on
`customers`, `app_user` could `SELECT * FROM customers` with no
`WHERE` and enumerate every tenant ID and plan regardless of session
context — the same class of leak this ADR exists to prevent, just on a
different table. Confirmed by test: `src/db/rls.test.ts` asserts this for
all three tables, including the negative case (no session var set → zero
rows, not another tenant's).

`/customers/top` is deliberately cross-tenant (an admin/ops view) and uses
a separate, non-RLS-scoped connection path rather than working around the
policy per-request. Note this is a hard requirement once RLS is `FORCE`d
on `customers`/`usage_events`/`customer_plans` for `app_user`: with no
session var set, `current_setting('app.current_customer', true)` is
`NULL`, and `customer_id = NULL` is never true — `app_user` gets **zero**
rows, not all tenants' rows, for any query that doesn't set the session
var. So `/customers/top` cannot be served through `app_user`'s
RLS-scoped connection at all; it needs a distinct role with `BYPASSRLS` —
`app_admin`, added in Phase 3's `migrations/004_admin_role.ts`. See
ADR 0007 for the role-design tradeoffs.

## Consequences

**Good:**
- A forgotten `WHERE` clause returns zero rows instead of another tenant's
  data — fail-closed, enforced by Postgres rather than by code review.
- Directly answers the spec's "at the database level" phrasing with an
  artifact (a policy) rather than a claim.

**Bad:**
- Every connection must correctly set `app.current_customer` before
  querying tenant-scoped tables, or RLS's default-deny returns empty
  results that look like "no data" rather than "misconfigured."
- Requires discipline around role separation (ADR 0006) to actually hold.

**Not pursued, and why:** schema-per-tenant and `PARTITION BY RANGE
(occurred_at)` are named as the answer to "hundreds of customers with
wildly different data volumes" (per T2) but not implemented — the
combination is the right answer at a scale this exercise doesn't require.
