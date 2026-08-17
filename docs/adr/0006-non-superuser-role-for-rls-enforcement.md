# 6. Dedicated non-superuser role for the API connection

**Status:** Accepted
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` T4, P9 · ADR 0001, ADR 0004

## Context and Problem Statement

ADR 0001 establishes RLS as the tenant-isolation mechanism, enforced via
`FORCE ROW LEVEL SECURITY` plus a policy on `current_setting('app.current_customer')`.
That guarantee only holds if the connection running application queries is
actually *subject to* RLS. Verified directly against the Postgres docs:

> By default, superusers, roles with the `BYPASSRLS` attribute, and table
> owners bypass row security policies. [...] table owners can opt into
> these restrictions using `FORCE ROW LEVEL SECURITY`.

Critically, `FORCE ROW LEVEL SECURITY` only affects the **table owner** —
it does not affect superusers, who bypass RLS unconditionally regardless
of `FORCE`. The official `postgres` Docker/Podman image's bootstrap user
(`POSTGRES_USER`, defaulted to `postgres` in this repo's `docker-compose.yml`)
**is a superuser**. If the API connected with those same credentials,
every query would silently bypass every RLS policy while still appearing
to work correctly for single-tenant test cases — the isolation guarantee
would be decorative, and nothing would surface that until a query
accidentally spanned two tenants.

## Decision Drivers

- Silent security failures are worse than loud ones: a role that bypasses
  RLS produces *correct-looking* results for a same-tenant query, so a
  naive test suite would pass without exercising the actual failure mode.
- Migrations need to create/alter tables and therefore need elevated
  privileges the runtime API should never hold.
- Least privilege is a stated standard (A01 Broken Access Control: "deny
  by default"), not just a nice-to-have here.

## Considered Options

1. **API connects as the bootstrap superuser** (simplest wiring, since
   it's what compose creates by default). Rejected — silently defeats
   ADR 0001 entirely; the isolation "guarantee" would not guarantee
   anything.
2. **API connects as a distinct role with `BYPASSRLS` unset**, created
   specifically for runtime queries; migrations run as the superuser
   (or table owner) separately.
3. **API connects as the table owner**, relying solely on `FORCE ROW
   LEVEL SECURITY`. Works in principle, but conflates "owns the schema"
   with "runs queries," which is an awkward privilege boundary and
   riskier if a future migration changes ownership assumptions.

## Decision Outcome

Chosen: **2**. `migrations/001_initial_schema.ts` creates a dedicated
role (`app_user`) with `LOGIN` but no `SUPERUSER` and no `BYPASSRLS`, and
grants it exactly the privileges the API needs (`SELECT`/`INSERT` on the
relevant tables, nothing on schema/role management). The API's
`DATABASE_URL` points at this role; the migration runner connects as the
bootstrap superuser (or table owner), since only the owner can define
policies (`CREATE POLICY`) in the first place.

`docker-compose.yml`'s `api` service is deliberately wired to `app_user`
credentials *before* the role exists (Phase 0, ahead of Phase 1's
migration) — this was a conscious sequencing choice, verified by
observing the expected failure (`password authentication failed for user
"app_user"`) rather than a role that happened to work by accident.

## Consequences

**Good:**
- RLS is enforced by the role's own lack of privilege, not by an
  assumption that application code always sets `app.current_customer`
  correctly — defense in depth rather than a single control.
- The failure mode when misconfigured is loud (`password authentication
  failed`, or if the role exists but a policy is missing, `permission
  denied`) rather than silent data leakage.

**Bad:**
- Adds a role-management step to migrations that a simpler (but unsafe)
  single-superuser setup wouldn't need.
- Local development requires knowing two sets of credentials (superuser
  for migrations, `app_user` for the running API) rather than one —
  documented in `.env.example` and `docker-compose.yml` rather than left
  implicit.
