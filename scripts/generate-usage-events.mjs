// Generates a synthetic usage_events.json fixture matching the shape and the
// documented messiness in docs/requirements/takehome_requirements.md.
// Seeded so the fixture is reproducible: `node scripts/generate-usage-events.mjs`

import { writeFileSync } from 'node:fs';

const SEED = 20260715;
const OUTPUT_PATH = new URL('../usage_events.json', import.meta.url);

// Window the spec's sample event falls inside; keeps date-range queries meaningful.
const RANGE_START = Date.UTC(2026, 5, 1);
const RANGE_END = Date.UTC(2026, 7, 1);

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);

const pick = (items) => items[Math.floor(random() * items.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

function randomTimestamp() {
  const at = new Date(RANGE_START + random() * (RANGE_END - RANGE_START));
  return `${at.toISOString().slice(0, 19)}Z`;
}

// Volume deliberately uneven: cust_042 dwarfs cust_900, per the spec's
// "some are heavy, some barely show up".
const CUSTOMERS = [
  { id: 'cust_042', plan: 'pro', domain: 'acmeco.com', users: ['jane', 'mo', 'priya', 'devops'], volume: 420 },
  { id: 'cust_117', plan: 'enterprise', domain: 'northwind.io', users: ['sam', 'alex', 'billing', 'ops', 'reporting'], volume: 260 },
  { id: 'cust_203', plan: 'growth', domain: 'lumenpay.co', users: ['taylor', 'jordan'], volume: 95 },
  { id: 'cust_318', plan: 'pro', domain: 'harborlabs.dev', users: ['casey'], volume: 40 },
  { id: 'cust_774', plan: 'free', domain: 'tinyshop.store', users: ['owner'], volume: 12 },
  { id: 'cust_900', plan: 'free', domain: 'quietco.net', users: ['admin'], volume: 3 },
];

const ENDPOINTS_BY_TYPE = {
  api_call: [
    '/v1/reports/generate',
    '/v1/events/ingest',
    '/v1/accounts/lookup',
    '/v1/transactions/search',
    '/v1/players/segment',
  ],
  report_export: ['/v1/reports/export', '/v1/reports/schedule'],
  webhook_delivery: ['/v1/webhooks/deliver'],
  login: ['/v1/auth/login'],
};

const EVENT_TYPE_WEIGHTS = [
  ['api_call', 0.7],
  ['report_export', 0.14],
  ['webhook_delivery', 0.11],
  ['login', 0.05],
];

function weightedEventType() {
  let roll = random();
  for (const [type, weight] of EVENT_TYPE_WEIGHTS) {
    if (roll < weight) return type;
    roll -= weight;
  }
  return 'api_call';
}

// Metadata shape varies by event type on purpose — not every event carries
// duration_ms, so summing it has to tolerate absence.
function buildMetadata(eventType) {
  const failed = random() < 0.08;
  const status = failed ? pick(['error', 'timeout']) : 'success';

  switch (eventType) {
    case 'api_call':
      return { duration_ms: between(12, failed ? 9000 : 1800), status };
    case 'report_export':
      return { duration_ms: between(800, 42000), status, rows: between(50, 250000) };
    case 'webhook_delivery':
      return { duration_ms: between(20, 2400), status, attempt: failed ? between(2, 5) : 1 };
    case 'login':
      return { status, mfa: random() < 0.6 };
    default:
      return { status };
  }
}

function buildEvent(customer) {
  const eventType = weightedEventType();
  return {
    customer_id: customer.id,
    event_type: eventType,
    endpoint: pick(ENDPOINTS_BY_TYPE[eventType]),
    user_email: `${pick(customer.users)}@${customer.domain}`,
    plan: customer.plan,
    occurred_at: randomTimestamp(),
    metadata: buildMetadata(eventType),
  };
}

const events = [];
for (const customer of CUSTOMERS) {
  for (let i = 0; i < customer.volume; i += 1) {
    events.push(buildEvent(customer));
  }
}

// ---------------------------------------------------------------------------
// Messiness injection. Each block maps to a bullet in the spec's dataset notes.
// ---------------------------------------------------------------------------

const defects = [];

// 1. Exact duplicates — no event_id exists, so dedupe needs a derived key.
for (let i = 0; i < 18; i += 1) {
  defects.push(structuredClone(events[Math.floor(random() * events.length)]));
}

// 2. Near-duplicates: same event re-delivered with a different metadata blob.
//    Forces a decision on whether the dedupe key includes metadata.
for (let i = 0; i < 6; i += 1) {
  const original = events[Math.floor(random() * events.length)];
  const replay = structuredClone(original);
  replay.metadata = { ...replay.metadata, duration_ms: between(12, 1800) };
  defects.push(replay);
}

// 3. Missing customer_id — unattributable, cannot be billed to anyone.
for (let i = 0; i < 4; i += 1) {
  const orphan = buildEvent(pick(CUSTOMERS));
  delete orphan.customer_id;
  defects.push(orphan);
}

// 4. Malformed / unparseable timestamps.
for (const badTimestamp of ['2026-13-45T99:99:99Z', 'yesterday', '', '07/14/2026 6:32 PM']) {
  const event = buildEvent(pick(CUSTOMERS));
  event.occurred_at = badTimestamp;
  defects.push(event);
}

// 5. Missing occurred_at entirely.
for (let i = 0; i < 3; i += 1) {
  const event = buildEvent(pick(CUSTOMERS));
  delete event.occurred_at;
  defects.push(event);
}

// 6. duration_ms present but not a number, or nonsensical.
for (const badDuration of ['214', null, -50, 1.5e9]) {
  const event = buildEvent(CUSTOMERS[0]);
  event.event_type = 'api_call';
  event.metadata = { duration_ms: badDuration, status: 'success' };
  defects.push(event);
}

// 7. Missing metadata object entirely.
for (let i = 0; i < 5; i += 1) {
  const event = buildEvent(pick(CUSTOMERS));
  delete event.metadata;
  defects.push(event);
}

// 8. Null / blank plan on some events for a customer whose plan is known
//    from every other event — denormalization gone wrong.
for (let i = 0; i < 7; i += 1) {
  const event = buildEvent(CUSTOMERS[2]);
  event.plan = random() < 0.5 ? null : '';
  defects.push(event);
}

// 9. Conflicting plan values for one customer. Genuine ambiguity: mid-period
//    upgrade, or bad data? The ingestion has to pick a rule and own it.
for (let i = 0; i < 9; i += 1) {
  const event = buildEvent(CUSTOMERS[1]);
  event.plan = 'Enterprise ';
  defects.push(event);
}

// 10. Casing / whitespace drift on fields used as grouping keys.
for (let i = 0; i < 8; i += 1) {
  const event = buildEvent(CUSTOMERS[0]);
  event.endpoint = pick(['/V1/Reports/Generate', '/v1/reports/generate/', ' /v1/events/ingest']);
  defects.push(event);
}

// 11. Malformed email — matters if users get their own table.
for (const badEmail of ['not-an-email', '', 'jane@', '  Jane@AcmeCo.com  ']) {
  const event = buildEvent(CUSTOMERS[0]);
  event.user_email = badEmail;
  defects.push(event);
}

// 12. Unknown event type not covered by the known set.
for (let i = 0; i < 3; i += 1) {
  const event = buildEvent(pick(CUSTOMERS));
  event.event_type = 'quota_check';
  event.endpoint = '/v1/quota';
  defects.push(event);
}

events.push(...defects);

// Interleave: customers must not arrive grouped or time-ordered.
for (let i = events.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [events[i], events[j]] = [events[j], events[i]];
}

writeFileSync(OUTPUT_PATH, `${JSON.stringify(events, null, 2)}\n`);

console.log(`Wrote ${events.length} events (${defects.length} deliberately defective) to usage_events.json`);
