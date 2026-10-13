# 5-minute walkthrough (after `npm run setup`)

All seeded accounts share the password printed by setup. The seed leaves the platform mid-story: 5 months of MRR history, two tenants over quota, and one tenant stuck in dunning with a retry **due right now**.

## 1. The platform view — `ops@meterbill.test`

1. **MRR & churn tab** — headline MRR ($285.00), tenants by plan, and the monthly movement table: watch the story — new logos, two expansions, then last month a churn (Quietloop) and a contraction (Downshift Pro→Starter). Ending MRR in the last row reconciles exactly with the headline number — the table is replayed from events, not eyeballed.
2. **Dunning tab** — Flaky Networks' $29 invoice sits at attempt 2/4, **due now**. Click **Run dunning cycle** → the charge fails again (their card is set to failing), and the retry reschedules +7 days. One more failure after that would suspend them and record churn.
3. **Invoices tab** — click **Generate invoices** for the current period → creates one per active tenant, with real overage where usage ran past quota (Acme: 310k events on a 250k plan last month). Click it again → `0 created` — the run is idempotent.

## 2. The rescue — `owner@flaky.test`

1. **Plan & billing tab** — the demo card badge shows *failing*. Click **Flip to good card**.
2. **Invoices tab** — the past-due invoice is still there (its next retry is days away). Don't wait: click **Charge now** → payment succeeds, invoice `paid`, subscription flips back to `active`. That's dunning recovery — the whole point of the ladder.
3. Flip the card back to *failing* if you want to demo a fresh failure on this month's invoice later.

## 3. Metered usage — `owner@acme.test`

1. **Usage tab** — the quota meter is past 100% territory from seeded traffic; the projected invoice shows base + overage, billed per 1,000 events rounded up.
2. Ingest more usage with the curl in `samples/api-examples.md` (Acme's API key is in the setup output), refresh — the meter and projection move. Send the same idempotency key twice: the second write is a no-op.

## 4. MRR movements, live — `owner@brightside.test`

1. **Plan & billing** → switch to **Pro** → the response names the movement: `expansion`.
2. Back as `ops@meterbill.test`, the MRR headline is +$70 and this month's row shows the expansion. Downgrade back and you'll mint a `contraction`.
3. As `owner@seedling.test` (free), upgrade to Starter — that's classified as **new** MRR, not expansion: free tenants carry no MRR.

## 5. Suspension has teeth

Cancel a tenant (or let Flaky exhaust all 4 attempts) and try the usage curl with their API key → **402**. Billing that can't cut service is just bookkeeping.
