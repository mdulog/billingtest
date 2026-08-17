# Assumptions Register

Every decision below fills a gap the requirements left open. Recorded as made,
so the write-up argues from a record rather than reconstructing intent.

**Basis** column:

| Marker | Meaning |
|---|---|
| 📄 **Spec** | Stated or directly implied by `docs/spec/takehome_requirements.md` |
| 🗣️ **Owner** | Domain fact supplied by the project owner, absent from the written spec |
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

## 2. Billing model

Domain semantics the spec never states. Supplied by the project owner; recorded
because everything in §2b depends on them. B3/B4/B7 graduated into
[ADR 0002](adr/0002-plan-history-as-a-range-table.md).

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| B1 | `plan` is a **subscription tier** (`free`, `growth`, `pro`, `enterprise`). A customer holds at most one at a time. | 🗣️ Owner-supplied | Add-ons or stacked entitlements would make plan a many-to-many, not a column. |
| B2 | **Cancellation means non-renewal at the end of the current billing period** — never mid-period termination. No proration, no partial-period tier on cancel. | 🗣️ Owner-supplied | Mid-period cancellation would require proration math and a partial-period tier at event granularity. |
| B3 | **Upgrades take effect immediately** (prorated); downgrades and cancellations wait for period end. Plan changes are therefore asymmetric. | 🗣️ Owner-supplied | If upgrades were also period-end-only, plan would be constant within a period and the whole `customer_plans` table would be unnecessary. |
| B4 | A customer's plan is **not** constant within a billing period. Cancellations and downgrades align to period boundaries (B2); upgrades do not (B3). | 🔍 Inferred (follows B2+B3) | — |
| B5 | Plan is currently a **grouping dimension only** — no rates, quotas, or currency math are in scope. The endpoints report usage, not money. | 🔍 Inferred (spec asks for counts and durations, never amounts) | The moment per-tier rates enter, plan-at-event-time (S2) stops being a limitation and becomes a hard correctness requirement. |
| B6 | A lapsed/cancelled state exists — a customer with no active subscription. Whether usage events can still arrive during a grace period is **open**. | 🔍 Inferred (follows B2) | Events arriving after lapse are either a grace period (expected) or an access-revocation failure (an incident). Changes whether that's a metric or an alarm. |
| B7 | Plan tiers form a **total order**: `free < growth < pro < enterprise`. | ⚠️ Invented | Required by the S3 disambiguation rule below. If tiers aren't linearly ordered (e.g. parallel add-on plans, regional tiers), "upgrade vs. downgrade" isn't well-defined and transition detection needs a different guard. |

## 2b. Schema design

S2/S3 graduated into [ADR 0002](adr/0002-plan-history-as-a-range-table.md).

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| S1 | `plan` is an attribute of the **customer**, not of the event. | 📄 Spec ("repeated on every event for a customer, rather than stored once") | — |
| S2 | **Resolved — implemented, not deferred.** `customers.plan` alone is insufficient per B3/B4; plan-at-event-time is tracked in a separate `customer_plans(customer_id, plan, valid_period)` table with an `EXCLUDE USING gist` constraint preventing overlaps. `customers.plan` is kept as a denormalized cache of the current plan for cheap listing reads. | 🗣️ Owner-supplied (via B3) | — |
| S3 | **Resolved.** A mid-period plan change is a real upgrade if it moves *up* the B7 tier ladder; it's dirty data if it moves *down*, since B2 forbids mid-period downgrades. Events are walked in `occurred_at` order per customer; upgrades close the current interval and open a new one, downgrades are rejected and the running plan is kept. | 🔍 Inferred (derived from B2+B3+B7) | Depends entirely on B7 (total tier order). If two plans aren't comparable, this guard can't classify the transition and needs replacing — e.g. an explicit subscription-event feed instead of inferring from usage data. |
| S4 | **Resolved — no separate `users` table.** `user_email` stays a normalized text column on `usage_events`, the same call S8 makes for `endpoint`. None of the three required endpoints group or filter by user, so a table whose only content would be an inferred `(customer_id, email)` uniqueness constraint (never enforced by the source data) adds a join with no query it serves. A user (`user_email`) belongs to exactly one customer; uniqueness would be `(customer_id, email)`, not global, if this is ever revisited. | 🔍 Inferred (multi-tenant norm) | Shared users across tenants would need a join table and would complicate tenant isolation. If a future endpoint needs per-user breakdown, this is the column to promote. |
| S5 | `duration_ms` and `status` are the only hot fields worth promoting to typed columns; the rest stay in `jsonb`. | 🔍 Inferred (from the three required queries) | If billing later keys on `rows` or `attempt`, those need promoting too — a migration, which is fine and demonstrates schema evolution. |
| S6 | Full `metadata` is retained losslessly even after promotion. | ⚠️ Invented | Costs storage. Justified because discarding unknown fields at ingest is irreversible. |
| S7 | `endpoint` is stored normalized (lowercased, trimmed, trailing slash stripped) rather than raw. | 🔍 Inferred (fixture proves 13 raw → 10 normalized) | Loses the original casing. If the raw form matters for debugging, keep it in `metadata`. |
| S8 | `endpoint` stays a text column rather than an FK to an `endpoints` lookup table. | 🔍 Inferred (cardinality is ~10) | At thousands of distinct endpoints, a lookup table saves significant space and enables per-endpoint attributes. |
| S9 | `user_email` is stored normalized (lower + trim), collapsing `  Jane@AcmeCo.com  ` into `jane@acmeco.com`. | 🔍 Inferred | Treats them as one person. If they're genuinely distinct identities, this merges billing attribution incorrectly. |

