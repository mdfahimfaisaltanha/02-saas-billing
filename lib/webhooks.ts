import { createHmac, timingSafeEqual } from "node:crypto"
import { getPool } from "./db"
import { applyFailure, applySuccess } from "./dunning"

/**
 * Billing webhooks — signature verification + idempotent processing.
 *
 * Delivery paths:
 *   - MOCK mode: the billing provider "delivers" events in-process by
 *     calling processBillingEvent directly after each charge attempt.
 *   - HTTP endpoint (app/api/webhooks/billing): what an external provider
 *     (Stripe) would call. Verifies an HMAC-SHA256 signature over the raw
 *     body and feeds the same processBillingEvent. curl examples in
 *     samples/api-examples.md.
 *
 * Idempotency: every event carries a unique event id, recorded in
 * billing_events with a UNIQUE constraint. A redelivered event inserts
 * nothing and is acknowledged without reprocessing — the classic
 * at-least-once-delivery defense. State transitions are additionally
 * idempotent on their own (guarded UPDATEs), so even a NEW event id for an
 * already-paid invoice is a no-op.
 */

export type BillingEvent = {
  id: string // evt_...
  type: "invoice.payment_succeeded" | "invoice.payment_failed"
  data: {
    invoiceId: number
    ref?: string | null
    error?: string | null
  }
}

function secret(): string {
  return process.env.WEBHOOK_SECRET || "dev_webhook_secret_change_me"
}

export function signBody(rawBody: string): string {
  return createHmac("sha256", secret()).update(rawBody).digest("hex")
}

export function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false
  const expected = Buffer.from(signBody(rawBody), "hex")
  let actual: Buffer
  try {
    actual = Buffer.from(signature, "hex")
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export type ProcessResult = { processed: boolean; duplicate: boolean }

export async function processBillingEvent(event: BillingEvent): Promise<ProcessResult> {
  if (!event?.id || !event?.type || !Number.isInteger(event?.data?.invoiceId)) {
    throw new Error("Malformed billing event.")
  }
  // Idempotency gate: first delivery wins, redeliveries are acknowledged no-ops.
  const inserted = await getPool().query(
    `INSERT INTO billing_events (event_id, type, payload)
     VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [event.id, event.type, JSON.stringify(event.data)],
  )
  if (inserted.rows.length === 0) {
    return { processed: false, duplicate: true }
  }

  switch (event.type) {
    case "invoice.payment_succeeded":
      await applySuccess(event.data.invoiceId, event.data.ref ?? null)
      break
    case "invoice.payment_failed":
      await applyFailure(event.data.invoiceId, event.data.error ?? null)
      break
  }
  return { processed: true, duplicate: false }
}
