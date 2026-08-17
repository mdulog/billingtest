# Assumptions Register

Every decision below fills a gap the requirements left open. Recorded as made,
so the write-up argues from a record rather than reconstructing intent.

**Basis** column:

| Marker | Meaning |
|---|---|
| 📄 **Spec** | Stated or directly implied by `docs/requirements/takehome_requirements.md` |
| 🔍 **Inferred** | Not stated, but the most defensible reading of the spec or the data |
| ⚠️ **Invented** | Chosen with no evidence either way. Highest risk — verify these first if the real dataset or a clarifying answer arrives. |

---

## 1. Source data

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| D1 | The real `usage_events.json` is not yet in hand; `fixtures/usage_events.sample.json` is a synthetic stand-in. | ⚠️ Invented | Everything downstream is tuned to defects that may not exist. Swap in the real file and re-run ingestion before submitting. |
| D2 | Records have **no** `event_id` or any natural unique identifier. | 📄 Spec (sample record shows none) | If one exists, the whole derived-dedupe-key design (I1) is unnecessary complexity. |
| D3 | `occurred_at` is ISO-8601 UTC with a `Z` suffix and second granularity. | 📄 Spec (sample: `2026-07-14T18:32:11Z`) | Timezone offsets (`+05:30`) would break naive parsing and shift date-range results. |
| D4 | The file is a single JSON array small enough to read into memory. | 🔍 Inferred (take-home scale) | A multi-GB file or NDJSON needs streaming ingestion; the transaction strategy (I4) would change. |
| D5 | `metadata` is an object whose keys vary by `event_type`, not a fixed shape. | 📄 Spec ("a little messy") + fixture design | A fixed shape would justify promoting all fields to columns instead of keeping `jsonb`. |
| D6 | Some event types legitimately carry **no** `duration_ms` (e.g. `login`). | ⚠️ Invented (my fixture models this) | If every event should have one, absence is a defect and should be rejected, not tolerated. |
| D7 | `customer_id` values are stable, opaque strings (`cust_042`) usable as a natural primary key. | 🔍 Inferred | If they're reassigned or non-unique, `customers.id` needs a surrogate key. |
| D8 | Event volume per customer is heavily skewed (roughly power-law). | 📄 Spec ("some are heavy, some barely show up") | Even distribution would weaken the case for BRIN indexing and partitioning. |

## 2. Schema design

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| S1 | `plan` is an attribute of the **customer**, not of the event. | 📄 Spec ("repeated on every event for a customer, rather than stored once") | — |
| S2 | Storing only the customer's *current* plan is acceptable for now. | 🔍 Inferred (3h budget) | **Known limitation.** Billing should apply the plan in effect *at event time*. Correct fix is an SCD-2 `customer_plans(customer_id, plan, effective_from, effective_to)`. Listed as the top "what I'd do next". |
| S3 | Where a customer shows conflicting plan values, they represent one plan recorded dirtily — not a mid-period plan change. | ⚠️ Invented | If it's a real upgrade, collapsing it silently loses billable history and S2 becomes a correctness bug, not a limitation. |
| S4 | A user (`user_email`) belongs to exactly one customer; uniqueness is `(customer_id, email)`, not global. | 🔍 Inferred (multi-tenant norm) | Shared users across tenants would need a join table and would complicate tenant isolation. |
| S5 | `duration_ms` and `status` are the only hot fields worth promoting to typed columns; the rest stay in `jsonb`. | 🔍 Inferred (from the three required queries) | If billing later keys on `rows` or `attempt`, those need promoting too — a migration, which is fine and demonstrates schema evolution. |
| S6 | Full `metadata` is retained losslessly even after promotion. | ⚠️ Invented | Costs storage. Justified because discarding unknown fields at ingest is irreversible. |
| S7 | `endpoint` is stored normalized (lowercased, trimmed, trailing slash stripped) rather than raw. | 🔍 Inferred (fixture proves 13 raw → 10 normalized) | Loses the original casing. If the raw form matters for debugging, keep it in `metadata`. |
| S8 | `endpoint` stays a text column rather than an FK to an `endpoints` lookup table. | 🔍 Inferred (cardinality is ~10) | At thousands of distinct endpoints, a lookup table saves significant space and enables per-endpoint attributes. |
| S9 | `user_email` is stored normalized (lower + trim), collapsing `  Jane@AcmeCo.com  ` into `jane@acmeco.com`. | 🔍 Inferred | Treats them as one person. If they're genuinely distinct identities, this merges billing attribution incorrectly. |

## 3. Multi-tenancy

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| T1 | "Isolate one customer's data from another's **at the database level**" means DB-enforced, not application `WHERE` discipline. | 📄 Spec (emphasis theirs) | If app-level filtering was the intent, RLS is over-engineering for the time budget. |
| T2 | RLS with `current_setting('app.current_customer')` is the right rung — implemented; schema-per-tenant and partitioning are named but not built. | 🔍 Inferred (cost/benefit at 3h) | — |
| T3 | The service runs against a **connection pool**, so tenant context must be set with `SET LOCAL` inside a transaction. | 🔍 Inferred (standard Node/Postgres deployment) | Without pooling, plain `SET` would be safe — but assuming pooling is the safe direction to be wrong in. |
| T4 | The application connects as a role **subject to** RLS (`FORCE ROW LEVEL SECURITY`), not as table owner or superuser. | 🔍 Inferred | RLS silently does nothing for the table owner. This assumption is what makes T2 real rather than decorative. |
| T5 | `/customers/top` is an internal/admin query that legitimately crosses tenants and runs outside the RLS-scoped path. | ⚠️ Invented | If it were customer-facing, it would leak competitors' usage volumes — a serious disclosure bug. Flagged deliberately. |
| T6 | **No authentication is in scope.** Tenant identity comes from the URL path parameter. | ⚠️ Invented (spec never mentions auth) | 🚨 In production this is a trivial IDOR — anyone can read any tenant by changing the URL. Tenant identity must come from an authenticated token, not user input. Called out explicitly in the write-up rather than left implied. |

