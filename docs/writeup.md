# Write-up

Answers to the four questions from `docs/spec/takehome_requirements.md`. Each
answer points at the commit, migration, ADR, or test that backs it rather
than re-arguing the case from scratch — the full reasoning (including
options considered and rejected) lives in `docs/adr/` and
`docs/assumptions.md`.

## 1. Schema design

Four tables: `customers` and `usage_events`
(`migrations/001_initial_schema.ts`), `customer_plans`
(`migrations/002_plan_history.ts`), `ingest_rejects`
(`migrations/003_ingestion.ts`).

**One big table vs. several.** A single wide `usage_events` row carrying
`plan` and `user_email` inline (i.e., leaving the source shape as-is) is a
real option, not a strawman — it's append-only, the read pattern is
aggregate-over-a-date-range, and it avoids every join. Rejected for three
concrete reasons, not on principle:

1. **Update anomalies with cost.** Plans change over time (owner-confirmed,
   see B3 below). Denormalized inline, correcting a customer's plan means
   rewriting every historical row; normalized, it's one interval row.
2. **No integrity boundary for tenancy.** A bare `customer_id` column has
   nothing enforcing it names a real customer — the FK plus RLS policy
   (§2) is what makes isolation a database property instead of a
   convention.
3. **Conflicting values become unresolvable.** The fixture contains both
   `"enterprise"` and `"Enterprise "` for one customer. In a wide table
   there's no single row that says which is authoritative. A `customers`
   row makes it a resolvable conflict at ingest time instead of silent
   noise in every query.

**FK vs. denormalized, decided per case rather than uniformly:**

- `plan` → normalized into `customer_plans(customer_id, plan, valid_period)`
  (ADR [0002](adr/0002-plan-history-as-a-range-table.md)), because a single
  `customers.plan` column can only answer "what plan *now*," and the owner
  confirmed upgrades apply immediately while downgrades/cancellations wait
  for period end (B3) — so a customer can hold two plans within one billing
  period. `EXCLUDE USING gist (customer_id WITH =, valid_period WITH &&)`
  makes overlapping periods for one customer unrepresentable at the DDL
  level. `customers.plan` is *kept* as a deliberate denormalized cache of
  the current plan — cheap reads for the common case, with `customer_plans`
  authoritative for time-scoped billing attribution via
  `occurred_at <@ valid_period`.
- `endpoint` → **not** normalized into a lookup table (assumption S8):
  cardinality in the fixture is ~10 distinct values, so a join buys nothing
  a text column with an index doesn't already give. Named explicitly as the
  tradeoff to revisit if endpoint cardinality grows into the thousands.
- `user_email` → **not** promoted to its own `users` table (assumption S4):
  none of the three required endpoints group or filter by user, so a table
  whose only content would be an inferred `(customer_id, email)` uniqueness
  constraint adds a join with no query it serves. Stays a normalized text
  column on `usage_events`.
- `duration_ms` / `status` → promoted out of the source's nested `metadata`
  into typed columns, because they're the two fields the required
  aggregations (`SUM(duration_ms)`, status breakdowns) actually touch.
  Everything else stays in a `jsonb metadata` column, retained losslessly
  even after promotion — discarding unknown fields at ingest is
  irreversible, promoting them later isn't.

Malformed records are quarantined to `ingest_rejects` with a reason code
rather than dropped, so a bad record is a metric, not a silent gap
(`src/ingest/normalize.ts`, `src/ingest/ingestEvents.ts`).

## 2. Multi-tenancy

**Enforced at the database level via Postgres RLS**, not application
`WHERE` filtering — the spec's "isolate ... at the database level" phrasing
is explicit, and app-level filtering is discipline, not isolation: a
forgotten clause leaks the wrong tenant's rows instead of failing closed.
Full comparison against schema-per-tenant in ADR
[0001](adr/0001-row-level-security-for-tenant-isolation.md).

```sql
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events
  USING (customer_id = current_setting('app.current_customer', true));
```

