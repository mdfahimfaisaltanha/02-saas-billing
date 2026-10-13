import { createHash, randomBytes } from "node:crypto"

/**
 * Tenant API keys for usage ingestion. Format `mb_live_<40 hex>`.
 * Only the SHA-256 hash is stored — the plaintext key is shown exactly once
 * (at signup / in the seed output). Lookup is by hash, so a database leak
 * doesn't leak usable keys.
 */

export function generateApiKey(): string {
  return `mb_live_${randomBytes(20).toString("hex")}`
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}
