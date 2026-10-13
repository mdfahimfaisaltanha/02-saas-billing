import Stripe from "stripe"
import { randomBytes } from "node:crypto"
import { getPool } from "./db"
import { PLANS, invoiceTotalCents, isPlanId, overageCents } from "./plans"
import { processBillingEvent } from "./webhooks"

/**
 * The billing engine: invoice generation + charging + dunning runs.
 *
 * Provider abstraction mirrors the marketplace project:
 *   - MOCK mode (no STRIPE_SECRET_KEY): charges succeed unless the tenant's
 *     mock_card is 'failing' — a per-tenant switch that makes dunning
 *     demoable on demand.
 *   - STRIPE mode (sk_test_ key): real test-mode PaymentIntents. Live keys
 *     are rejected — this project must never move real money.
 *
 * Every charge attempt ends with a webhook event (in-process in mock mode),
 * and ALL state transitions happen in the webhook processor — never inline.
 * That's the Stripe architecture: the charge call is a request; the webhook
 * is the truth.
 */

let stripe: Stripe | null | undefined

function getStripe(): Stripe | null {
  if (stripe !== undefined) return stripe
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key) {
    stripe = null
  } else if (!key.startsWith("sk_test_")) {
    throw new Error("Refusing to start: STRIPE_SECRET_KEY must be a TEST key (sk_test_...).")
  } else {
    stripe = new Stripe(key, { apiVersion: "2024-06-20" })
  }
  return stripe
}

export function billingProvider(): "stripe" | "mock" {
  return getStripe() ? "stripe" : "mock"
}

const evtId = () => `evt_${randomBytes(12).toString("hex")}`
const mockRef = () => `mock_pi_${randomBytes(10).toString("hex")}`

export type ChargeOutcome = {
  invoiceId: number
  succeeded: boolean
  ref: string | null
  error: string | null
}

/**
 * Attempt to collect an invoice. Increments attempt_count, records the
 * attempt, then delivers the resulting webhook event (which performs the
 * actual state transition — paid, past_due + retry, or suspended).
 */
export async function chargeInvoice(invoiceId: number): Promise<ChargeOutcome> {
  const pool = getPool()
  const res = await pool.query(
    `SELECT i.id, i.tenant_id, i.total_cents, i.status, i.attempt_count, t.mock_card, t.name AS tenant_name
     FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = $1`,
    [invoiceId],
  )
  if (res.rows.length === 0) throw new Error(`Invoice ${invoiceId} not found.`)
  const inv = res.rows[0]
  if (["paid", "void", "failed"].includes(inv.status)) {
    return { invoiceId, succeeded: inv.status === "paid", ref: null, error: `Invoice is ${inv.status}; nothing to charge.` }
  }

  // Zero-total invoices (free plan / fully within quota) settle instantly.
  if (inv.total_cents === 0) {
    await processBillingEvent({ id: evtId(), type: "invoice.payment_succeeded", data: { invoiceId, ref: "no_charge_needed" } })
    return { invoiceId, succeeded: true, ref: "no_charge_needed", error: null }
  }

  await pool.query(`UPDATE invoices SET attempt_count = attempt_count + 1 WHERE id = $1`, [invoiceId])

  let succeeded = false
  let ref: string | null = null
  let error: string | null = null

  const s = getStripe()
  if (s) {
    try {
      const pi = await s.paymentIntents.create({
        amount: inv.total_cents,
        currency: "usd",
        payment_method: "pm_card_visa",
        payment_method_types: ["card"],
        confirm: true,
        description: `Invoice #${invoiceId} — ${inv.tenant_name}`,
        metadata: { invoice_id: String(invoiceId) },
      })
      succeeded = pi.status === "succeeded"
      ref = pi.id
      if (!succeeded) error = `PaymentIntent status: ${pi.status}`
    } catch (err) {
      error = err instanceof Error ? err.message : "charge failed"
    }
  } else if (inv.mock_card === "failing") {
    error = "card_declined (mock failing card — flip the tenant's card in the seed or admin to demo recovery)"
  } else {
    succeeded = true
    ref = mockRef()
  }

  await pool.query(
    `INSERT INTO payment_attempts (invoice_id, provider, ref, status, error)
     VALUES ($1, $2, $3, $4, $5)`,
    [invoiceId, billingProvider(), ref, succeeded ? "succeeded" : "failed", error],
  )

  await processBillingEvent({
    id: evtId(),
    type: succeeded ? "invoice.payment_succeeded" : "invoice.payment_failed",
    data: { invoiceId, ref, error },
  })

  return { invoiceId, succeeded, ref, error }
}

/**
 * Generate invoices for a period (YYYY-MM) — idempotent via
 * UNIQUE(tenant_id, period) ON CONFLICT DO NOTHING. Metered usage is counted
 * from usage_events inside the period; suspended/canceled subscriptions get
 * no new invoices.
 */
export async function generateInvoices(period: string): Promise<{ created: number; skipped: number }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("period must be YYYY-MM.")
  const pool = getPool()
  const subs = await pool.query(
    `SELECT s.tenant_id, s.plan,
            COALESCE((SELECT SUM(u.quantity)::int FROM usage_events u
                      WHERE u.tenant_id = s.tenant_id
                        AND to_char(u.recorded_at, 'YYYY-MM') = $1), 0) AS used_events
     FROM subscriptions s
     WHERE s.status IN ('active', 'past_due')`,
    [period],
  )

  let created = 0
  let skipped = 0
  for (const row of subs.rows) {
    if (!isPlanId(row.plan)) continue
    const plan = PLANS[row.plan]
    const over = overageCents(plan, row.used_events)
    const ins = await pool.query(
      `INSERT INTO invoices (tenant_id, period, plan, base_cents, included_events, used_events, overage_cents, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, period) DO NOTHING RETURNING id`,
      [row.tenant_id, period, plan.id, plan.baseCents, plan.includedEvents, row.used_events, over, invoiceTotalCents(plan, row.used_events)],
    )
    if (ins.rows.length > 0) created++
    else skipped++
  }
  return { created, skipped }
}

/**
 * A dunning run: charge every past_due invoice whose retry is due. In
 * production this is a daily cron; here it's a button in the platform
 * dashboard so the demo controls time.
 */
export async function runDunning(): Promise<{ attempted: number; recovered: number; stillFailing: number }> {
  const pool = getPool()
  const due = await pool.query(
    `SELECT id FROM invoices WHERE status = 'past_due' AND next_retry_at IS NOT NULL AND next_retry_at <= now()
     ORDER BY next_retry_at ASC`,
  )
  let recovered = 0
  for (const row of due.rows) {
    const outcome = await chargeInvoice(row.id)
    if (outcome.succeeded) recovered++
  }
  return { attempted: due.rows.length, recovered, stillFailing: due.rows.length - recovered }
}
