# API examples

Replace `$API_KEY` with a tenant key printed by `npm run setup`, and keep the app running on `http://localhost:3000`.

## 1. Ingest metered usage (machine-to-machine)

```bash
curl -s -X POST http://localhost:3000/api/usage \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 2500, "idempotencyKey": "batch-2026-07-22-a"}'
# → 201 {"recorded":true,"duplicate":false}
```

Send the **exact same request again** — client retries must not double-bill:

```bash
# → 200 {"recorded":false,"duplicate":true}
```

No key / wrong key → 401. Suspended tenant → **402** (suspension cuts service).

## 2. Deliver a signed webhook

The endpoint verifies an HMAC-SHA256 signature over the **raw body** (hex, `x-billing-signature` header) using `WEBHOOK_SECRET` from `.env.local`.

```bash
BODY='{"id":"evt_manual_0001","type":"invoice.payment_succeeded","data":{"invoiceId":5,"ref":"pi_manual"}}'
SECRET='dev_webhook_secret_change_me'   # match your .env.local
SIG=$(node -e "console.log(require('crypto').createHmac('sha256', process.argv[1]).update(process.argv[2]).digest('hex'))" "$SECRET" "$BODY")

curl -s -X POST http://localhost:3000/api/webhooks/billing \
  -H "x-billing-signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
# → {"received":true,"processed":true,"duplicate":false}
```

Replay the same event id — at-least-once delivery is the provider's right:

```bash
# → {"received":true,"processed":false,"duplicate":true}   (200, acknowledged, not reprocessed)
```

Tamper with one byte of the body (or omit the header) → **401** before parsing.

## 3. Check current usage (session auth)

```bash
# Sign in via the UI first, or script the cookie:
curl -s -c /tmp/mb.jar -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{"mode":"login","email":"owner@acme.test","password":"ChangeMe123!"}'

curl -s -b /tmp/mb.jar http://localhost:3000/api/usage
# → plan, period usage, projected overage + total
```
