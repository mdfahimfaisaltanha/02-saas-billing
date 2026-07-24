import { createHash, randomBytes, scryptSync } from "node:crypto"
import { readFileSync } from "node:fs"
import pg from "pg"

/**
 * One-shot setup: creates tables and seeds 5 months of billing history so
 * the MRR dashboard, movement table, and dunning queue all have a story to
 * tell on first load:
 *
 *   - 7 tenants across free/starter/pro
 *   - new / expansion / contraction / churn events spread over 5 months
 *   - metered usage (two tenants over quota → real overage on invoices)
 *   - last month invoiced: 4 paid, 1 PAST DUE with a failing card, mid-dunning,
 *     retry DUE NOW — so "Run dunning cycle" does something immediately
 *
 *   npm run setup
 *
 * Reads DATABASE_URL from .env.local (or env). Idempotent: skips seeding if
 * users already exist. Prints demo credentials and tenant API keys (keys are
 * stored hashed — this is the only time they're visible).
 */

function loadEnvLocal() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
  } catch {
    /* rely on the environment */
  }
}

loadEnvLocal()

if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.\n")
  process.exit(1)
}

const SEED_PASSWORD = process.env.SEED_PASSWORD || "ChangeMe123!"

const hashPassword = (password) => {
  const salt = randomBytes(16)
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32, { N: 16384 }).toString("hex")}`
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex")
const newApiKey = () => `mb_live_${randomBytes(20).toString("hex")}`
const mockRef = () => `mock_pi_${randomBytes(10).toString("hex")}`
const evtId = () => `evt_seed_${randomBytes(8).toString("hex")}`

// Deterministic RNG so usage numbers are stable across reseeds.
function mulberry32(seed) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(42)

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  mock_card    TEXT NOT NULL DEFAULT 'good' CHECK (mock_card IN ('good', 'failing')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'member', 'platform')),
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'platform') = (tenant_id IS NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL CHECK (plan IN ('free', 'starter', 'pro')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'suspended', 'canceled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS subscription_events (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('new', 'expansion', 'contraction', 'churn', 'reactivation')),
  from_plan       TEXT,
  to_plan         TEXT,
  mrr_delta_cents INTEGER NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_events_time ON subscription_events (occurred_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  idempotency_key TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_time ON usage_events (tenant_id, recorded_at);

CREATE TABLE IF NOT EXISTS invoices (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,
  plan            TEXT NOT NULL,
  base_cents      INTEGER NOT NULL,
  included_events INTEGER NOT NULL,
  used_events     INTEGER NOT NULL,
  overage_cents   INTEGER NOT NULL,
  total_cents     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'past_due', 'failed', 'void')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id         SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  ref        TEXT,
  status     TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_events (
  id           SERIAL PRIMARY KEY,
  event_id     TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

const BASE = { free: 0, starter: 2900, pro: 9900 }
const INCLUDED = { free: 1000, starter: 50000, pro: 250000 }
const PER_1K = { free: 0, starter: 20, pro: 10 }
const overage = (plan, used) =>
  PER_1K[plan] === 0 ? 0 : Math.max(0, Math.ceil(Math.max(0, used - INCLUDED[plan]) / 1000) * PER_1K[plan])

async function main() {
  console.log("⏳ Creating tables…")
  await pool.query(SCHEMA)

  const existing = await pool.query(`SELECT COUNT(*)::int AS item_count FROM users`)
  if (existing.rows[0].item_count > 0) {
    console.log("ℹ️  Data already exists — skipping seed. (Drop the tables to reseed.)")
    await pool.end()
    return
  }

  console.log("🏢 Creating tenants + owners…")
  // [key, company, ownerName, ownerEmail, plan, status, mockCard]
  const tenantDefs = [
    ["acme", "Acme Analytics", "Ayesha Karim", "owner@acme.test", "pro", "active", "good"],
    ["flaky", "Flaky Networks", "Tom Brennan", "owner@flaky.test", "starter", "past_due", "failing"],
    ["brightside", "Brightside Labs", "Lena Fischer", "owner@brightside.test", "starter", "active", "good"],
    ["nimbus", "Nimbus Data", "Marcus Cole", "owner@nimbus.test", "pro", "active", "good"],
    ["quietloop", "Quietloop", "Dana Reyes", "owner@quietloop.test", "starter", "canceled", "good"],
    ["seedling", "Seedling HQ", "Yusuf Rahman", "owner@seedling.test", "free", "active", "good"],
    ["downshift", "Downshift Co", "Ingrid Holm", "owner@downshift.test", "starter", "active", "good"],
  ]
  const T = {}
  const apiKeys = {}
  for (const [slug, company, ownerName, ownerEmail, plan, status, mockCard] of tenantDefs) {
    const key = newApiKey()
    apiKeys[slug] = key
    const t = await pool.query(
      `INSERT INTO tenants (name, api_key_hash, mock_card, created_at) VALUES ($1, $2, $3, now() - interval '5 months') RETURNING id`,
      [company, sha256(key), mockCard],
    )
    T[slug] = t.rows[0].id
    await pool.query(
      `INSERT INTO users (tenant_id, name, email, role, password_hash) VALUES ($1, $2, $3, 'owner', $4)`,
      [T[slug], ownerName, ownerEmail, hashPassword(SEED_PASSWORD)],
    )
    await pool.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, created_at, canceled_at)
       VALUES ($1, $2, $3, now() - interval '5 months', $4)`,
      [T[slug], plan, status, status === "canceled" ? new Date() : null],
    )
  }
  await pool.query(
    `INSERT INTO users (tenant_id, name, email, role, password_hash) VALUES (NULL, 'Platform Ops', 'ops@meterbill.test', 'platform', $1)`,
    [hashPassword(SEED_PASSWORD)],
  )

  console.log("📈 Writing 5 months of MRR movements…")
  // [monthsAgo, slug, type, fromPlan, toPlan, delta]
  const movements = [
    [4, "acme", "new", null, "starter", 2900],
    [4, "brightside", "new", null, "starter", 2900],
    [3, "nimbus", "new", null, "starter", 2900],
    [3, "flaky", "new", null, "starter", 2900],
    [3, "acme", "expansion", "starter", "pro", 7000],
    [2, "quietloop", "new", null, "starter", 2900],
    [2, "nimbus", "expansion", "starter", "pro", 7000],
    [2, "downshift", "new", null, "pro", 9900],
    [1, "quietloop", "churn", "starter", null, -2900],
    [1, "downshift", "contraction", "pro", "starter", -7000],
  ]
  for (const [monthsAgo, slug, type, fromPlan, toPlan, delta] of movements) {
    await pool.query(
      `INSERT INTO subscription_events (tenant_id, type, from_plan, to_plan, mrr_delta_cents, occurred_at)
       VALUES ($1, $2, $3, $4, $5, date_trunc('month', now()) - ($6 || ' months')::interval + interval '9 days')`,
      [T[slug], type, fromPlan, toPlan, delta, monthsAgo],
    )
  }

  console.log("⚡ Recording metered usage (last month + this month)…")
  // slug -> [lastMonthTotal, thisMonthTotal]; acme + brightside run over quota.
  const usagePlans = {
    acme: [310_000, 175_000],
    flaky: [30_000, 12_000],
    brightside: [55_000, 31_000],
    nimbus: [120_000, 74_000],
    quietloop: [8_000, 0],
    seedling: [1_400, 900],
    downshift: [21_000, 13_000],
  }
  for (const [slug, [lastMonth, thisMonth]] of Object.entries(usagePlans)) {
    for (const [monthsAgo, total] of [[1, lastMonth], [0, thisMonth]]) {
      if (total === 0) continue
      const chunks = 8
      let remaining = total
      for (let i = 0; i < chunks; i++) {
        const qty = i === chunks - 1 ? remaining : Math.max(1, Math.round((total / chunks) * (0.6 + rand() * 0.8)))
        remaining -= qty
        if (qty < 1) continue
        await pool.query(
          `INSERT INTO usage_events (tenant_id, quantity, recorded_at)
           VALUES ($1, $2, date_trunc('month', now()) - ($3 || ' months')::interval + ($4 || ' days')::interval)`,
          [T[slug], qty, monthsAgo, 2 + i * 3],
        )
        if (remaining <= 0) break
      }
    }
  }

  console.log("🧾 Invoicing last month (4 paid, 1 stuck in dunning)…")
  const lastPeriod = (await pool.query(`SELECT to_char(now() - interval '1 month', 'YYYY-MM') AS p`)).rows[0].p
  // Paid invoices for the healthy tenants.
  const paidPlans = { acme: "pro", brightside: "starter", nimbus: "pro", downshift: "starter" }
  for (const [slug, plan] of Object.entries(paidPlans)) {
    const used = usagePlans[slug][0]
    const over = overage(plan, used)
    const inv = await pool.query(
      `INSERT INTO invoices (tenant_id, period, plan, base_cents, included_events, used_events, overage_cents, total_cents,
                             status, attempt_count, paid_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', 1, now() - interval '20 days', now() - interval '21 days')
       RETURNING id`,
      [T[slug], lastPeriod, plan, BASE[plan], INCLUDED[plan], used, over, BASE[plan] + over],
    )
    const ref = mockRef()
    await pool.query(
      `INSERT INTO payment_attempts (invoice_id, provider, ref, status, error, created_at)
       VALUES ($1, 'mock', $2, 'succeeded', NULL, now() - interval '20 days')`,
      [inv.rows[0].id, ref],
    )
    await pool.query(
      `INSERT INTO billing_events (event_id, type, payload) VALUES ($1, 'invoice.payment_succeeded', $2)`,
      [evtId(), JSON.stringify({ invoiceId: inv.rows[0].id, ref })],
    )
  }
  // Flaky Networks: two failed attempts so far, third retry DUE NOW.
  const flakyUsed = usagePlans.flaky[0]
  const flakyInv = await pool.query(
    `INSERT INTO invoices (tenant_id, period, plan, base_cents, included_events, used_events, overage_cents, total_cents,
                           status, attempt_count, next_retry_at, created_at)
     VALUES ($1, $2, 'starter', $3, $4, $5, 0, $3, 'past_due', 2, now() - interval '1 hour', now() - interval '21 days')
     RETURNING id`,
    [T.flaky, lastPeriod, BASE.starter, INCLUDED.starter, flakyUsed],
  )
  for (const daysAgo of [20, 19]) {
    await pool.query(
      `INSERT INTO payment_attempts (invoice_id, provider, ref, status, error, created_at)
       VALUES ($1, 'mock', NULL, 'failed', 'card_declined (mock failing card — flip the tenant''s card in the seed or admin to demo recovery)', now() - ($2 || ' days')::interval)`,
      [flakyInv.rows[0].id, daysAgo],
    )
    await pool.query(
      `INSERT INTO billing_events (event_id, type, payload) VALUES ($1, 'invoice.payment_failed', $2)`,
      [evtId(), JSON.stringify({ invoiceId: flakyInv.rows[0].id, error: "card_declined" })],
    )
  }

  console.log(`\n✅ Seeded: 7 tenants, 5 months of MRR movements, metered usage, ${Object.keys(paidPlans).length} paid + 1 past-due invoice.`)
  console.log("\n🔑 Demo accounts (all share the same password):")
  console.log("   ops@meterbill.test     — platform (MRR dashboard + dunning queue)")
  console.log("   owner@acme.test        — Pro tenant, over quota (real overage)")
  console.log("   owner@flaky.test       — Starter tenant, FAILING card, mid-dunning")
  console.log("   owner@brightside.test  — Starter tenant, just over quota")
  console.log("   owner@seedling.test    — Free tenant (upgrade nudge)")
  console.log(`   password: ${SEED_PASSWORD}${process.env.SEED_PASSWORD ? "" : "   (default — set SEED_PASSWORD to override)"}`)
  console.log("\n🔐 Tenant API keys for usage ingestion (hashed in the DB — shown only now):")
  for (const [slug, key] of Object.entries(apiKeys)) {
    console.log(`   ${slug.padEnd(11)} ${key}`)
  }
  console.log("\n🎉 Setup complete. Run: npm run dev → http://localhost:3000 (demo script: samples/walkthrough.md)")
  await pool.end()
}

main().catch((err) => {
  console.error("\n❌ Setup failed:", err.message)
  process.exit(1)
})
