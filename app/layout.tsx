import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "MeterBill — Multi-Tenant SaaS Billing",
  description:
    "Metered billing with plan quotas, dunning retries, signed idempotent webhooks, and an MRR/churn dashboard.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