## 4. Ingestion

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| I1 | The dedupe key is derived by hashing selected normalized fields, enforced as `UNIQUE (customer_id, dedupe_key)`. | 🔍 Inferred (follows from D2) | — |
| I2 | *(Open — owner decision)* Whether `metadata` is part of that hash. Excluding it treats a redelivery with a corrected `duration_ms` as the same event; including it treats it as distinct. | ⚠️ Invented either way | Directly changes billed event counts. The single most consequential unresolved choice. |
| I3 | Re-running the loader must be safe (idempotent), hence `ON CONFLICT DO NOTHING`. | 🔍 Inferred (operational hygiene) | — |
| I4 | The whole file ingests inside one transaction — all or nothing. | 🔍 Inferred (spec: "transactions for multi-step writes") | Fails badly at large scale; batched chunked commits with a resumable cursor would be the scale answer. Tied to D4. |
| I5 | Malformed records are quarantined to `ingest_rejects` with a reason code, not dropped. | 🔍 Inferred ("handling reasonably... be ready to explain it") | Dropping is defensible but loses the reject-rate signal that A6 depends on. |
| I6 | An event with no `customer_id` is unbillable and always rejected. | 🔍 Inferred (nothing to attribute it to) | If a fallback attribution exists (e.g. via `user_email` domain), those events are recoverable revenue. |
| I7 | `plan: null` and `plan: ""` mean the same thing — unknown. | ⚠️ Invented | If `""` means "explicitly no plan" they need distinct handling. |
| I8 | `duration_ms` that is non-integer, negative, or absurdly large is rejected; **absent** `duration_ms` is not (see D6). | 🔍 Inferred | Conflating "absent" with "malformed" would reject every valid `login` event. |
| I9 | Unrecognized `event_type` values (e.g. `quota_check`) are accepted, not rejected — `event_type` stays `text`, not a Postgres enum. | ⚠️ Invented | An enum is safer but forces a migration every time product ships a new event type. Open/closed tradeoff worth stating. |

## 5. API

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| A1 | Date ranges are half-open: `occurred_at >= from AND occurred_at < to`. | 🔍 Inferred (avoids boundary double-counting) | Inclusive ranges double-count events on the boundary instant across adjacent billing periods. |
| A2 | `from`/`to` are required and validated as ISO dates at the boundary; malformed input returns 400. | 🔍 Inferred (spec: "in a given date range") | If they're optional, a sensible default window (e.g. current month) is needed. |
| A3 | All timestamps are handled in UTC; no per-customer billing timezone. | ⚠️ Invented | A customer billed on local-midnight boundaries gets wrong daily/monthly totals. Realistic requirement, deliberately out of scope. |
| A4 | Result sets are small enough not to need pagination. | 🔍 Inferred (take-home scale) | Per-endpoint breakdown for a heavy customer over a year would need it. |
| A5 | "Usage summary" means event count, total `duration_ms`, and a status breakdown. | 📄 Spec ("event counts, total `duration_ms`, etc.") — the "etc." is mine to define | — |
| A6 | Operational health is measured by reject rate by reason, ingest duration, events ingested per run, and dedupe hit rate. | 🔍 Inferred (write-up question 3) | — |

## 6. Stack & process

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| P1 | Node 24.x is the current Active LTS. Local environment is v22.23.1 (maintenance line). | ⚠️ Invented — **Context7 returned no Node release-schedule doc**; not verified against nodejs.org. | Low impact; no design decision depends on it. |
| P2 | Postgres 17/18. RLS and declarative range partitioning are both assumed available. | 🔍 Inferred (both long-standing features) | — |
| P3 | Kysely over an ORM — typed SQL that still shows schema reasoning, which is what's being graded. | 🔍 Inferred (spec: "use what you'd reach for") | — |
| P4 | Tests run against a real Postgres, not a mocked DB. | 📄 Spec (schema correctness is the subject) | — |
| P5 | Budget ~3h of the stated 2–4h, with the cut-order in `plan.md` if it slips. | 📄 Spec | — |
| P6 | Git history should read as incremental decisions, not one upload. | 📄 Spec ("commit as if you were working in a real team") | — |

---

## Questions I'd ask if this were a real ticket

The spec invites clarifying questions. These are the ones where guessing costs
the most, roughly in priority order:

1. **Is a redelivered event with different `metadata` the same billable event?** (I2) — changes billed counts directly.
2. **Do conflicting `plan` values represent a mid-period plan change?** (S3, S2) — if yes, plan history is a correctness requirement, not a nice-to-have.
3. **Who is the audience for `/customers/top`?** (T5) — internal ops, or customer-facing? Determines whether cross-tenant access is a feature or a leak.
4. **Is billing computed on UTC boundaries or per-customer local time?** (A3)
5. **Should events with no `customer_id` be recoverable, or written off?** (I6)
6. **Is `event_type` a closed set product controls, or open-ended?** (I9)
