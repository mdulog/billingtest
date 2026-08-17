import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { withTenant } from '../db/connection.js';
import {
  customerIdParamsSchema,
  dateRangeQuerystringSchema,
  parseDateRange,
  type CustomerIdParams,
  type DateRangeQuerystring,
} from './schemas.js';

interface EndpointUsageRow {
  endpoint: string;
  event_count: string;
  total_duration_ms: string;
}

// docs/plan.md Phase 3: per-endpoint breakdown for one customer.
// customer_id is filtered explicitly even though RLS (inside withTenant's
// transaction) already scopes it -- see the identical note in usage.ts.
export function registerEndpointsRoute(app: FastifyInstance, db: Kysely<Database>): void {
  app.get<{ Params: CustomerIdParams; Querystring: DateRangeQuerystring }>(
    '/customers/:customerId/endpoints',
    { schema: { params: customerIdParamsSchema, querystring: dateRangeQuerystringSchema } },
    async (request) => {
      const { customerId } = request.params;
      const { from, to } = parseDateRange(request.query);

      const rows = await withTenant(db, customerId, (trx) =>
        sql<EndpointUsageRow>`
          select
            endpoint,
            count(*) as event_count,
            coalesce(sum(duration_ms), 0) as total_duration_ms
          from usage_events
          where customer_id = ${customerId}
            and occurred_at >= ${from}
            and occurred_at < ${to}
          group by endpoint
          order by event_count desc
        `.execute(trx)
      );

      return {
        customerId,
        from: from.toISOString(),
        to: to.toISOString(),
        endpoints: rows.rows.map((row) => ({
          endpoint: row.endpoint,
          eventCount: Number(row.event_count),
          totalDurationMs: Number(row.total_duration_ms),
        })),
      };
    }
  );
}
