import { requireRole } from "@/lib/auth"
import { computeMetrics } from "@/lib/metrics"

export const dynamic = "force-dynamic"

/** GET — platform-operator MRR/churn dashboard data. */
export async function GET() {
  const user = await requireRole("platform")
  if (user instanceof Response) return user
  return Response.json(await computeMetrics())
}
