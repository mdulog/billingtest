// Fastify per-route JSON Schema (ADR 0003/P7) -- boundary validation is
// declarative here rather than hand-rolled in each handler. Handlers still
// do the one check schema can't express: from < to (see rangeSchema below).

export const customerIdParamsSchema = {
  type: 'object',
  required: ['customerId'],
  properties: {
    customerId: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

// A1/A2: from/to are required, ISO date-time, half-open [from, to).
export const dateRangeQuerystringSchema = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 100;

export const topQuerystringSchema = {
  type: 'object',
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    // A4: bounded rather than unbounded -- this is the one endpoint whose
    // result set scales with customer count, not one tenant's event volume.
    limit: { type: 'integer', minimum: 1, maximum: MAX_TOP_LIMIT, default: DEFAULT_TOP_LIMIT },
  },
  additionalProperties: false,
} as const;

export interface DateRangeQuerystring {
  from: string;
  to: string;
}

export interface TopQuerystring extends DateRangeQuerystring {
  limit: number;
}

export interface CustomerIdParams {
  customerId: string;
}

// Shared by every handler that takes from/to -- schema guarantees they
// parse as dates, not that from precedes to.
export function parseDateRange(query: DateRangeQuerystring): { from: Date; to: Date } {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (from >= to) {
    throw new RangeValidationError('`from` must be strictly before `to`');
  }
  return { from, to };
}

export class RangeValidationError extends Error {}
