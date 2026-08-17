# 5. Derived dedupe key, since the source has no event ID

**Status:** Accepted (architecture) — **one sub-decision left open**, see
Consequences
**Date:** 2026-08-16
**Related:** `docs/assumptions.md` D2, I1, I2, I3 · `docs/plan.md` Phase 2

## Context and Problem Statement

The spec states events may be duplicated and must be handled "reasonably."
The sample record and the observed data both confirm there is **no
`event_id` or any natural unique identifier** — so "detect a duplicate"
requires deriving identity from the record's own fields, and that
derivation is a real design choice with consequences for billed counts,
not a mechanical detail.

## Decision Drivers

- Re-running ingestion (e.g. after a crash, or deliberately for testing)
  must be safe — it should not double-count events already ingested.
- The derivation has to make an explicit choice about *what constitutes
  "the same event"* when two records share identifying fields but differ
  in `metadata` (e.g. a redelivery with a corrected `duration_ms`).
- Malformed records need a path that doesn't collide with or corrupt the
  dedupe mechanism for well-formed ones.

## Considered Options

1. **In-memory dedupe during a single ingestion run only** (e.g. a `Set`
   of seen keys). Cheap, but not idempotent across runs — re-ingesting the
   same file after a partial failure would re-insert everything.
2. **Derived key + database-enforced uniqueness**, via
   `UNIQUE (customer_id, dedupe_key)` and `ON CONFLICT DO NOTHING`.
   Idempotent by construction — safe to re-run the loader at any time.
3. **Wait for the real dataset to reveal an implicit ID** (e.g. request
   ID in `metadata`) before designing dedupe at all. Rejected as
   premature optimization for uncertainty — the fixture already proves
   duplicates exist without one, and a design has to exist regardless.

## Decision Outcome

Chosen: **2**. The key is derived from normalized identifying fields and
enforced as a real constraint rather than application-level care:

```sql
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_customer_dedupe_key_key
  UNIQUE (customer_id, dedupe_key);
```

Insertion uses `ON CONFLICT (customer_id, dedupe_key) DO NOTHING`, making
re-running the ingestion loader safe at any time — a crash mid-run costs
nothing but re-processing time.

## Consequences

**Good:**
- Ingestion is idempotent by construction: the database refuses the
  duplicate, rather than the application promising not to insert one.
- Makes duplicate handling an auditable, testable property (unit-testable
  without a database) instead of an implicit assumption.

**Bad / open:**
- **What fields the key is derived from is not yet decided**, and it's
  consequential: including `metadata` in the hash means a redelivered
  event with a corrected `duration_ms` counts as a *distinct* billable
  event; excluding it treats the redelivery as *the same* event. These
  produce different billed totals for the same input data, and there is
  no evidence in the spec pointing either way — this is deliberately left
  as an implementation-time decision (`docs/plan.md` Phase 2), not
  resolved here, so it doesn't get decided by default.
- The derived key can only dedupe against fields that exist and are
  normalized consistently — a malformed record that fails normalization
  before a key can be derived goes to `ingest_rejects` instead, on a
  separate path that doesn't interact with this constraint.
