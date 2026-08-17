import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { withTenant } from '../db/connection.js';
import {
  customerIdParamsSchema,
  dateRangeQuerystringSchema,
  errorResponseSchema,
  parseDateRange,
  usageSummaryResponseSchema,
  type CustomerIdParams,
  type DateRangeQuerystring,
} from './schemas.js';

interface UsageByPlanRow {
  plan: string | null;
  event_count: string;
  total_duration_ms: string;
}

// docs/plan.md Phase 3: per-plan breakdown via LEFT JOIN customer_plans ON
// occurred_at <@ valid_period -- LEFT, not inner, so an event landing in a
// coverage gap (no interval covers it) still counts, surfaced under a null
// plan bucket, instead of silently vanishing from a billing report. The
// customer_id equality in the ON clause is redundant with RLS today (both
// sides of the join are already scoped to one tenant inside withTenant's
// transaction) but is what guarantees no fan-out if that ever changes, and
// the migration-002 EXCLUDE constraint is what makes "at most one plan row
// per event" true rather than assumed.
export function registerUsageSummaryRoute(app: FastifyInstance, db: Kysely<Database>): void {
  app.get<{ Params: CustomerIdParams; Querystring: DateRangeQuerystring }>(
    '/customers/:customerId/usage',
    {
      schema: {
        tags: ['usage'],
        summary: 'Per-plan usage summary for a customer',
        description:
          'Event counts and total duration_ms for one customer in [from, to), broken down by the plan in effect at each event\'s occurred_at. A `null` plan bucket means the event fell in a customer_plans coverage gap.',
        params: customerIdParamsSchema,
        querystring: dateRangeQuerystringSchema,
        response: {
          200: usageSummaryResponseSchema,
          400: errorResponseSchema,
          503: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const { customerId } = request.params;
      const { from, to } = parseDateRange(request.query);

      const rows = await withTenant(db, customerId, (trx) =>
        sql<UsageByPlanRow>`
          select
            cp.plan as plan,
            count(*) as event_count,
            coalesce(sum(ue.duration_ms), 0) as total_duration_ms
          from usage_events ue
          left join customer_plans cp
            on cp.customer_id = ue.customer_id
            and ue.occurred_at <@ cp.valid_period
          where ue.customer_id = ${customerId}
            and ue.occurred_at >= ${from}
            and ue.occurred_at < ${to}
          group by cp.plan
          order by cp.plan nulls last
        `.execute(trx)
      );

      return {
        customerId,
        from: from.toISOString(),
        to: to.toISOString(),
        byPlan: rows.rows.map((row) => ({
          plan: row.plan,
          eventCount: Number(row.event_count),
          totalDurationMs: Number(row.total_duration_ms),
        })),
      };
    }
  );
}
