import { getPool } from "@/lib/db"
import { requireRole } from "@/lib/auth"
import { PLANS, isPlanId } from "@/lib/plans"

export const dynamic = "force-dynamic"

export async function GET() {
  const user = await requireRole("owner", "member")
  if (user instanceof Response) return user
  const res = await getPool().query(
    `SELECT s.plan, s.status, s.created_at, s.canceled_at, t.mock_card
     FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id = $1`,
    [user.tenantId],
  )
  if (res.rows.length === 0) return Response.json({ error: "No subscription found." }, { status: 404 })
  const r = res.rows[0]
  return Response.json({
    subscription: { plan: r.plan, status: r.status, createdAt: r.created_at, canceledAt: r.canceled_at },
    mockCard: r.mock_card,
    plans: Object.values(PLANS),
  })
}

/**
 * PATCH — owner-only subscription changes:
 *   { action: "changePlan", plan }  upgrade/downgrade/reactivate
 *   { action: "cancel" }            cancel at once (records churn MRR)
 *   { action: "setCard", card }     mock-mode demo switch: good | failing
 *
 * Movement classification (the part analytics cares about):
 *   free → paid: 'new' MRR   · paid → bigger: 'expansion'
 *   paid → smaller (incl. → free): 'contraction' (→ free base 0 = churn)
 *   cancel / dunning exhaustion: 'churn'
 *   suspended/canceled → paid again: 'reactivation'
 */
export async function PATCH(req: Request) {
  const user = await requireRole("owner")
  if (user instanceof Response) return user
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: "Invalid JSON body." }, { status: 400 })
  const pool = getPool()

  if (body.action === "setCard") {
    const card = body.card === "failing" ? "failing" : "good"
    await pool.query(`UPDATE tenants SET mock_card = $1 WHERE id = $2`, [card, user.tenantId])
    return Response.json({ ok: true, mockCard: card })
  }

  const cur = await pool.query(
    `SELECT plan, status FROM subscriptions WHERE tenant_id = $1`,
    [user.tenantId],
  )
  if (cur.rows.length === 0 || !isPlanId(cur.rows[0].plan)) {
    return Response.json({ error: "No subscription found." }, { status: 404 })
  }
  const fromPlan = PLANS[cur.rows[0].plan]
  const status: string = cur.rows[0].status

  if (body.action === "cancel") {
    if (status === "canceled") return Response.json({ error: "Already canceled." }, { status: 409 })
    await pool.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = now() WHERE tenant_id = $1`,
      [user.tenantId],
    )
    if (fromPlan.baseCents > 0 && (status === "active" || status === "past_due")) {
      await pool.query(
        `INSERT INTO subscription_events (tenant_id, type, from_plan, to_plan, mrr_delta_cents)
         VALUES ($1, 'churn', $2, NULL, $3)`,
        [user.tenantId, fromPlan.id, -fromPlan.baseCents],
      )
    }
    return Response.json({ ok: true, status: "canceled" })
  }

  if (body.action === "changePlan") {
    if (!isPlanId(String(body.plan ?? ""))) {
      return Response.json({ error: "plan must be one of: free, starter, pro." }, { status: 400 })
    }
    const toPlan = PLANS[body.plan as keyof typeof PLANS]
    const wasOut = status === "suspended" || status === "canceled"
    if (!wasOut && toPlan.id === fromPlan.id) {
      return Response.json({ error: `Already on the ${toPlan.name} plan.` }, { status: 409 })
    }

    // Classify the MRR movement before flipping state.
    let type: string | null = null
    let delta = 0
    if (wasOut) {
      if (toPlan.baseCents > 0) { type = "reactivation"; delta = toPlan.baseCents }
    } else if (fromPlan.baseCents === 0 && toPlan.baseCents > 0) {
      type = "new"; delta = toPlan.baseCents
    } else if (toPlan.baseCents > fromPlan.baseCents) {
      type = "expansion"; delta = toPlan.baseCents - fromPlan.baseCents
    } else if (toPlan.baseCents < fromPlan.baseCents) {
      type = toPlan.baseCents === 0 ? "churn" : "contraction"
      delta = toPlan.baseCents === 0 ? -fromPlan.baseCents : toPlan.baseCents - fromPlan.baseCents
    }

    await pool.query(
      `UPDATE subscriptions SET plan = $1, status = 'active', canceled_at = NULL WHERE tenant_id = $2`,
      [toPlan.id, user.tenantId],
    )
    if (type) {
      await pool.query(
        `INSERT INTO subscription_events (tenant_id, type, from_plan, to_plan, mrr_delta_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.tenantId, type, fromPlan.id, toPlan.id, delta],
      )
    }
    return Response.json({ ok: true, plan: toPlan.id, movement: type })
  }

  return Response.json({ error: "Unknown action. Use changePlan, cancel, or setCard." }, { status: 400 })
}
