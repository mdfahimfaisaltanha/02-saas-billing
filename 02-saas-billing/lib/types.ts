import type { PlanId } from "./plans"

export type Role = "owner" | "member" | "platform"

export type SessionUser = {
  id: number
  name: string
  email: string
  role: Role
  tenantId: number | null
  tenantName: string | null
}

export type SubscriptionStatus = "active" | "past_due" | "suspended" | "canceled"

export type Subscription = {
  id: number
  tenantId: number
  plan: PlanId
  status: SubscriptionStatus
  createdAt: string
  canceledAt: string | null
}

export type InvoiceStatus = "pending" | "paid" | "past_due" | "failed" | "void"

export type Invoice = {
  id: number
  tenantId: number
  tenantName?: string
  period: string // YYYY-MM
  plan: PlanId
  baseCents: number
  includedEvents: number
  usedEvents: number
  overageCents: number
  totalCents: number
  status: InvoiceStatus
  attemptCount: number
  nextRetryAt: string | null
  paidAt: string | null
  createdAt: string
}

export type PaymentAttempt = {
  id: number
  invoiceId: number
  provider: string
  ref: string | null
  status: "succeeded" | "failed"
  error: string | null
  createdAt: string
}

export type MovementType = "new" | "expansion" | "contraction" | "churn" | "reactivation"

export type MrrMetrics = {
  mrrCents: number
  activeTenants: number
  pastDueTenants: number
  perPlan: Array<{ plan: PlanId; tenants: number; mrrCents: number }>
  months: Array<{
    month: string // YYYY-MM
    newCents: number
    expansionCents: number
    contractionCents: number
    churnCents: number
    netCents: number
    endingMrrCents: number
    churnRatePct: number | null
  }>
}
