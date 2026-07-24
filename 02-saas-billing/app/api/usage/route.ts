import { getPool } from "@/lib/db"
import { requireRole } from "@/lib/auth"
import { hashApiKey } from "@/lib/apikeys"
import { PLANS, isPlanId, overageCents } from "@/lib/plans"

export const dynamic = "force-dynamic"

/**
 * POST /api/usage — the metered ingestion endpoint customers call from their
 * own systems. Authenticated by tenant API key (x-api-key header), NOT by
 * session: this is machine-to-machine.
 *
 * Body: { quantity: number, idempotencyKey?: string }
 * Send the same idempotencyKey twice and the second write is a no-op —
 * usage that bills money must tolerate client retries.
 */
export async function POST(req: Request) {
  const key = req.headers.get("x-api-key")
  if (!key) return Response.json({ error: "Missing x-api-key header." }, { status: 401 })
  const pool = getPool()
  const tenant = await pool.query(
    `SELECT t.id, s.status FROM tenants t
     JOIN subscriptions s ON s.tenant_id = t.id
     WHERE t.api_key_hash = $1`,
    [hashApiKey(key)],
  )
  if (tenant.rows.length === 0) {
    return Response.json({ error: "Invalid API key." }, { status: 401 })
  }
  if (tenant.rows[0].status === "suspended" || tenant.rows[0].status === "canceled") {
    // Suspension has to actually cut service off, or dunning has no teeth.
    return Response.json({ error: `Subscription is ${tenant.rows[0].status}. Update billing to restore access.` }, { status: 402 })
  }

  const body = await req.json().catch(() => null)
  const quantity = Number(body?.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    return Response.json({ error: "quantity must be an integer between 1 and 1,000,000." }, { status: 400 })
  }
  const idem = body?.idempotencyKey ? String(body.idempotencyKey).slice(0, 100) : null

  const inserted = await pool.query(
    `INSERT INTO usage_events (tenant_id, quantity, idempotency_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [tenant.rows[0].id, quantity, idem],
  )
  const duplicate = idem !== null && inserted.rows.length === 0
  return Response.json({ recorded: !duplicate, duplicate }, { status: duplicate ? 200 : 201 })
}

/** GET /api/usage — current-period usage + projected invoice for the session's tenant. */
export async function GET() {
  const user = await requireRole("owner", "member")
  if (user instanceof Response) return user
  const pool = getPool()
  const res = await pool.query(
    `SELECT s.plan, s.status,
            COALESCE((SELECT SUM(u.quantity)::int FROM usage_events u
                      WHERE u.tenant_id = s.tenant_id
                        AND to_char(u.recorded_at, 'YYYY-MM') = to_char(now(), 'YYYY-MM')), 0) AS used_events
     FROM subscriptions s WHERE s.tenant_id = $1`,
    [user.tenantId],
  )
  if (res.rows.length === 0 || !isPlanId(res.rows[0].plan)) {
    return Response.json({ error: "No subscription found." }, { status: 404 })
  }
  const plan = PLANS[res.rows[0].plan]
  const used = res.rows[0].used_events
  return Response.json({
    plan: plan.id,
    subscriptionStatus: res.rows[0].status,
    period: new Date().toISOString().slice(0, 7),
    usedEvents: used,
    includedEvents: plan.includedEvents,
    projectedOverageCents: overageCents(plan, used),
    projectedTotalCents: plan.baseCents + overageCents(plan, used),
  })
}
