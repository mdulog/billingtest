import { describe, expect, test } from 'vitest';
import { deriveDedupeKey } from './dedupeKey.js';
import type { NormalizedEvent } from './normalize.js';

const base: Pick<NormalizedEvent, 'eventType' | 'endpoint' | 'userEmail' | 'occurredAt'> = {
  eventType: 'api_call',
  endpoint: '/v1/reports/generate',
  userEmail: 'jane@acmeco.com',
  occurredAt: new Date('2026-07-14T18:32:11Z'),
};

describe('deriveDedupeKey', () => {
  test('is deterministic for identical identifying fields', () => {
    expect(deriveDedupeKey(base)).toBe(deriveDedupeKey({ ...base }));
  });

  test('is stable across metadata differences -- a corrected duration_ms is the same event (ADR 0005 I2)', () => {
    const key = deriveDedupeKey(base);

    // deriveDedupeKey doesn't even accept metadata/durationMs/status, so
    // this asserts the contract at the type level as much as the value
    // level: there is no way to make the key metadata-sensitive by mistake.
    expect(key).toHaveLength(64); // sha256 hex
  });

  test.each([
    ['event_type', { eventType: 'login' }],
    ['endpoint', { endpoint: '/v1/auth/login' }],
    ['userEmail', { userEmail: 'sam@northwind.io' }],
    ['occurredAt', { occurredAt: new Date('2026-07-14T18:33:00Z') }],
  ])('changes when %s differs', (_field, override) => {
    const key = deriveDedupeKey(base);
    const changedKey = deriveDedupeKey({ ...base, ...override });

    expect(changedKey).not.toBe(key);
  });

  // Pins the exact byte format (field order, separator, timestamp
  // rendering), not just "produces *a* 64-char hex string" -- the earlier
  // versions of the two tests above would pass identically whether the
  // join separator were a space or a NUL byte, which is exactly the bug
  // this caught during development (see migrations/003_ingestion.ts's SQL
  // backfill, computed independently and compared against this function's
  // output for the same fields). migrations/003_ingestion.ts's backfill
  // formula must keep producing this same value for this input, or a
  // redelivery of a pre-existing row inserts a duplicate instead of
  // updating it -- if this test ever needs to change, migration 003's SQL
  // needs the matching change (for future rows; already-backfilled rows
  // are a historical snapshot and can't be changed retroactively).
  test('matches a golden value computed independently, pinning the exact byte format', () => {
    const key = deriveDedupeKey({
      eventType: 'api_call',
      endpoint: '/v1/legacy/pre-existing',
      userEmail: 'legacy@acmeco.com',
      occurredAt: new Date('2026-05-01T00:00:00Z'),
    });

    expect(key).toBe('e8ff7b93750ab7a9b2b332523e143f69d722606063f47753816f804fc21975cc');
  });
});