applied identically to `customers` and `customer_plans` — not just the
events table, since an unpoliced `customers` table would let any connection
enumerate every tenant ID regardless of session state.

Two details that make this real rather than decorative:

- **`SET LOCAL`, not `SET`**, per request inside the query's transaction
  (`withTenant()`, `src/db/connection.ts`) — a plain `SET` on a pooled
  connection leaks tenant context to whichever request borrows that
  connection next. Covered by a `max: 1` pool test in `src/db/rls.test.ts`
  that forces connection reuse through the real code path, not a mock.
- **The API connects as a dedicated non-superuser role (`app_user`)**, never
  the Postgres superuser (ADR
  [0006](adr/0006-non-superuser-role-for-rls-enforcement.md)). Superusers
  bypass RLS entirely — `FORCE ROW LEVEL SECURITY` only restricts the table
  *owner*, not a superuser — so connecting with default credentials would
  make every isolation guarantee silently inert while a same-tenant test
  still passed for the wrong reason. This is the trap containerizing the DB
  exposed early (`docs/plan.md` Phase 0).

`/customers/top` is the one deliberately cross-tenant query. Rather than
carve an exception into the RLS policy, it runs through a second,
narrower-privileged role (`app_admin`: `NOSUPERUSER`, `BYPASSRLS`,
`SELECT`-only on exactly the three tables it reads) on a separate
connection — ADR [0007](adr/0007-admin-role-for-cross-tenant-top-query.md).
Compromise of the main `app_user` connection still can't read cross-tenant,
because `BYPASSRLS` lives only on the credential the admin route uses.

**Ingestion is the second deliberate non-RLS path (assumption T7).**
`src/ingest/ingest.ts` connects as the bootstrap superuser
(`INGEST_DATABASE_URL`), not `app_user`, and bypasses RLS unconditionally.
This isn't an oversight — both RLS policies are `USING`-only, so they apply
to `INSERT` as well as `SELECT`; a batch that writes rows for many
customers in one transaction would need `SET LOCAL app.current_customer`
re-issued per customer group to write as `app_user` at all. The superuser
connection sidesteps that at the cost of ingestion being a third role with
unrestricted access to every table — acceptable here because it's an
offline batch job with no HTTP surface, not a request handler.

**At hundreds of customers with wildly different volumes**, two things
named in ADR 0001 but deliberately not built here, given the time budget:

- **`PARTITION BY RANGE (occurred_at)`**, monthly, on `usage_events`. Query
  patterns are already date-range scoped, so partition pruning turns "scan
  everything" into "scan the months in range," and it makes retention
  (dropping old partitions) O(1) instead of a `DELETE` that has to visit
  every row.
- **A BRIN index** on `occurred_at` instead of (or alongside) the current
  B-tree, once the table is large and roughly time-ordered — much smaller
  and cheaper to maintain than a B-tree at that scale.

Schema-per-tenant was also considered and rejected — strongest isolation,
but migrations run N times and connection routing per tenant is
disproportionate for the workload here; RLS gives most of the isolation
guarantee at a fraction of the operational cost.

## 3. Operating it

**What's actually emitted today**, not aspirational — `ingest.ts` logs one
structured JSON summary per run (`src/ingest/ingest.ts`):

```json
{ "msg": "ingest run complete", "inputPath": "...", "durationMs": 842,
  "recordsRead": 500, "validRecords": 487, "rejectedRecords": 13,
  "rejectsByReason": { "missing_customer_id": 4, "invalid_duration_ms": 9 },
  "dedupedWithinRun": 6, "eventsUpserted": 481, "customersUpserted": 12,
  "rejectedPlanTransitions": 2 }
```

