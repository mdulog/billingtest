import { describe, expect, test } from 'vitest';
import { normalizeEvent } from './normalize.js';

const validRecord = {
  customer_id: 'cust_042',
  event_type: 'api_call',
  endpoint: '/v1/reports/generate',
  user_email: 'jane@acmeco.com',
  plan: 'pro',
  occurred_at: '2026-07-14T18:32:11Z',
  metadata: { duration_ms: 214, status: 'success' },
};

describe('normalizeEvent', () => {
  test('accepts a well-formed record', () => {
    const result = normalizeEvent(validRecord);

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event).toEqual({
      customerId: 'cust_042',
      eventType: 'api_call',
      endpoint: '/v1/reports/generate',
      userEmail: 'jane@acmeco.com',
      plan: 'pro',
      occurredAt: new Date('2026-07-14T18:32:11Z'),
      durationMs: 214,
      status: 'success',
      metadata: { duration_ms: 214, status: 'success' },
    });
  });

  test('rejects a record with no customer_id', () => {
    const { customer_id, ...rest } = validRecord;
    const result = normalizeEvent(rest);

    expect(result).toEqual({ valid: false, reason: 'missing_customer_id', customerId: null });
  });

  test('rejects a record with a blank customer_id', () => {
    const result = normalizeEvent({ ...validRecord, customer_id: '   ' });

    expect(result).toEqual({ valid: false, reason: 'missing_customer_id', customerId: null });
  });

  test('rejects a record with no event_type, retaining the customer_id for the reject row', () => {
    const { event_type, ...rest } = validRecord;
    const result = normalizeEvent(rest);

    expect(result).toEqual({ valid: false, reason: 'missing_event_type', customerId: 'cust_042' });
  });

  test('rejects a record with no endpoint', () => {
    const { endpoint, ...rest } = validRecord;
    const result = normalizeEvent(rest);

    expect(result).toEqual({ valid: false, reason: 'missing_endpoint', customerId: 'cust_042' });
  });

  test('rejects a record with no user_email', () => {
    const { user_email, ...rest } = validRecord;
    const result = normalizeEvent(rest);

    expect(result).toEqual({ valid: false, reason: 'missing_user_email', customerId: 'cust_042' });
  });

  test.each([
    ['a US-locale date string', '07/14/2026 6:32 PM'],
    ['a relative date string', 'yesterday'],
    ['an empty string', ''],
    ['a timezone offset instead of Z', '2026-07-14T18:32:11+05:30'],
  ])('rejects occurred_at as %s', (_label, occurred_at) => {
    const result = normalizeEvent({ ...validRecord, occurred_at });

    expect(result).toEqual({ valid: false, reason: 'invalid_occurred_at', customerId: 'cust_042' });
  });

  test('accepts a login event with no duration_ms', () => {
    const result = normalizeEvent({
      ...validRecord,
      event_type: 'login',
      endpoint: '/v1/auth/login',
      metadata: { status: 'success', mfa: true },
    });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.durationMs).toBeNull();
  });

  test('accepts an explicit duration_ms: null the same as an absent key -- both mean "no duration", not malformed', () => {
    const result = normalizeEvent({ ...validRecord, metadata: { duration_ms: null, status: 'success' } });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.durationMs).toBeNull();
  });

  test('accepts a non-login event with no duration_ms -- D6 is "e.g. login", not "only login"', () => {
    const { metadata, ...rest } = validRecord;
    const result = normalizeEvent({ ...rest, metadata: { status: 'success' } });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.durationMs).toBeNull();
  });

  test.each([
    ['a numeric string', '214'],
    ['negative', -50],
    ['absurdly large', 1_500_000_000],
    ['a boolean', true],
  ])('rejects duration_ms that is %s', (_label, duration_ms) => {
    const result = normalizeEvent({
      ...validRecord,
      metadata: { duration_ms, status: 'success' },
    });

    expect(result).toEqual({ valid: false, reason: 'invalid_duration_ms', customerId: 'cust_042' });
  });

  test('normalizes endpoint casing, whitespace, and a trailing slash', () => {
    const result = normalizeEvent({ ...validRecord, endpoint: ' /V1/Reports/Generate/ ' });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.endpoint).toBe('/v1/reports/generate');
  });

  test('normalizes user_email casing and whitespace', () => {
    const result = normalizeEvent({ ...validRecord, user_email: '  Jane@AcmeCo.com  ' });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.userEmail).toBe('jane@acmeco.com');
  });

  test.each([
    ['null', null],
    ['an empty string', ''],
  ])('normalizes plan %s to null (I7: unknown)', (_label, plan) => {
    const result = normalizeEvent({ ...validRecord, plan });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.plan).toBeNull();
  });

  test('normalizes plan casing and whitespace', () => {
    const result = normalizeEvent({ ...validRecord, plan: 'Enterprise ' });

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.plan).toBe('enterprise');
  });

  test('defaults metadata to an empty object when absent, rather than rejecting', () => {
    const { metadata, ...rest } = validRecord;
    const result = normalizeEvent(rest);

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('expected valid');
    expect(result.event.metadata).toEqual({});
    expect(result.event.durationMs).toBeNull();
    expect(result.event.status).toBeNull();
  });
});
