/**
 * The plan catalog lives in code, versioned with the app — not in the
 * database — so a plan change is a reviewed pull request, not a silent row
 * edit. Tenants reference plans by id.
 *
 * Pricing model: flat base fee + metered overage. Usage events beyond the
 * plan's included quota are billed per 1,000 events (integer cents — no
 * fractional-cent-per-event floats). Overage is rounded UP to the next
 * thousand, which is standard metered-billing practice and must be stated
 * in the pricing page fine print.
 */

export type PlanId = "free" | "starter" | "pro"

export type Plan = {
  id: PlanId
  name: string
  baseCents: number
  includedEvents: number
  /** cents per 1,000 events beyond the included quota */
  overagePer1kCents: number
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free", baseCents: 0, includedEvents: 1_000, overagePer1kCents: 0 },
  starter: { id: "starter", name: "Starter", baseCents: 2_900, includedEvents: 50_000, overagePer1kCents: 20 },
  pro: { id: "pro", name: "Pro", baseCents: 9_900, includedEvents: 250_000, overagePer1kCents: 10 },
}

export function isPlanId(value: string): value is PlanId {
  return value === "free" || value === "starter" || value === "pro"
}

/**
 * Overage for a period. Free-plan usage beyond quota is recorded but never
 * billed — free tenants get an upgrade nudge, not a surprise invoice.
 */
export function overageCents(plan: Plan, usedEvents: number): number {
  if (plan.overagePer1kCents === 0) return 0
  const over = usedEvents - plan.includedEvents
  if (over <= 0) return 0
  return Math.ceil(over / 1_000) * plan.overagePer1kCents
}

export function invoiceTotalCents(plan: Plan, usedEvents: number): number {
  return plan.baseCents + overageCents(plan, usedEvents)
}