## 3. Multi-tenancy

T1–T4 graduated into [ADR 0001](adr/0001-row-level-security-for-tenant-isolation.md);
T4/P9 into [ADR 0006](adr/0006-non-superuser-role-for-rls-enforcement.md).

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| T1 | "Isolate one customer's data from another's **at the database level**" means DB-enforced, not application `WHERE` discipline. | 📄 Spec (emphasis theirs) | If app-level filtering was the intent, RLS is over-engineering for the time budget. |
| T2 | RLS with `current_setting('app.current_customer')` is the right rung — implemented; schema-per-tenant and partitioning are named but not built. | 🔍 Inferred (cost/benefit at 3h) | — |
| T3 | The service runs against a **connection pool**, so tenant context must be set with `SET LOCAL` inside a transaction. | 🔍 Inferred (standard Node/Postgres deployment) | Without pooling, plain `SET` would be safe — but assuming pooling is the safe direction to be wrong in. |
| T4 | The application connects as a role **subject to** RLS (`FORCE ROW LEVEL SECURITY`), not as table owner or superuser. | 🔍 Inferred | RLS silently does nothing for the table owner. This assumption is what makes T2 real rather than decorative. |
| T5 | `/customers/top` is an internal/admin query that legitimately crosses tenants and runs outside the RLS-scoped path. | ⚠️ Invented | If it were customer-facing, it would leak competitors' usage volumes — a serious disclosure bug. Flagged deliberately. |
| T6 | **No authentication is in scope.** Tenant identity comes from the URL path parameter. | ⚠️ Invented (spec never mentions auth) | 🚨 In production this is a trivial IDOR — anyone can read any tenant by changing the URL. Tenant identity must come from an authenticated token, not user input. Called out explicitly in the write-up rather than left implied. |

## 4. Ingestion

