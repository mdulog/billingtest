import type { NormalizedEvent } from './normalize.js';

// B7: total order, lowest to highest. Invented -- see docs/assumptions.md.
export const PLAN_TIERS = ['free', 'growth', 'pro', 'enterprise'] as const;

export interface PlanInterval {
  plan: string;
  validFrom: Date;
  // null = open-ended, i.e. this is the customer's current plan.
  validTo: Date | null;
}

export interface RejectedTransition {
  fromPlan: string;
  toPlan: string;
  at: Date;
}

export interface DerivePlanHistoryResult {
  intervals: PlanInterval[];
  // Not persisted -- surfaced so the caller can log/count them. A rejected
  // transition means the running plan is unchanged, not that data was lost:
  // the source event itself is still stored on usage_events either way.
  rejectedTransitions: RejectedTransition[];
}

function tierIndex(plan: string): number {
  return PLAN_TIERS.indexOf(plan as (typeof PLAN_TIERS)[number]);
}

// S3: pure function over one customer's events, ordered by occurred_at.
// A move up the B7 ladder is a real upgrade (B3: takes effect immediately)
// and closes/opens an interval. A move down, sideways to an unrecognized
// tier, or to/from a tier this function can't place on the ladder is
// treated as dirty data (B2 forbids mid-period downgrades) and rejected --
// the running plan keeps going, the transition is reported, nothing throws.
export function derivePlanHistory(
  events: ReadonlyArray<Pick<NormalizedEvent, 'plan' | 'occurredAt'>>
): DerivePlanHistoryResult {
  // I7: null/"" means unknown -- these events carry no plan signal and are
  // skipped rather than treated as a transition to/from "no plan".
  const known = events
    .filter((event): event is { plan: string; occurredAt: Date } => event.plan !== null)
    .slice()
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const intervals: PlanInterval[] = [];
  const rejectedTransitions: RejectedTransition[] = [];

  if (known.length === 0) {
    return { intervals, rejectedTransitions };
  }

  let currentPlan = known[0]!.plan;
  let currentStart = known[0]!.occurredAt;

  for (const event of known.slice(1)) {
    if (event.plan === currentPlan) continue;

    const fromIndex = tierIndex(currentPlan);
    const toIndex = tierIndex(event.plan);
    const isRealUpgrade = fromIndex !== -1 && toIndex !== -1 && toIndex > fromIndex;

    if (isRealUpgrade) {
      intervals.push({ plan: currentPlan, validFrom: currentStart, validTo: event.occurredAt });
      currentPlan = event.plan;
      currentStart = event.occurredAt;
    } else {
      rejectedTransitions.push({ fromPlan: currentPlan, toPlan: event.plan, at: event.occurredAt });
    }
  }

  intervals.push({ plan: currentPlan, validFrom: currentStart, validTo: null });

  return { intervals, rejectedTransitions };
}
