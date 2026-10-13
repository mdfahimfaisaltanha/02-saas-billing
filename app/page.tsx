"use client"

import { useCallback, useEffect, useState } from "react"
import type { Invoice, MrrMetrics, SessionUser } from "@/lib/types"

type Tab = "usage" | "billing" | "invoices" | "metrics" | "dunning"

type UsageInfo = {
  plan: string
  subscriptionStatus: string
  period: string
  usedEvents: number
  includedEvents: number
  projectedOverageCents: number
  projectedTotalCents: number
}

type SubInfo = {
  subscription: { plan: string; status: string; createdAt: string; canceledAt: string | null }
  mockCard: string
  plans: Array<{ id: string; name: string; baseCents: number; includedEvents: number; overagePer1kCents: number }>
}

type DunningRow = {
  id: number
  tenantName: string
  period: string
  totalCents: number
  attemptCount: number
  nextRetryAt: string | null
  dueNow: boolean
  lastError: string | null
}

const fmt = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString("en-US")
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"

const STATUS_BADGE: Record<string, string> = {
  active: "ok", past_due: "warn", suspended: "bad", canceled: "muted",
  paid: "ok", pending: "info", failed: "bad", void: "muted",
  free: "muted", starter: "info", pro: "accent",
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${STATUS_BADGE[value] ?? "muted"}`}>{value.replace(/_/g, " ")}</span>
}

export default function Dashboard() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined)
  const [tab, setTab] = useState<Tab>("usage")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)

  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [sub, setSub] = useState<SubInfo | null>(null)
  const [invoices, setInvoices] = useState<Array<Invoice & { lastError?: string | null }>>([])
  const [metrics, setMetrics] = useState<MrrMetrics | null>(null)
  const [dunning, setDunning] = useState<{ queue: DunningRow[]; maxAttempts: number } | null>(null)
  const [genPeriod, setGenPeriod] = useState(new Date().toISOString().slice(0, 7))

  // auth form
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [company, setCompany] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const refresh = useCallback(async (u: SessionUser) => {
    const jobs: Promise<unknown>[] = [
      fetch("/api/invoices").then(async (r) => { if (r.ok) setInvoices((await r.json()).invoices) }),
    ]
    if (u.role === "platform") {
      jobs.push(fetch("/api/admin/metrics").then(async (r) => { if (r.ok) setMetrics(await r.json()) }))
      jobs.push(fetch("/api/admin/dunning").then(async (r) => { if (r.ok) setDunning(await r.json()) }))
    } else {
      jobs.push(fetch("/api/usage").then(async (r) => { if (r.ok) setUsage(await r.json()) }))
      jobs.push(fetch("/api/subscription").then(async (r) => { if (r.ok) setSub(await r.json()) }))
    }
    await Promise.all(jobs).catch(() => setError("Failed to load data. Did you run `npm run setup`?"))
  }, [])

  useEffect(() => {
    fetch("/api/auth")
      .then(async (r) => {
        const data = await r.json()
        setUser(data.user)
        if (data.user) {
          setTab(data.user.role === "platform" ? "metrics" : "usage")
          void refresh(data.user)
        }
      })
      .catch(() => setUser(null))
  }, [refresh])

  async function call(url: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setError(null)
    setNotice(null)
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError((data as { error?: string }).error || "Request failed.")
      return null
    }
    if (user) void refresh(user)
    return data as Record<string, unknown>
  }

  async function submitAuth(e: React.FormEvent) {
    e.preventDefault()
    const data = await call("/api/auth", "POST", { mode, company, name, email, password })
    if (data?.user) {
      const u = data.user as SessionUser
      setUser(u)
      setPassword("")
      if (data.apiKey) setNewApiKey(data.apiKey as string)
      setTab(u.role === "platform" ? "metrics" : "usage")
      void refresh(u)
    }
  }

  if (user === undefined) return <main className="container"><p className="meta">Loading…</p></main>

  if (!user) {
    return (
      <main className="container">
        <div className="login-wrap card">
          <h2>💳 MeterBill</h2>
          <p className="meta" style={{ marginBottom: 14 }}>
            Multi-tenant metered billing. Seeded logins: <code>owner@acme.test</code> (healthy tenant),{" "}
            <code>owner@flaky.test</code> (failing card, mid-dunning), <code>ops@meterbill.test</code> (platform MRR
            dashboard) — password printed by <code>npm run setup</code>. Or create a new tenant.
          </p>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className={mode === "login" ? "primary" : "ghost"} onClick={() => setMode("login")}>Sign in</button>
            <button className={mode === "signup" ? "primary" : "ghost"} onClick={() => setMode("signup")}>New tenant</button>
          </div>
          <form onSubmit={submitAuth}>
            {mode === "signup" && (
              <div className="row" style={{ marginBottom: 10 }}>
                <input placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} style={{ flex: 1 }} />
                <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
              </div>
            )}
            <div className="row">
              <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 170 }} />
              <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ flex: 1, minWidth: 130 }} />
              <button className="primary" type="submit">{mode === "login" ? "Sign in" : "Create"}</button>
            </div>
          </form>
          {error && <div className="error-box">⛔ {error}</div>}
        </div>
      </main>
    )
  }

  const isPlatform = user.role === "platform"
  const tabs: [Tab, string][] = isPlatform
    ? [["metrics", "📈 MRR & churn"], ["dunning", "⏰ Dunning"], ["invoices", "🧾 Invoices"]]
    : [["usage", "📊 Usage"], ["billing", "💳 Plan & billing"], ["invoices", "🧾 Invoices"]]

  const pct = usage ? Math.min(100, Math.round((usage.usedEvents / usage.includedEvents) * 100)) : 0

  return (
    <main className="container">
      <div className="topbar">
        <div>
          <h1>💳 MeterBill</h1>
          <div className="sub">
            {user.name} <Badge value={user.role} /> {user.tenantName && <strong>{user.tenantName}</strong>}
          </div>
        </div>
        <button className="ghost" onClick={async () => { await fetch("/api/auth", { method: "DELETE" }); setUser(null) }}>Sign out</button>
      </div>

      {newApiKey && (
        <div className="ok-box">
          🔑 Your tenant API key — shown <strong>once</strong>, store it now: <code>{newApiKey}</code>
          <button className="ghost" style={{ marginLeft: 10 }} onClick={() => setNewApiKey(null)}>Dismiss</button>
        </div>
      )}

      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => { setTab(t); setError(null); setNotice(null) }}>{label}</button>
        ))}
      </div>

      {error && <div className="error-box">⛔ {error}</div>}
      {notice && <div className="ok-box">✅ {notice}</div>}

      {tab === "usage" && usage && (
        <>
          <div className="grid">
            <div className="stat"><div className="label">Plan</div><div className="value" style={{ textTransform: "capitalize" }}>{usage.plan}</div></div>
            <div className="stat"><div className="label">Status</div><div className="value"><Badge value={usage.subscriptionStatus} /></div></div>
            <div className="stat"><div className="label">Events this period ({usage.period})</div><div className="value">{num(usage.usedEvents)}</div></div>
            <div className="stat"><div className="label">Projected invoice</div><div className="value">{fmt(usage.projectedTotalCents)}</div></div>
          </div>
          <div className="card">
            <h2>Quota</h2>
            <div className="meta">{num(usage.usedEvents)} of {num(usage.includedEvents)} included events used ({pct}%)</div>
            <div className="meter"><div className={usage.usedEvents > usage.includedEvents ? "over" : ""} style={{ width: `${pct}%` }} /></div>
            {usage.projectedOverageCents > 0 && (
              <p className="meta" style={{ marginTop: 10 }}>
                ⚡ Over quota — projected overage {fmt(usage.projectedOverageCents)} (billed per 1,000 events, rounded up).
              </p>
            )}
            <p className="meta" style={{ marginTop: 10 }}>
              Ingest usage from your systems with your API key — signed curl examples in <code>samples/api-examples.md</code>.
            </p>
          </div>
        </>
      )}

      {tab === "billing" && sub && (
        <>
          <div className="card">
            <h2>Plans</h2>
            <div className="row" style={{ alignItems: "stretch" }}>
              {sub.plans.map((p) => {
                const current = p.id === sub.subscription.plan && ["active", "past_due"].includes(sub.subscription.status)
                return (
                  <div key={p.id} className={`plan-card ${current ? "current" : ""}`}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <strong>{p.name}</strong>
                      {current && <Badge value="active" />}
                    </div>
                    <div className="price">{fmt(p.baseCents)}<span className="meta">/mo</span></div>
                    <div className="meta">{num(p.includedEvents)} events included</div>
                    <div className="meta">{p.overagePer1kCents > 0 ? `${fmt(p.overagePer1kCents)} per extra 1,000` : "hard quota — no overage billing"}</div>
                    {!current && (
                      <div style={{ marginTop: 10 }}>
                        <button className="primary" onClick={async () => { const r = await call("/api/subscription", "PATCH", { action: "changePlan", plan: p.id }); if (r) setNotice(`Plan changed to ${p.name}${r.movement ? ` (MRR movement: ${r.movement})` : ""}.`) }}>
                          {sub.subscription.status === "suspended" || sub.subscription.status === "canceled" ? "Reactivate on" : "Switch to"} {p.name}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="card">
            <h2>Billing controls</h2>
            <div className="row">
              <span className="meta">Demo card (mock mode):</span>
              <Badge value={sub.mockCard === "failing" ? "failed" : "paid"} />
              <button className="ghost" onClick={async () => { const r = await call("/api/subscription", "PATCH", { action: "setCard", card: sub.mockCard === "failing" ? "good" : "failing" }); if (r) setNotice(`Card set to ${r.mockCard}. ${r.mockCard === "failing" ? "New charges will decline — watch dunning kick in." : "Charges will succeed again — retry a past-due invoice to recover."}`) }}>
                Flip to {sub.mockCard === "failing" ? "good" : "failing"} card
              </button>
            </div>
            {["active", "past_due"].includes(sub.subscription.status) && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="ghost" onClick={async () => { const r = await call("/api/subscription", "PATCH", { action: "cancel" }); if (r) setNotice("Subscription canceled — churn recorded in MRR movements.") }}>Cancel subscription</button>
              </div>
            )}
          </div>
        </>
      )}

      {tab === "invoices" && (
        <div className="card">
          <h2>{isPlatform ? "All invoices" : "Invoices"} ({invoices.length})</h2>
          {isPlatform && (
            <form className="row" style={{ marginBottom: 12 }} onSubmit={async (e) => { e.preventDefault(); const r = await call("/api/invoices", "POST", { action: "generate", period: genPeriod }); if (r) setNotice(`Invoice run for ${genPeriod}: ${r.created} created, ${r.skipped} already existed (idempotent).`) }}>
              <input value={genPeriod} onChange={(e) => setGenPeriod(e.target.value)} placeholder="YYYY-MM" style={{ width: 120 }} />
              <button className="primary" type="submit">Generate invoices</button>
              <span className="meta">idempotent — run it twice, nothing duplicates</span>
            </form>
          )}
          <table>
            <thead><tr>{isPlatform && <th>Tenant</th>}<th>Period</th><th>Plan</th><th className="num">Usage</th><th className="num">Base</th><th className="num">Overage</th><th className="num">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  {isPlatform && <td>{inv.tenantName}</td>}
                  <td className="mono">{inv.period}</td>
                  <td><Badge value={inv.plan} /></td>
                  <td className="num">{num(inv.usedEvents)}</td>
                  <td className="num">{fmt(inv.baseCents)}</td>
                  <td className="num">{fmt(inv.overageCents)}</td>
                  <td className="num"><strong>{fmt(inv.totalCents)}</strong></td>
                  <td>
                    <Badge value={inv.status} />
                    {inv.status === "past_due" && <div className="meta">attempt {inv.attemptCount} · retry {fmtDate(inv.nextRetryAt)}</div>}
                    {(inv as { lastError?: string | null }).lastError && inv.status !== "paid" && <div className="meta">{(inv as { lastError?: string | null }).lastError}</div>}
                  </td>
                  <td>
                    {["pending", "past_due"].includes(inv.status) && (user.role === "owner" || isPlatform) && (
                      <button className="ghost" onClick={async () => { const r = await call("/api/invoices", "POST", { action: "pay", invoiceId: inv.id }); if (r) setNotice(r.succeeded ? `Paid — ref ${r.ref}` : `Charge failed: ${r.error}`) }}>Charge now</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "metrics" && isPlatform && metrics && (
        <>
          <div className="grid">
            <div className="stat"><div className="label">MRR</div><div className="value">{fmt(metrics.mrrCents)}</div></div>
            <div className="stat"><div className="label">Active tenants</div><div className="value">{metrics.activeTenants}</div></div>
            <div className="stat"><div className="label">Past due (in dunning)</div><div className="value">{metrics.pastDueTenants}</div></div>
            <div className="stat"><div className="label">Last month churn</div><div className="value">{metrics.months.length > 0 && metrics.months[metrics.months.length - 1].churnRatePct != null ? `${metrics.months[metrics.months.length - 1].churnRatePct}%` : "—"}</div></div>
          </div>
          <div className="card">
            <h2>MRR by plan</h2>
            <table>
              <thead><tr><th>Plan</th><th className="num">Tenants</th><th className="num">MRR</th></tr></thead>
              <tbody>
                {metrics.perPlan.map((p) => (
                  <tr key={p.plan}><td><Badge value={p.plan} /></td><td className="num">{p.tenants}</td><td className="num">{fmt(p.mrrCents)}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="meta" style={{ marginTop: 8 }}>MRR = committed base fees for active + past_due subscriptions. Metered overage is usage revenue and excluded on purpose.</p>
          </div>
          <div className="card">
            <h2>MRR movements by month</h2>
            <table>
              <thead><tr><th>Month</th><th className="num">New</th><th className="num">Expansion</th><th className="num">Contraction</th><th className="num">Churn</th><th className="num">Net</th><th className="num">Ending MRR</th><th className="num">Churn rate</th></tr></thead>
              <tbody>
                {metrics.months.map((m) => (
                  <tr key={m.month}>
                    <td className="mono">{m.month}</td>
                    <td className="num" style={{ color: "var(--good)" }}>+{fmt(m.newCents)}</td>
                    <td className="num" style={{ color: "var(--good)" }}>+{fmt(m.expansionCents)}</td>
                    <td className="num" style={{ color: "var(--warn)" }}>{fmt(m.contractionCents)}</td>
                    <td className="num" style={{ color: "var(--bad)" }}>{fmt(m.churnCents)}</td>
                    <td className="num"><strong>{m.netCents >= 0 ? "+" : ""}{fmt(m.netCents)}</strong></td>
                    <td className="num">{fmt(m.endingMrrCents)}</td>
                    <td className="num">{m.churnRatePct != null ? `${m.churnRatePct}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "dunning" && isPlatform && dunning && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ marginBottom: 0 }}>⏰ Dunning queue ({dunning.queue.length})</h2>
            <button className="primary" onClick={async () => { const r = await call("/api/admin/dunning", "POST"); if (r) setNotice(`Dunning run: ${r.attempted} attempted, ${r.recovered} recovered, ${r.stillFailing} still failing.`) }}>Run dunning cycle</button>
          </div>
          <p className="meta" style={{ marginTop: 6 }}>Retry ladder: +1d, +3d, +7d after the initial failure ({dunning.maxAttempts} attempts total). Exhaustion suspends the subscription and records churn.</p>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Tenant</th><th>Period</th><th className="num">Amount</th><th className="num">Attempts</th><th>Next retry</th><th>Last error</th></tr></thead>
            <tbody>
              {dunning.queue.map((q) => (
                <tr key={q.id}>
                  <td>{q.tenantName}</td>
                  <td className="mono">{q.period}</td>
                  <td className="num">{fmt(q.totalCents)}</td>
                  <td className="num">{q.attemptCount} / {dunning.maxAttempts}</td>
                  <td>{q.dueNow ? <span className="badge warn">due now</span> : fmtDate(q.nextRetryAt)}</td>
                  <td className="meta">{q.lastError ?? "—"}</td>
                </tr>
              ))}
              {dunning.queue.length === 0 && <tr><td colSpan={6} className="meta">Queue is empty — nothing past due. 🎉</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
