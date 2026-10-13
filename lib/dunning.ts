import { getPool } from "./db"
import { PLANS, isPlanId } from "./plans"

/**
 * Dunning: what happens after a payment fails.
 *
 * Retry schedule (industry-typical smart-retry cadence, compressed):
 *   attempt 1  = the initial charge
 *   attempt 2  = +1 day
 *   attempt 3  = +3 days
 *   attempt 4  = +7 days   (final)
 *
 * State effects:
 *   failure (attempts left)  → invoice past_due, next_retry_at set,
 *                              subscription past_due (still counted in MRR —
 *                              dunning exists to SAVE the revenue)
 *   failure (exhausted)      → invoice failed, subscription suspended,
 *                              churn event recorded with -MRR delta
 *   success (any attempt)    → invoice paid, subscription re-activated,
 *                              retry cleared
 *
 * This module only mutates state — it never charges. Charging lives in
 * lib/billing.ts (runDunning), which calls back into these transitions via
 * webhook events, exactly like Stripe's invoice.payment_failed flow.
 */

export const RETRY_OFFSETS_DAYS = [1, 3, 7]
export const MAX_ATTEMPTS = 1 + RETRY_OFFSETS_DAYS.length

export async function applySuccess(invoiceId: number, ref: string | null): Promise<void> {
  const pool = getPool()
  const res = await pool.query(
    `UPDATE invoices SET status = 'paid', paid_at = now(), next_retry_at = NULL
     WHERE id = $1 AND status IN ('pending', 'past_due') RETURNING tenant_id`,
    [invoiceId],
  )
  if (res.rows.length === 0) return // already paid/void — idempotent no-op
  // A successful payment rescues a past_due subscription.
  await pool.query(
    `UPDATE subscriptions SET status = 'active' WHERE tenant_id = $1 AND status = 'past_due'`,
    [res.rows[0].tenant_id],
  )
  void ref
}

export async function applyFailure(invoiceId: number, error: string | null): Promise<void> {
  const pool = getPool()
  const res = await pool.query(
    `SELECT id, tenant_id, plan, attempt_count, status FROM invoices WHERE id = $1`,
    [invoiceId],
  )
  if (res.rows.length === 0) return
  const inv = res.rows[0]
  if (["paid", "void", "failed"].includes(inv.status)) return // idempotent no-op

  if (inv.attempt_count >= MAX_ATTEMPTS) {
    // Exhausted: give up, suspend, record the churn.
    await pool.query(
      `UPDATE invoices SET status = 'failed', next_retry_at = NULL WHERE id = $1`,
      [inv.id],
    )
    const sub = await pool.query(
      `UPDATE subscriptions SET status = 'suspended'
       WHERE tenant_id = $1 AND status IN ('active', 'past_due') RETURNING plan`,
      [inv.tenant_id],
    )
    if (sub.rows.length > 0 && isPlanId(sub.rows[0].plan)) {
      await pool.query(
        `INSERT INTO subscription_events (tenant_id, type, from_plan, to_plan, mrr_delta_cents)
         VALUES ($1, 'churn', $2, NULL, $3)`,
        [inv.tenant_id, sub.rows[0].plan, -PLANS[sub.rows[0].plan].baseCents],
      )
    }
    return
  }

  // Schedule the next retry: attempt_count is 1-based, so the offset for the
  // NEXT attempt is RETRY_OFFSETS_DAYS[attempt_count - 1].
  const offsetDays = RETRY_OFFSETS_DAYS[inv.attempt_count - 1]
  await pool.query(
    `UPDATE invoices SET status = 'past_due', next_retry_at = now() + ($2 || ' days')::interval
     WHERE id = $1`,
    [inv.id, offsetDays],
  )
  await pool.query(
    `UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = $1 AND status = 'active'`,
    [inv.tenant_id],
  )
  void error
}
