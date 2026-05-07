/**
 * JWT session management - create, verify, and decode session tokens.
 */
import * as jose from "jose"
import type { SessionPayload } from "./types"

/**
 * Create a signed JWT session token for an authenticated user.
 */
export async function createSessionToken(
  payload: Omit<SessionPayload, "iat" | "exp">,
  secret: string,
  maxAgeSeconds: number
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret)

  const now = Math.floor(Date.now() / 1000)

  const jwt = await new jose.SignJWT({
    sub: payload.sub,
    username: payload.username,
    name: payload.name,
    email: payload.email,
    avatar_url: payload.avatar_url,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(`${maxAgeSeconds}s`)
    .sign(secretKey)

  return jwt
}

/**
 * Verify and decode a JWT session token.
 * Returns the session payload if valid, null otherwise.
 */
export async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionPayload | null> {
  try {
    const secretKey = new TextEncoder().encode(secret)
    const { payload } = await jose.jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
    })

    return payload as unknown as SessionPayload
  } catch {
    return null
  }
}

/**
 * Extract session token from request cookies.
 */
export function extractSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null

  const cookies = cookieHeader.split(";").map((c) => c.trim())
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split("=")
    if (name === "forgejo_oauth_session") {
      return decodeURIComponent(valueParts.join("="))
    }
  }
  return null
}

/**
 * Build a Set-Cookie header value for the session cookie.
 */
export function buildSessionCookie(
  token: string,
  maxAgeSeconds: number,
  options: {
    domain?: string
    secure: boolean
  }
): string {
  const parts = [
    `forgejo_oauth_session=${encodeURIComponent(token)}`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAgeSeconds}`,
    `Path=/`,
  ]

  if (options.secure) {
    parts.push("Secure")
  }

  if (options.domain) {
    parts.push(`Domain=${options.domain}`)
  }

  return parts.join("; ")
}

/**
 * Build a Set-Cookie header to clear the session cookie (logout).
 */
export function buildClearSessionCookie(options: {
  domain?: string
  secure: boolean
}): string {
  const parts = [
    "forgejo_oauth_session=",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Path=/",
  ]

  if (options.secure) {
    parts.push("Secure")
  }

  if (options.domain) {
    parts.push(`Domain=${options.domain}`)
  }

  return parts.join("; ")
}
