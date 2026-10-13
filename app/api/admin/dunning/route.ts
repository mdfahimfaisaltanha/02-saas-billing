import { getPool } from "@/lib/db"
import { requireRole } from "@/lib/auth"
import { runDunning } from "@/lib/billing"
import { MAX_ATTEMPTS } from "@/lib/dunning"

export const dynamic = "force-dynamic"

/** GET — the dunning queue: every past_due invoice and where it is in the retry ladder. */
export async function GET() {
  const user = await requireRole("platform")
  if (user instanceof Response) return user
  const res = await getPool().query(
    `SELECT i.id, t.name AS "tenantName", i.period, i.total_cents AS "totalCents",
            i.attempt_count AS "attemptCount", i.next_retry_at AS "nextRetryAt",
            i.next_retry_at <= now() AS "dueNow",
            (SELECT pa.error FROM payment_attempts pa WHERE pa.invoice_id = i.id
             ORDER BY pa.created_at DESC LIMIT 1) AS "lastError"
     FROM invoices i JOIN tenants t ON t.id = i.tenant_id
     WHERE i.status = 'past_due'
     ORDER BY i.next_retry_at ASC NULLS LAST`,
  )
  return Response.json({ queue: res.rows, maxAttempts: MAX_ATTEMPTS })
}

/**
 * POST — run a dunning cycle now (charges every retry that is due).
 * In production this is a daily cron job; a button keeps the demo in control
 * of the clock.
 */
export async function POST() {
  const user = await requireRole("platform")
  if (user instanceof Response) return user
  const result = await runDunning()
  return Response.json(result)
}
