import { getPool } from "./db"
import { PLANS, isPlanId, type PlanId } from "./plans"
import type { MrrMetrics } from "./types"

/**
 * MRR & churn analytics.
 *
 * Definitions (stated explicitly — every SaaS argues about these):
 *   - MRR = sum of base plan fees for subscriptions in status active or
 *     past_due. Past_due still counts: dunning exists to save that revenue,
 *     and Stripe/ChartMogul count it the same way until final failure.
 *   - Metered overage is EXCLUDED from MRR — it's usage revenue, not
 *     committed recurring revenue.
 *   - Movements come from subscription_events, each carrying an MRR delta:
 *       new (+base), expansion (+diff), contraction (-diff),
 *       churn (-base), reactivation (+base)
 *   - Monthly churn rate = churned MRR in month / MRR at month start.
 */

export async function computeMetrics(): Promise<MrrMetrics> {
  const pool = getPool()

  const current = await pool.query(
    `SELECT plan, status, COUNT(*)::int AS tenant_count
     FROM subscriptions WHERE status IN ('active', 'past_due')
     GROUP BY plan, status`,
  )
  let mrrCents = 0
  let activeTenants = 0
  let pastDueTenants = 0
  const perPlanMap = new Map<PlanId, { tenants: number; mrrCents: number }>()
  for (const row of current.rows) {
    if (!isPlanId(row.plan)) continue
    const base = PLANS[row.plan].baseCents
    mrrCents += base * row.tenant_count
    if (row.status === "active") activeTenants += row.tenant_count
    else pastDueTenants += row.tenant_count
    const agg = perPlanMap.get(row.plan) ?? { tenants: 0, mrrCents: 0 }
    agg.tenants += row.tenant_count
    agg.mrrCents += base * row.tenant_count
    perPlanMap.set(row.plan, agg)
  }

  // Monthly movement history, replayed cumulatively so each month gets an
  // ending MRR and a churn rate against its starting MRR.
  const events = await pool.query(
    `SELECT to_char(occurred_at, 'YYYY-MM') AS month, type, SUM(mrr_delta_cents)::int AS delta
     FROM subscription_events
     GROUP BY 1, 2
     ORDER BY 1 ASC`,
  )
  const byMonth = new Map<string, Record<string, number>>()
  for (const row of events.rows) {
    const m = byMonth.get(row.month) ?? {}
    m[row.type] = (m[row.type] ?? 0) + row.delta
    byMonth.set(row.month, m)
  }

  let running = 0
  const months: MrrMetrics["months"] = []
  for (const [month, deltas] of Array.from(byMonth.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const starting = running
    const newCents = deltas["new"] ?? 0
    const expansionCents = deltas["expansion"] ?? 0
    const contractionCents = deltas["contraction"] ?? 0 // negative
    const churnCents = deltas["churn"] ?? 0 // negative
    const reactivationCents = deltas["reactivation"] ?? 0
    const netCents = newCents + expansionCents + contractionCents + churnCents + reactivationCents
    running += netCents
    months.push({
      month,
      newCents: newCents + reactivationCents,
      expansionCents,
      contractionCents,
      churnCents,
      netCents,
      endingMrrCents: running,
      churnRatePct: starting > 0 ? Math.round((-churnCents / starting) * 1000) / 10 : null,
    })
  }

  return {
    mrrCents,
    activeTenants,
    pastDueTenants,
    perPlan: Array.from(perPlanMap.entries()).map(([plan, agg]) => ({ plan, ...agg })),
    months,
  }
}
