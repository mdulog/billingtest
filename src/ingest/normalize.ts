// Pure validation/normalization over one raw record from usage_events.json.
// No DB, no I/O -- unit-testable directly (docs/plan.md Phase 4).

// D3: ISO-8601 UTC, second granularity, Z suffix. Anything else (a locale
// string, "yesterday", an empty string) is a format the source never
// promised and gets rejected rather than guessed at.
const OCCURRED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// I8: duration_ms must be a non-negative integer under a sane ceiling.
// 24h in ms -- generous for any single event in this domain (the fixture's
// legitimate durations top out under a minute; its malformed outlier is
// ~17 days), so this catches unit errors (seconds mistaken for ms) without
// being tuned to the fixture's specific numbers.
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export type RejectReason =
  | 'missing_customer_id'
  | 'missing_event_type'
  | 'missing_endpoint'
  | 'missing_user_email'
  | 'invalid_occurred_at'
  | 'invalid_duration_ms';

export interface NormalizedEvent {
  customerId: string;
  eventType: string;
  endpoint: string;
  userEmail: string;
  // I7: null and "" both mean "unknown" -- normalized to null here.
  plan: string | null;
  occurredAt: Date;
  // D6/I8: absent is a legitimate value distinct from malformed.
  durationMs: number | null;
  status: string | null;
  metadata: Record<string, unknown>;
}

export type NormalizeResult =
  | { valid: true; event: NormalizedEvent }
  | { valid: false; reason: RejectReason; customerId: string | null };

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// S7: lowercased, trimmed, trailing slash stripped.
function normalizeEndpoint(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  return lowered.length > 1 && lowered.endsWith('/') ? lowered.slice(0, -1) : lowered;
}

// S9: lower + trim, collapsing case/whitespace variants of one identity.
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Same treatment as endpoint/email -- "Enterprise " and "enterprise" must
// compare equal for both storage and the B7 tier ladder in planHistory.ts.
function normalizePlan(raw: unknown): string | null {
  const value = nonEmptyString(raw);
  return value === null ? null : value.toLowerCase();
}

function parseOccurredAt(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !OCCURRED_AT_PATTERN.test(raw)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDurationMs(metadata: Record<string, unknown>): { ok: true; value: number | null } | { ok: false } {
  const value = metadata.duration_ms;
  // Absent key and explicit JSON null both mean "no duration recorded" --
  // D6's trap applies equally to either serialization. Only a present,
  // wrong-typed/out-of-range value is malformed.
  if (value === undefined || value === null) return { ok: true, value: null };
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_DURATION_MS
  ) {
    return { ok: false };
  }
  return { ok: true, value };
}

export function normalizeEvent(raw: unknown): NormalizeResult {
  const record = (raw ?? {}) as Record<string, unknown>;

  // I6: unbillable and always rejected -- checked first since nothing else
  // about the record matters if it can't be attributed to a customer.
  const customerId = nonEmptyString(record.customer_id);
  if (customerId === null) {
    return { valid: false, reason: 'missing_customer_id', customerId: null };
  }

  const eventType = nonEmptyString(record.event_type);
  if (eventType === null) {
    return { valid: false, reason: 'missing_event_type', customerId };
  }

  const rawEndpoint = nonEmptyString(record.endpoint);
  if (rawEndpoint === null) {
    return { valid: false, reason: 'missing_endpoint', customerId };
  }

  const rawEmail = nonEmptyString(record.user_email);
  if (rawEmail === null) {
    return { valid: false, reason: 'missing_user_email', customerId };
  }

  const occurredAt = parseOccurredAt(record.occurred_at);
  if (occurredAt === null) {
    return { valid: false, reason: 'invalid_occurred_at', customerId };
  }

  // D5: metadata's shape varies by event_type and isn't guaranteed present.
  // Absence isn't malformed -- it just means no duration_ms/status to read.
  const metadata =
    typeof record.metadata === 'object' && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : {};

  const duration = parseDurationMs(metadata);
  if (!duration.ok) {
    return { valid: false, reason: 'invalid_duration_ms', customerId };
  }

  const status = typeof metadata.status === 'string' ? metadata.status : null;

  return {
    valid: true,
    event: {
      customerId,
      eventType,
      endpoint: normalizeEndpoint(rawEndpoint),
      userEmail: normalizeEmail(rawEmail),
      plan: normalizePlan(record.plan),
      occurredAt,
      durationMs: duration.value,
      status,
      metadata,
    },
  };
}
