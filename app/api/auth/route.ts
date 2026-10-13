import { getPool } from "@/lib/db"
import { createSession, destroySession, getSession, hashPassword, verifyPassword } from "@/lib/auth"
import { generateApiKey, hashApiKey } from "@/lib/apikeys"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json({ user: await getSession() })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: "Invalid JSON body." }, { status: 400 })
  const mode = body.mode === "signup" ? "signup" : "login"
  const email = String(body.email ?? "").trim().toLowerCase()
  const password = String(body.password ?? "")
  if (!email || !password) {
    return Response.json({ error: "Email and password are required." }, { status: 400 })
  }
  const pool = getPool()

  if (mode === "login") {
    const res = await pool.query(`SELECT id, password_hash FROM users WHERE email = $1`, [email])
    // Same error for unknown email and wrong password — no account enumeration.
    if (res.rows.length === 0 || !verifyPassword(password, res.rows[0].password_hash)) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 })
    }
    await createSession(res.rows[0].id)
    return Response.json({ user: await getSession() })
  }

  // Signup: creates a tenant + owner + free subscription + API key (shown once).
  const name = String(body.name ?? "").trim()
  const company = String(body.company ?? "").trim()
  if (!name || !company) {
    return Response.json({ error: "Your name and a company name are required." }, { status: 400 })
  }
  if (password.length < 10) {
    return Response.json({ error: "Password must be at least 10 characters." }, { status: 400 })
  }
  const dupe = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email])
  if (dupe.rows.length > 0) {
    return Response.json({ error: "An account with that email already exists." }, { status: 409 })
  }

  const apiKey = generateApiKey()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const tenant = await client.query(
      `INSERT INTO tenants (name, api_key_hash, mock_card) VALUES ($1, $2, 'good') RETURNING id`,
      [company, hashApiKey(apiKey)],
    )
    const tenantId = tenant.rows[0].id
    const user = await client.query(
      `INSERT INTO users (tenant_id, name, email, role, password_hash)
       VALUES ($1, $2, $3, 'owner', $4) RETURNING id`,
      [tenantId, name, email, hashPassword(password)],
    )
    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, status) VALUES ($1, 'free', 'active')`,
      [tenantId],
    )
    await client.query("COMMIT")
    await createSession(user.rows[0].id)
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
  // The plaintext API key exists only in this response.
  return Response.json({ user: await getSession(), apiKey })
}

export async function DELETE() {
  await destroySession()
  return Response.json({ ok: true })
}
