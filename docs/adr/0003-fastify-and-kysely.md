# 3. Fastify and Kysely over an ORM/Express default

**Status:** Accepted
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` P3, P7 · `docs/plan.md` Phase 0

## Context and Problem Statement

The spec explicitly declines to prescribe an ORM or framework ("use what
you'd reach for on the job"), but the choice still has to be made and
defended, because what's being evaluated includes schema/relational
reasoning — a stack that hides SQL behind an abstraction works against
demonstrating that.

## Decision Drivers

- The grading criteria explicitly want "real Postgres/relational modeling
  instincts" visible — the query layer shouldn't obscure them.
- Boundary input validation (`from`/`to` date ranges, `customer_id`) needs
  to reject bad input cleanly, per the security/input-validation standard.
- Small time budget: whatever's chosen needs to be productive immediately,
  not something requiring its own ramp-up.

## Considered Options

**Query layer:**
1. **Raw `pg`** — full control, but ~an afternoon of hand-rolled row
   mapping and no compile-time query safety, disproportionate cost for a
   3–4h exercise.
2. **A full ORM** (Prisma, TypeORM) — fast to write, but generates SQL
   behind an abstraction, which works against the "show your schema
   instincts" grading criterion.
3. **Kysely** — a typed SQL query builder. You still write SQL-shaped
   queries; TypeScript checks the shape.

**HTTP framework:**
1. **Express** — most universally familiar, but boundary validation
   requires hand-written checks or an added dependency (`zod`, `celebrate`).
2. **Fastify** — per-route JSON Schema validation is built in.
3. **Hono** — smallest/fastest, but less conventional in a Postgres
   backend context, inviting an unnecessary "why this?" from a reviewer.

## Decision Outcome

Chosen: **Kysely** for the query layer, **Fastify** for HTTP. Verified
against both projects' current documentation via Context7 rather than
assumed from prior knowledge.

Fastify's schema-per-route makes the input-validation requirement
declarative:

```ts
app.get('/customers/:customerId/usage', {
  schema: {
    params: { type: 'object', required: ['customerId'],
      properties: { customerId: { type: 'string' } } },
    querystring: { type: 'object', required: ['from', 'to'],
      properties: {
        from: { type: 'string', format: 'date-time' },
        to:   { type: 'string', format: 'date-time' },
      } },
  },
}, handler);
```

paired with `setErrorHandler` inspecting `error.validation` /
`error.validationContext`, so a validation failure returns a structured
400 and every other failure returns a generic message — never a stack
trace or raw DB error reaching the client.

## Consequences

**Good:**
- SQL stays visible and reviewable in the codebase — the schema decisions
  in ADR 0001/0002 are legible in the queries that use them, not hidden
  behind ORM-generated SQL.
- Boundary validation is declarative rather than hand-rolled, satisfying
  the input-validation requirement with less code and less room for a
  missed check.

**Bad:**
- Kysely requires either hand-written or generated types for the schema
  (`src/db/types.ts`), which must be kept in sync with migrations
  manually unless a codegen step is added later.
- Fastify is a smaller ecosystem than Express; less likely a reviewer has
  muscle memory for its exact API, though the schema-validation payoff is
  judged worth that.
