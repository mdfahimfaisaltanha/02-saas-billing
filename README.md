# Multi-Tenant SaaS Billing (“MeterBill”)

A billing engine for a multi-tenant SaaS: **metered usage billing** (base fee + per-1,000-event overage), a **dunning engine** with a retry ladder that ends in suspension, **signed + idempotent webhooks**, and a **platform MRR/churn dashboard** with monthly movement breakdowns (new / expansion / contraction / churn).

Built with **Next.js 14 (App Router)**, **TypeScript**, and **Postgres**. Runs fully in **mock billing mode** with zero Stripe setup — or against **Stripe test-mode** PaymentIntents by adding one env var (live keys are rejected on startup).

---

## Quick start

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Neon/Supabase free tier)
npm run setup                # tables + 5 months of billing history
npm run dev                  # http://localhost:3000
```

Sign in as `ops@meterbill.test` (platform) or any tenant owner printed by setup. A guided demo is in `samples/walkthrough.md`; API examples (usage ingestion + signed webhooks) are in `samples/api-examples.md`.

---

## Pricing model (`lib/plans.ts`)

| Plan | Base | Included events/mo | Overage |
|---|---|---|---|
| Free | $0 | 1,000 | none — recorded, never billed (nudge, not surprise invoice) |
| Starter | $29 | 50,000 | $0.20 per extra 1,000 (rounded up) |
| Pro | $99 | 250,000 | $0.10 per extra 1,000 (rounded up) |

The catalog lives in code, not the database — a price change is a reviewed pull request. All money is integer cents; overage is priced per-1,000 so there are no fractional-cent floats anywhere.

## The billing pipeline

```
usage ─→ POST /api/usage (API key, idempotency key)
            │
invoice run ─→ generateInvoices(period)     idempotent: UNIQUE(tenant_id, period)
            │
charge ─→ chargeInvoice()  ── provider (mock | Stripe test) ─→ webhook event
            │                                                      │
            └─ records payment_attempt                processBillingEvent()
                                                        │ (idempotent: UNIQUE event_id)
                              paid ←─ succeeded ──┬── failed ─→ dunning ladder
```

**The webhook is the truth.** Charge calls never flip invoice state inline — every state transition (paid, past_due + retry, suspended) happens in the webhook processor, exactly how a real Stripe integration must work. In mock mode events are delivered in-process; the HTTP endpoint (`/api/webhooks/billing`) demonstrates what an external provider would call.

## Dunning (`lib/dunning.ts`)

| Attempt | When | On failure |
|---|---|---|
| 1 | invoice charged | invoice `past_due`, subscription `past_due`, retry +1 day |
| 2 | +1 day | retry +3 days |
| 3 | +3 days | retry +7 days |
| 4 (final) | +7 days | invoice `failed`, subscription **suspended**, churn event recorded |

- `past_due` tenants keep service and **still count in MRR** — dunning exists to save the revenue.
- Suspension has teeth: the usage API returns **402** for suspended tenants.
- Recovery at any rung: a successful charge (retry, or the owner clicking *Charge now* after fixing the card) marks the invoice paid and re-activates the subscription.
- In production the dunning run is a daily cron; here it's a button in the platform dashboard so the demo controls time.

## Webhooks: the two non-negotiables (`lib/webhooks.ts`)

1. **Signature verification over the raw body** — HMAC-SHA256 with `WEBHOOK_SECRET`, hex-encoded in `x-billing-signature`, compared with `timingSafeEqual`. Parse only after verifying.
2. **Idempotent processing** — providers deliver at-least-once. Every event id is recorded under a UNIQUE constraint; redeliveries are acknowledged (200) but not reprocessed. State transitions are *also* independently idempotent (guarded UPDATEs), so even a fresh event id for an already-paid invoice is a no-op.

## MRR & churn methodology (`lib/metrics.ts`)

- **MRR** = sum of base fees for `active` + `past_due` subscriptions. Metered overage is excluded — it's usage revenue, not committed recurring revenue.
- **Movements** are event-sourced (`subscription_events`), each with a signed MRR delta: `new` (+base, incl. free→paid conversion), `expansion` (+diff), `contraction` (−diff), `churn` (−base, from cancel *or* dunning exhaustion), `reactivation` (+base).
- **Monthly churn rate** = churned MRR ÷ MRR at month start. The month table is replayed cumulatively, so ending MRR always reconciles with the live number — a consistency check the dashboard gets for free.

## Edge cases handled

| Case | Behavior |
|---|---|
| Invoice run executed twice for a period | `UNIQUE(tenant_id, period)` + `ON CONFLICT DO NOTHING` — second run creates 0 |
| Webhook redelivered (same event id) | acknowledged 200, not reprocessed |
| Webhook with bad/missing signature | 401, body never parsed |
| Usage sent twice with one idempotency key | second write is a no-op (`duplicate: true`) |
| Retry ladder exhausted | invoice `failed`, subscription suspended, churn recorded once |
| Suspended tenant sends usage | 402 — suspension actually cuts service |
| Zero-total invoice (free / within quota) | settles instantly, no provider call |
| Free plan over quota | recorded, never billed — upgrade nudge in the UI |
| Free → paid plan change | classified as `new` MRR, not expansion (ChartMogul convention) |
| Cancel while past_due | churn recorded once; already-suspended tenants don't double-churn |
| Owner pays another tenant's invoice | 404 — tenant id comes from the session, never the client |
| `sk_live_` key in env | refuses to start |

## Data model

`tenants(api_key_hash, mock_card)` · `users(role owner|member|platform)` · `sessions` · `subscriptions(plan, status)` · `subscription_events(type, mrr_delta_cents)` · `usage_events(UNIQUE(tenant_id, idempotency_key))` · `invoices(UNIQUE(tenant_id, period), attempt_count, next_retry_at)` · `payment_attempts` · `billing_events(event_id UNIQUE)`

## Interview talking points

- Why state transitions live in the webhook processor, not the charge call (provider truth, retries, async settlement).
- The two idempotency layers: event-id gate *and* guarded UPDATEs — and why you want both.
- Why past_due counts in MRR and metered overage doesn't.
- Event-sourced MRR movements vs snapshot diffing: replaying `subscription_events` makes the month table reconcile with live MRR by construction.
- Fee/quota math in integer cents with per-1k pricing — no floats in money paths.

## Deployment (Vercel + Neon)

1. Free Postgres at [neon.tech](https://neon.tech) → set `DATABASE_URL`.
2. `npm run setup` against the database; set a real `WEBHOOK_SECRET`.
3. Push to GitHub → import in Vercel → set env vars → deploy.
4. Optional: add an `sk_test_` Stripe key for real test-mode PaymentIntents.
5. Schedule `POST /api/admin/dunning` daily (Vercel Cron) for hands-off dunning.

## Limitations / roadmap

- No mid-month proration on plan changes — the new base applies from the next invoice (the movement is recorded immediately).
- One subscription per tenant; no seats or per-member pricing.
- Mock mode approximates card outcomes with a per-tenant switch rather than issuer decline codes.
- Email notifications for dunning (the “letters” in dunning letters) are logged, not sent.
