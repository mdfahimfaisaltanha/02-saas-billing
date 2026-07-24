import { getPool } from "@/lib/db"
import { requireRole } from "@/lib/auth"
import { chargeInvoice, generateInvoices } from "@/lib/billing"

export const dynamic = "force-dynamic"

const INVOICE_SELECT = `
  SELECT i.id, i.tenant_id AS "tenantId", t.name AS "tenantName", i.period, i.plan,
         i.base_cents AS "baseCents", i.included_events AS "includedEvents",
         i.used_events AS "usedEvents", i.overage_cents AS "overageCents",
         i.total_cents AS "totalCents", i.status, i.attempt_count AS "attemptCount",
         i.next_retry_at AS "nextRetryAt", i.paid_at AS "paidAt", i.created_at AS "createdAt",
         (SELECT pa.error FROM payment_attempts pa WHERE pa.invoice_id = i.id
          ORDER BY pa.created_at DESC LIMIT 1) AS "lastError"
  FROM invoices i JOIN tenants t ON t.id = i.tenant_id`

export async function GET() {
  const user = await requireRole("owner", "member", "platform")
  if (user instanceof Response) return user
  const pool = getPool()
  const res =
    user.role === "platform"
      ? await pool.query(`${INVOICE_SELECT} ORDER BY i.period DESC, t.name ASC LIMIT 200`)
      : await pool.query(`${INVOICE_SELECT} WHERE i.tenant_id = $1 ORDER BY i.period DESC`, [user.tenantId])
  return Response.json({ invoices: res.rows })
}

/**
 * POST:
 *   { action: "generate", period }  platform — idempotent invoice run for YYYY-MM
 *   { action: "pay", invoiceId }    owner (own tenant) or platform — charge now
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: "Invalid JSON body." }, { status: 400 })

  if (body.action === "generate") {
    const user = await requireRole("platform")
    if (user instanceof Response) return user
    const period = String(body.period ?? "").trim()
    try {
      const result = await generateInvoices(period)
      return Response.json(result)
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed." }, { status: 400 })
    }
  }

  if (body.action === "pay") {
    const user = await requireRole("owner", "platform")
    if (user instanceof Response) return user
    const invoiceId = Number(body.invoiceId)
    if (!Number.isInteger(invoiceId)) {
      return Response.json({ error: "invoiceId must be an integer." }, { status: 400 })
    }
    if (user.role !== "platform") {
      // Tenant isolation: owners can only pay their own invoices.
      const own = await getPool().query(
        `SELECT 1 FROM invoices WHERE id = $1 AND tenant_id = $2`,
        [invoiceId, user.tenantId],
      )
      if (own.rows.length === 0) return Response.json({ error: "Invoice not found." }, { status: 404 })
    }
    const outcome = await chargeInvoice(invoiceId)
    return Response.json(outcome, { status: outcome.succeeded ? 200 : 402 })
  }

  return Response.json({ error: "Unknown action. Use generate or pay." }, { status: 400 })
}
