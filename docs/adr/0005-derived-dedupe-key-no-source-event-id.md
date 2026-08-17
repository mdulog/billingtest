# 5. Derived dedupe key, since the source has no event ID

**Status:** Accepted — fully resolved (see Decision Outcome for I2)
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

**I2, resolved:** the key hashes `event_type`, `endpoint`, `user_email`,
and `occurred_at` (all post-normalization, so casing/whitespace variants
of the same event still collide) — **`metadata` is excluded**. A
redelivery that only corrects `duration_ms`/`status` therefore hits the
same key and is treated as a correction to the same billable event, not a
second one.

The honest option set turned out to be three, not two, once it was clear
`duration_ms`/`status` live *inside* `metadata` in the source data:

1. Exclude metadata, `ON CONFLICT ... DO NOTHING` — one row, but the
   *first* delivery always wins; a corrected `duration_ms` in a later
   redelivery is silently discarded, not merged.
2. Include metadata in the hash, `ON CONFLICT ... DO NOTHING` — a
   redelivery with any metadata drift becomes a second billable event.
   Rejected: any jitter in metadata defeats the key against exactly the
   redelivery case it exists to catch, and usage/billed counts inflate on
   every redelivery.
3. **Chosen.** Exclude metadata, `ON CONFLICT (customer_id, dedupe_key)
   DO UPDATE SET duration_ms = excluded.duration_ms, status =
   excluded.status, metadata = excluded.metadata`. One row per event, and
   the most recent delivery's correction wins instead of being dropped.

Insertion uses this `DO UPDATE`, which also makes re-running the
ingestion loader safe at any time (idempotent, not merely
duplicate-proof) — a crash mid-run, or a genuine redelivery, costs
nothing but the write itself.

## Consequences

**Good:**
- Ingestion is idempotent by construction: the database resolves the
  conflict deterministically, rather than the application promising not
  to insert a duplicate.
- Corrections are actually applied, not silently dropped — "latest
  delivery wins" is a real, testable property
  (`src/ingest/ingestEvents.test.ts`), not an implicit assumption.
- Makes duplicate handling auditable and unit-testable without a database
  (`src/ingest/dedupeKey.test.ts`, `normalize.test.ts`).

**Bad / accepted:**
- "Latest delivery wins" assumes later-in-file means later-in-time for
  same-identity records. The source has no delivery timestamp to
  disambiguate otherwise; file order is the only signal available.
- The derived key can only dedupe against fields that exist and are
  normalized consistently — a malformed record that fails normalization
  before a key can be derived goes to `ingest_rejects` instead, on a
  separate path that doesn't interact with this constraint.
