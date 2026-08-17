import { createHash } from 'node:crypto';
import type { NormalizedEvent } from './normalize.js';

// ADR 0005 / docs/assumptions.md I2: metadata is deliberately excluded --
// a redelivery that only corrects duration_ms/status must hash to the same
// key so it's treated as a correction (ingest.ts uses ON CONFLICT ... DO
// UPDATE), not a second billable event. customer_id is excluded too: it's
// the other half of the UNIQUE (customer_id, dedupe_key) constraint this
// key feeds, so hashing it in would be redundant, not additional safety.
//
// Fields are hashed pre-normalized-value, not pre-raw-value -- "Enterprise "
// vs "enterprise" style variance must not produce different keys for what
// is otherwise the same event (S7/S9).
//
// The separator between fields is a plain ASCII space (0x20) -- this must
// match migrations/003_ingestion.ts's SQL backfill formula exactly, or a
// redelivery of a pre-existing row lands on a different key than the one
// backfilled for it and inserts a duplicate instead of updating.
const FIELD_SEPARATOR = ' ';

export function deriveDedupeKey(
  event: Pick<NormalizedEvent, 'eventType' | 'endpoint' | 'userEmail' | 'occurredAt'>
): string {
  const fields = [event.eventType, event.endpoint, event.userEmail, event.occurredAt.toISOString()];
  const identity = fields.join(FIELD_SEPARATOR);

  return createHash('sha256').update(identity).digest('hex');
}
