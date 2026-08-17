# 2. Plan history as a range table, not a column

**Status:** Accepted
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` B2, B3, B4, B7, S2, S3 · `docs/plan.md`
Phase 1/2 · ADR 0005 (interacts with dedupe key derivation)

## Context and Problem Statement

The spec repeats `plan` on every event rather than storing it once — a
direct hint that `plan` belongs on `customers`, not `usage_events`. But a
single `customers.plan` column can only ever answer "what plan is this
customer on *right now*." Billing queries ask "what plan was this customer
on *when this event occurred*" — a different question, and the two only
coincide if plan never changes mid-period.

The project owner confirmed the standard asymmetric SaaS pattern:
**upgrades take effect immediately** (prorated); **downgrades and
cancellations wait until the current billing period ends** (B2, B3). So a
customer can hold two different plans within one billing period, and
`customers.plan` alone cannot correctly attribute events to a plan.

## Decision Drivers

- B3's asymmetry is a hard constraint once accepted — a single-column plan
  is provably insufficient, not just a simplification.
- The source data has no explicit subscription-change feed; plan
  transitions must be *derived* from the event stream itself.
- The fixture (and, presumably, real data) contains conflicting plan
  values per customer (e.g. `"enterprise"` vs `"Enterprise "` for one
  customer) that could be dirty data *or* a genuine upgrade — those need
  to be distinguishable, not conflated.

## Considered Options

1. **Single `customers.plan` column**, always "current plan." Simplest,
   but incorrect the moment a query spans a plan change — contradicts B3
   outright, and silently mis-attributes billed usage.
2. **SCD-2 style `customer_plans(customer_id, plan, valid_period)` table**,
   with the database preventing overlapping periods.
3. **Full audit log of plan-change events**, sourced from an external
   subscription system. Not chosen because no such feed exists in this
   exercise — deriving from usage events is the only available signal.

## Decision Outcome

Chosen option: **2**, implemented as:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE customer_plans (
  id           bigserial PRIMARY KEY,
  customer_id  text      NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan         text      NOT NULL,
  valid_period tstzrange NOT NULL,
  EXCLUDE USING gist (customer_id WITH =, valid_period WITH &&)
);
```

The `EXCLUDE` constraint (verified against the Postgres docs;
`btree_gist` is what permits combining the scalar equality check with the
range overlap check) makes overlapping plan periods for one customer
**unrepresentable**, not merely disallowed by application convention.

`customers.plan` is *kept* as a deliberate denormalized cache of the
current plan, maintained in the same transaction as `customer_plans` —
cheap reads for "what plan is this customer on now" without a range join,
while `customer_plans` is authoritative for time-scoped attribution.

Transitions are derived by walking one customer's events in `occurred_at`
order and applying a monotonic-tier guard (requires B7: plan tiers form a
total order `free < growth < pro < enterprise`): a move *up* the ladder is
accepted as a real upgrade and closes/opens an interval; a move *down* is
rejected as dirty data, since B2 makes a mid-period downgrade impossible
by the stated business rule.

## Consequences

**Good:**
- Billing queries can correctly attribute usage to the plan in effect at
  event time via `occurred_at <@ valid_period`.
- The exclusion constraint gives a real database-level correctness
  guarantee, not just an ingestion-time promise.
- The conflicting-plan-values ambiguity in the source data becomes
  resolvable rather than silently averaged or arbitrarily picked.

**Bad:**
- Every plan-attributed query pays a range join instead of a flat column
  read (mitigated by the GiST index and by keeping the denormalized
  cache for the common "current plan" case).
- The monotonic-tier guard's correctness depends entirely on B7. If plan
  tiers are not totally ordered (parallel add-ons, regional variants),
  "upgrade vs. downgrade" stops being well-defined and this derivation
  needs replacing with an explicit subscription-event source.
- Adds real implementation cost (~30–40 min) inside a tightly time-boxed
  exercise — reflected as the first item in `docs/plan.md`'s cut-order if
  time runs short, collapsing back to option 1 with the limitation stated
  explicitly in the write-up rather than silently absorbed.