I1/I2/I3 graduated into [ADR 0005](adr/0005-derived-dedupe-key-no-source-event-id.md).

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| I1 | The dedupe key is derived by hashing selected normalized fields, enforced as `UNIQUE (customer_id, dedupe_key)`. | 🔍 Inferred (follows from D2) | — |
| I2 | *(Open — owner decision)* Whether `metadata` is part of that hash. Excluding it treats a redelivery with a corrected `duration_ms` as the same event; including it treats it as distinct. | ⚠️ Invented either way | Directly changes billed event counts. The single most consequential unresolved choice. |
| I3 | Re-running the loader must be safe (idempotent), hence `ON CONFLICT DO NOTHING`. | 🔍 Inferred (operational hygiene) | — |
| I4 | The whole file ingests inside one transaction — all or nothing. | 🔍 Inferred (spec: "transactions for multi-step writes") | Fails badly at large scale; batched chunked commits with a resumable cursor would be the scale answer. Tied to D4. |
| I5 | Malformed records are quarantined to `ingest_rejects` with a reason code, not dropped. | 🔍 Inferred ("handling reasonably... be ready to explain it") | Dropping is defensible but loses the reject-rate signal that A6 depends on. |
| I6 | An event with no `customer_id` is unbillable and always rejected. | 🔍 Inferred (nothing to attribute it to) | If a fallback attribution exists (e.g. via `user_email` domain), those events are recoverable revenue. |
| I7 | `plan: null` and `plan: ""` mean the same thing — unknown. | ⚠️ Invented — **reopened by B6** | B6 establishes that "no active subscription" is a real state, so a blank plan may mean *lapsed* rather than *unknown*. Those bill differently: unknown is a data-quality problem, lapsed is a legitimate account state. Distinguishing them needs a `customers.status` column rather than overloading a null plan. |
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
| A6 | Operational health is measured by reject rate by reason, ingest duration, events ingested per run, dedupe hit rate, and endpoint p95 latency. | 🔍 Inferred (write-up question 3) | — |
| A7 | Paging is reserved for failures that are **silently wrong and cost money or leak data** — stale ingest, a reject-rate shift, cross-tenant leakage, availability. Individual malformed records are explicitly *not* page-worthy; the quarantine table absorbs them by design. | 🔍 Inferred (write-up question 3, "what would page someone at 2am") | Paging on every reject trains responders to ignore the alarm, which is worse than not having it. Full matrix in `plan.md` → Operational posture. |

## 6. Stack & process

P3/P7 graduated into [ADR 0003](adr/0003-fastify-and-kysely.md);
P8 into [ADR 0004](adr/0004-containerize-with-podman-compatible-images.md).

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| P1 | Node 24.x is the current Active LTS. Local environment is v22.23.1 (maintenance line). | ⚠️ Invented — **Context7 returned no Node release-schedule doc**; not verified against nodejs.org. | Low impact; no design decision depends on it. |
| P2 | Postgres 17/18. RLS and declarative range partitioning are both assumed available. | 🔍 Inferred (both long-standing features) | — |
| P3 | Kysely over an ORM — typed SQL that still shows schema reasoning, which is what's being graded. | 🔍 Inferred (spec: "use what you'd reach for") | — |
| P7 | Fastify over Express, for per-route JSON Schema validation (`params` / `querystring`) plus `setErrorHandler` on `error.validation`. Verified against Fastify docs via Context7. | 🗣️ Owner-supplied | Express would work; boundary validation becomes hand-rolled or a `zod`/`celebrate` dependency. |
| P4 | Tests run against a real Postgres, not a mocked DB. | 📄 Spec (schema correctness is the subject) | — |
| P5 | Budget ~4h of the stated 2–4h, with the cut-order in `plan.md` if it slips. | 📄 Spec | — |
| P8 | **Service and database both run in containers**; `docker compose up` is the only setup step on a reviewer's machine. Config via environment variables, fail fast if absent. | 🗣️ Owner-supplied | — |
| P9 | The API connects as a **dedicated non-superuser role**, created in migrations. | 🔍 Inferred (forced by P8 + T4) | Superusers bypass RLS entirely, so connecting with the Postgres image's default credentials would make every tenant-isolation guarantee inert while still appearing to work. |
| P6 | Git history should read as incremental decisions, not one upload. | 📄 Spec ("commit as if you were working in a real team") | — |

---

## Questions I'd ask if this were a real ticket

The spec invites clarifying questions. These are the ones where guessing costs
the most, roughly in priority order:

1. **Is a redelivered event with different `metadata` the same billable event?** (I2) — changes billed counts directly.
2. **Can usage events legitimately arrive after a subscription lapses (grace period), or is that an access-control failure?** (B6) — decides metric vs. alarm.
3. **Are plan tiers totally ordered** (`free < growth < pro < enterprise`), or can a customer hold parallel/incomparable plans? (B7) — the upgrade/downgrade disambiguation in S3 depends on it.
4. **Who is the audience for `/customers/top`?** (T5) — internal ops, or customer-facing? Determines whether cross-tenant access is a feature or a leak.
5. **Is billing computed on UTC boundaries or per-customer local time?** (A3)
6. **Should events with no `customer_id` be recoverable, or written off?** (I6)
7. **Is `event_type` a closed set product controls, or open-ended?** (I9)