That covers ingest wall-clock duration, events ingested per run, reject
count broken out **by reason code**, and an approximation of dedupe hit
rate (`dedupedWithinRun` — collapses seen twice in the same file; a
cross-run redelivery that hits `ON CONFLICT ... DO UPDATE` isn't currently
counted separately, since the query doesn't report insert-vs-update per
row). It's `console.log`, not the Fastify pino logger, deliberately —
`ingest.ts` is a standalone CLI entrypoint that runs before any Fastify
instance exists (see the comment at the top of that file). Never logs the
raw record — only counts and reason codes, since the payload carries
`user_email`.

The API layer logs through Fastify's injected pino logger instead, object-
merge style rather than string templates — `app.log.warn({ err, url },
'Request failed boundary validation')` and `app.log.error({ err, url },
'Database unreachable...')` in `src/api/errorHandler.ts`, plus health-check
and shutdown events in `src/server.ts`. **Not yet instrumented: endpoint
p95 latency.** No request-timing hook is wired up — Fastify's `onRequest`/
`onResponse` lifecycle would be the place to add one (`reply.elapsedTime`
or an explicit `hrtime` delta), feeding a histogram rather than a single
number, since p95 isn't computable from an unaggregated per-request log
line alone. Named here as a real gap, not implied to exist.

**What I'd wire up to page someone, given a metrics pipeline** — none of
this is built yet; the ingest summary above is the only signal currently
emitted, and nothing consumes it (no persisted run history, no baseline to
compare a reject rate against, no runtime cross-tenant detector — the RLS
guarantee is proven by `rls.test.ts` at test time, not monitored in
production). The distinction that would drive what's below is *silently
wrong and costs money or leaks data* vs. *the design already absorbs it*:

| Signal | Response |
|---|---|
| No successful ingest run in > N hours | **Page.** Billing data going stale; every hour compounds the gap. |
| Reject rate jumps well above its trailing baseline | **Page.** Implies an upstream schema change — events silently dropped, usage under-billed, no user-visible symptom. |
| Query returns rows for a tenant other than the session's | **Page.** RLS makes this impossible by construction; firing means the policy was dropped or the app connected as a superuser. Security incident. |
| API 5xx rate or pool exhaustion | **Page.** Ordinary availability. |
| Individual malformed records | **Ticket.** Expected — that's what `ingest_rejects` is for. |
| New unrecognized `event_type` | **Ticket.** Product shipped a feature; accepted by design. |
| Slow query on the heaviest customer | **Ticket.** Known consequence of volume skew; the partitioning answer above, not a 2am problem. |

The reject table deliberately isn't itself an alarm — a non-zero reject
count is the system working as intended. It becomes one when the *rate*
moves, because that means the upstream contract changed underneath the
pipeline.

## 4. What I'd do next

In priority order, if given another day:

1. **Authentication (assumption T6).** Tenant identity currently comes from
   the URL path parameter with no auth in front of it — a trivial IDOR
   (`GET /customers/other_customer_id/usage` just works). This is the
   single biggest gap between "graded exercise" and "production service,"
   and everything else in the write-up assumes it's out of scope only
   because the spec never mentions auth. Fixing it means deriving
   `app.current_customer` from an authenticated token/session, not a
   client-supplied value.
2. **Validate against the real `usage_events.json`.** Every ingestion and
   dedupe decision here is tuned against a synthetic fixture
   (`fixtures/usage_events.sample.json`, assumption D1) generated to model
   the defects the spec *describes* — duplicates, malformed fields, mixed
   casing. The real file will have edge cases that fixture doesn't; re-run
   ingestion against it and check the reject-rate and dedupe-hit-rate
   metrics land somewhere sane before trusting the numbers.
3. **Resolve B6 (grace period vs. access-control failure)** and give
   `/customers/:id/endpoints` pagination (assumption A4). Neither is built:
   B6 needs a `customers.status` column before "event arrived after lapse"
   is even detectable, and whether that's expected (grace period) or a
   security bug is an open question I'd ask the owner in a real ticket
   before instrumenting it either way; pagination matters the moment a
   heavy customer's per-endpoint breakdown spans a year of data rather than
   the fixture's small window.
