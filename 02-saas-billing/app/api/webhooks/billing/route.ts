import { processBillingEvent, verifySignature, type BillingEvent } from "@/lib/webhooks"

export const dynamic = "force-dynamic"

/**
 * POST /api/webhooks/billing — the endpoint an external billing provider
 * (Stripe) would call. Demonstrates the two non-negotiables of webhook
 * handling:
 *
 *   1. SIGNATURE VERIFICATION over the RAW body (HMAC-SHA256 with
 *      WEBHOOK_SECRET, hex, in the x-billing-signature header). Parse only
 *      after verifying — never trust an unsigned payload that moves money.
 *   2. IDEMPOTENT PROCESSING — providers deliver at-least-once; redelivered
 *      event ids are acknowledged (200) but not reprocessed.
 *
 * Try it with the signed curl example in samples/api-examples.md.
 */
export async function POST(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-billing-signature")
  if (!verifySignature(rawBody, signature)) {
    return Response.json({ error: "Invalid or missing x-billing-signature." }, { status: 401 })
  }

  let event: BillingEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: "Body is not valid JSON." }, { status: 400 })
  }

  try {
    const result = await processBillingEvent(event)
    // Always 200 for duplicates — a non-2xx would make the provider retry forever.
    return Response.json({ received: true, ...result })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Processing failed." }, { status: 400 })
  }
}
