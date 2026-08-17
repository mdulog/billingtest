import { describe, expect, test } from 'vitest';
import { derivePlanHistory } from './planHistory.js';

function event(plan: string | null, occurredAt: string) {
  return { plan, occurredAt: new Date(occurredAt) };
}

describe('derivePlanHistory', () => {
  test('single plan throughout produces one unbounded interval', () => {
    const result = derivePlanHistory([
      event('pro', '2026-06-01T00:00:00Z'),
      event('pro', '2026-06-15T00:00:00Z'),
      event('pro', '2026-06-30T00:00:00Z'),
    ]);

    expect(result.intervals).toEqual([
      { plan: 'pro', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: null },
    ]);
    expect(result.rejectedTransitions).toEqual([]);
  });

  test('a mid-period upgrade closes the current interval and opens a new one, abutting', () => {
    const result = derivePlanHistory([
      event('pro', '2026-06-01T00:00:00Z'),
      event('pro', '2026-06-14T00:00:00Z'),
      event('enterprise', '2026-06-15T00:00:00Z'),
      event('enterprise', '2026-06-20T00:00:00Z'),
    ]);

    expect(result.intervals).toEqual([
      { plan: 'pro', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: new Date('2026-06-15T00:00:00Z') },
      { plan: 'enterprise', validFrom: new Date('2026-06-15T00:00:00Z'), validTo: null },
    ]);
    expect(result.rejectedTransitions).toEqual([]);
  });

  test('a mid-period downgrade is rejected as dirty data -- one interval, running plan unchanged (B2/S3)', () => {
    const result = derivePlanHistory([
      event('enterprise', '2026-06-01T00:00:00Z'),
      event('pro', '2026-06-15T00:00:00Z'),
      event('enterprise', '2026-06-20T00:00:00Z'),
    ]);

    expect(result.intervals).toEqual([
      { plan: 'enterprise', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: null },
    ]);
    expect(result.rejectedTransitions).toEqual([
      { fromPlan: 'enterprise', toPlan: 'pro', at: new Date('2026-06-15T00:00:00Z') },
    ]);
  });

  test('casing/whitespace variants of the same tier do not produce a transition', () => {
    // normalizeEvent() already lowercases/trims plan (S7/S9-style); feeding
    // already-normalized values here isolates derivePlanHistory's own logic.
    const result = derivePlanHistory([
      event('enterprise', '2026-06-01T00:00:00Z'),
      event('enterprise', '2026-06-15T00:00:00Z'),
    ]);

    expect(result.intervals).toHaveLength(1);
    expect(result.rejectedTransitions).toEqual([]);
  });

  test('events with an unrecognized plan value do not participate as a known tier -- transition rejected, not thrown', () => {
    const result = derivePlanHistory([
      event('pro', '2026-06-01T00:00:00Z'),
      event('legacy_tier', '2026-06-15T00:00:00Z'),
    ]);

    expect(result.intervals).toEqual([
      { plan: 'pro', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: null },
    ]);
    expect(result.rejectedTransitions).toEqual([
      { fromPlan: 'pro', toPlan: 'legacy_tier', at: new Date('2026-06-15T00:00:00Z') },
    ]);
  });

  test('events with a null plan (I7: unknown) carry no signal and are skipped', () => {
    const result = derivePlanHistory([
      event(null, '2026-05-01T00:00:00Z'),
      event('pro', '2026-06-01T00:00:00Z'),
      event(null, '2026-06-10T00:00:00Z'),
    ]);

    expect(result.intervals).toEqual([
      { plan: 'pro', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: null },
    ]);
  });

  test('out-of-order input is sorted by occurred_at before walking', () => {
    const result = derivePlanHistory([
      event('enterprise', '2026-06-15T00:00:00Z'),
      event('pro', '2026-06-01T00:00:00Z'),
    ]);

    expect(result.intervals).toEqual([
      { plan: 'pro', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: new Date('2026-06-15T00:00:00Z') },
      { plan: 'enterprise', validFrom: new Date('2026-06-15T00:00:00Z'), validTo: null },
    ]);
  });

  test('no events at all produces no intervals', () => {
    const result = derivePlanHistory([]);

    expect(result).toEqual({ intervals: [], rejectedTransitions: [] });
  });

  test('the worked example: 100 events under pro, an upgrade, 200 under enterprise', () => {
    const events = [
      ...Array.from({ length: 100 }, (_, i) => event('pro', `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}Z`)),
      ...Array.from({ length: 200 }, (_, i) => event('enterprise', `2026-06-15T00:01:${String(i % 60).padStart(2, '0')}Z`)),
    ];

    const result = derivePlanHistory(events);

    expect(result.intervals).toEqual([
      { plan: 'pro', validFrom: new Date('2026-06-01T00:00:00Z'), validTo: new Date('2026-06-15T00:01:00Z') },
      { plan: 'enterprise', validFrom: new Date('2026-06-15T00:01:00Z'), validTo: null },
    ]);
  });
});
