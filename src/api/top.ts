import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { parseDateRange, topQuerystringSchema, type TopQuerystring } from './schemas.js';

interface TopCustomerRow {
  customer_id: string;
  plan: string | null;
  event_count: string;
  total_duration_ms: string;
}

// T5/ADR 0007: the one legitimately cross-tenant endpoint. `adminDb` is the
// app_admin (BYPASSRLS, SELECT-only) connection -- deliberately not routed
// through withTenant, since there is no single tenant to scope this to.
// Ranked by event count (the volume interpretation of "usage"); plan is
// customers.plan, current standing rather than historical attribution --
// this is an admin/ops view, not a per-period billing figure (plan.md
// Phase 3).
export function registerTopCustomersRoute(app: FastifyInstance, adminDb: Kysely<Database>): void {
  app.get<{ Querystring: TopQuerystring }>(
    '/customers/top',
    { schema: { querystring: topQuerystringSchema } },
    async (request) => {
      const { from, to } = parseDateRange(request.query);
      const { limit } = request.query;

      const rows = await sql<TopCustomerRow>`
        select
          ue.customer_id as customer_id,
          c.plan as plan,
          count(*) as event_count,
          coalesce(sum(ue.duration_ms), 0) as total_duration_ms
        from usage_events ue
        left join customers c on c.id = ue.customer_id
        where ue.occurred_at >= ${from}
          and ue.occurred_at < ${to}
        group by ue.customer_id, c.plan
        order by event_count desc
        limit ${limit}
      `.execute(adminDb);

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        limit,
        customers: rows.rows.map((row) => ({
          customerId: row.customer_id,
          plan: row.plan,
          eventCount: Number(row.event_count),
          totalDurationMs: Number(row.total_duration_ms),
        })),
      };
    }
  );
}
