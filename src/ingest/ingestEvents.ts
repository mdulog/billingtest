import { Kysely, sql } from 'kysely';
import type { Database } from '../db/types.js';
import { normalizeEvent, type NormalizedEvent, type RejectReason } from './normalize.js';
import { deriveDedupeKey } from './dedupeKey.js';
import { derivePlanHistory } from './planHistory.js';

export interface IngestSummary {
  recordsRead: number;
  validRecords: number;
  rejectedRecords: number;
  rejectsByReason: Record<string, number>;
  // Records that normalized fine but collapsed onto an already-seen
  // (customerId, dedupeKey) pair within this run -- distinct from a
  // conflict against a row already in the database from a prior run.
  dedupedWithinRun: number;
  eventsUpserted: number;
  customersUpserted: number;
  rejectedPlanTransitions: number;
}

interface RejectedRecord {
  customerId: string | null;
  reason: RejectReason;
  raw: unknown;
}

type DedupedEvent = NormalizedEvent & { dedupeKey: string };

// Purely an in-memory grouping key for the Map below -- never persisted,
// never compared against anything outside this function, so it just needs
// to be a stable, collision-free join of the two identifying values.
const DEDUPE_MAP_KEY_SEPARATOR = '#';

function groupByCustomer(events: readonly DedupedEvent[]): Map<string, DedupedEvent[]> {
  const groups = new Map<string, DedupedEvent[]>();
  for (const event of events) {
    const existing = groups.get(event.customerId);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(event.customerId, [event]);
    }
  }
  return groups;
}

// The pure-orchestration core: takes raw records already parsed from JSON
// (so it's testable without a file on disk) and a DB handle, runs the
// whole batch in one transaction (docs/assumptions.md I4). Connects as
// whatever role `db` was constructed with -- see ingest.ts and
// docs/assumptions.md T7: this must be the superuser/owner bootstrap role,
// the same one migrate.ts uses, because it writes rows for many customers
// in one run and both RLS policies are USING-only (apply to INSERT too).
export async function ingestEvents(rawRecords: unknown[], db: Kysely<Database>): Promise<IngestSummary> {
  const rejects: RejectedRecord[] = [];
  // Last-write-wins within a run, same semantics as ON CONFLICT ... DO
  // UPDATE across runs (ADR 0005 I2) -- keyed identically so a within-run
  // duplicate and a cross-run redelivery are handled by one rule, not two.
  const deduped = new Map<string, DedupedEvent>();

  for (const record of rawRecords) {
    const result = normalizeEvent(record);
    if (!result.valid) {
      rejects.push({ customerId: result.customerId, reason: result.reason, raw: record });
      continue;
    }
    const dedupeKey = deriveDedupeKey(result.event);
    const mapKey = [result.event.customerId, dedupeKey].join(DEDUPE_MAP_KEY_SEPARATOR);
    deduped.set(mapKey, { ...result.event, dedupeKey });
  }

  const events = [...deduped.values()];
  const eventsByCustomer = groupByCustomer(events);
  let rejectedPlanTransitions = 0;

  await db.transaction().execute(async (trx) => {
    for (const [customerId, customerEvents] of eventsByCustomer) {
      const { intervals, rejectedTransitions } = derivePlanHistory(customerEvents);
      rejectedPlanTransitions += rejectedTransitions.length;
      const currentPlan = intervals.at(-1)?.plan ?? null;

      await trx
        .insertInto('customers')
        .values({ id: customerId, plan: currentPlan })
        .onConflict((oc) => oc.column('id').doUpdateSet({ plan: currentPlan }))
        .execute();

      // Recomputed from the full event history every run rather than
      // diffed incrementally -- simplest way to keep customer_plans
      // idempotent across reruns without a second identity scheme for
      // intervals. Cost: a customer's plan-history rows are always fully
      // replaced, not patched. Fine at this scale (one DELETE + a handful
      // of INSERTs per customer, inside the same transaction).
      await trx.deleteFrom('customer_plans').where('customer_id', '=', customerId).execute();
      for (const interval of intervals) {
        await sql`
          insert into customer_plans (customer_id, plan, valid_period)
          values (${customerId}, ${interval.plan}, tstzrange(${interval.validFrom}, ${interval.validTo}, '[)'))
        `.execute(trx);
      }
    }

    if (events.length > 0) {
      await trx
        .insertInto('usage_events')
        .values(
          events.map((event) => ({
            customer_id: event.customerId,
            event_type: event.eventType,
            endpoint: event.endpoint,
            user_email: event.userEmail,
            duration_ms: event.durationMs,
            status: event.status,
            occurred_at: event.occurredAt,
            metadata: JSON.stringify(event.metadata),
            dedupe_key: event.dedupeKey,
          }))
        )
        .onConflict((oc) =>
          oc.columns(['customer_id', 'dedupe_key']).doUpdateSet((eb) => ({
            duration_ms: eb.ref('excluded.duration_ms'),
            status: eb.ref('excluded.status'),
            metadata: eb.ref('excluded.metadata'),
          }))
        )
        .execute();
    }

    if (rejects.length > 0) {
      await trx
        .insertInto('ingest_rejects')
        .values(
          rejects.map((reject) => ({
            customer_id: reject.customerId,
            reason: reject.reason,
            raw_event: JSON.stringify(reject.raw),
          }))
        )
        .execute();
    }
  });

  const rejectsByReason: Record<string, number> = {};
  for (const reject of rejects) {
    rejectsByReason[reject.reason] = (rejectsByReason[reject.reason] ?? 0) + 1;
  }

  return {
    recordsRead: rawRecords.length,
    validRecords: rawRecords.length - rejects.length,
    rejectedRecords: rejects.length,
    rejectsByReason,
    dedupedWithinRun: rawRecords.length - rejects.length - events.length,
    eventsUpserted: events.length,
    customersUpserted: eventsByCustomer.size,
    rejectedPlanTransitions,
  };
}
