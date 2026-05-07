/**
 * Configuration loader - reads from environment variables with validation.
 */
import type { Config } from "./types"

export function loadConfig(): Config {
  const port = parseInt(process.env.OAUTH2_PROXY_PORT || "3000", 10)
  const host = process.env.OAUTH2_PROXY_HOST || "0.0.0.0"
  const opencodeBackendUrl = process.env.OPENCODE_BACKEND_URL || "http://localhost:4096"
  const forgejoUrl = (process.env.FORGEJO_URL || "https://codeberg.org").replace(/\/+$/, "")
  const clientId = process.env.FORGEJO_CLIENT_ID || ""
  const clientSecret = process.env.FORGEJO_CLIENT_SECRET || ""
  const jwtSecret = process.env.JWT_SECRET || ""
  const sessionMaxAge = parseInt(process.env.SESSION_MAX_AGE || "86400", 10)
  const redirectUri = process.env.OAUTH2_REDIRECT_URI || `http://localhost:${port}/auth/callback`
  const allowedUsers = (process.env.FORGEJO_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const allowedOrgs = (process.env.FORGEJO_ALLOWED_ORGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const cookieDomain = process.env.COOKIE_DOMAIN || undefined
  const behindProxy = process.env.BEHIND_PROXY === "true"

  // Validate required configuration
  const errors: string[] = []

  if (!clientId) {
    errors.push(
      "FORGEJO_CLIENT_ID is required. Create an OAuth2 application at " +
        `${forgejoUrl}/user/settings/applications`
    )
  }
  if (!clientSecret) {
    errors.push("FORGEJO_CLIENT_SECRET is required")
  }
  if (!jwtSecret || jwtSecret.length < 32) {
    errors.push(
      "JWT_SECRET is required and must be at least 32 characters. " +
        "Generate one with: openssl rand -hex 32"
    )
  }
  if (!forgejoUrl) {
    errors.push("FORGEJO_URL is required")
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`)
  }

  // Validate URLs
  try {
    new URL(opencodeBackendUrl)
  } catch {
    throw new Error(`OPENCODE_BACKEND_URL is not a valid URL: ${opencodeBackendUrl}`)
  }
  try {
    new URL(forgejoUrl)
  } catch {
    throw new Error(`FORGEJO_URL is not a valid URL: ${forgejoUrl}`)
  }
  try {
    new URL(redirectUri)
  } catch {
    throw new Error(`OAUTH2_REDIRECT_URI is not a valid URL: ${redirectUri}`)
  }

  return {
    proxyPort: port,
    proxyHost: host,
    opencodeBackendUrl,
    forgejoUrl,
    clientId,
    clientSecret,
    jwtSecret,
    sessionMaxAge,
    redirectUri,
    allowedUsers,
    allowedOrgs,
    cookieDomain,
    behindProxy,
  }
}

/** Log configuration on startup (masking secrets) */
export function logConfig(config: Config): void {
  console.log("╔══════════════════════════════════════════════════════╗")
  console.log("║   Forgejo OpenCode OAuth2 Proxy                     ║")
  console.log("╠══════════════════════════════════════════════════════╣")
  console.log(`║ Proxy listening on:   http://${config.proxyHost}:${config.proxyPort}`)
  console.log(`║ OpenCode backend:     ${config.opencodeBackendUrl}`)
  console.log(`║ Forgejo instance:     ${config.forgejoUrl}`)
  console.log(`║ OAuth2 redirect URI:  ${config.redirectUri}`)
  console.log(`║ Session max age:      ${config.sessionMaxAge}s`)
  console.log(`║ Client ID:            ${config.clientId.substring(0, 8)}...`)
  console.log(`║ Client Secret:        ${"*".repeat(16)}`)
  console.log(`║ JWT Secret:           ${"*".repeat(16)}`)
  if (config.allowedUsers.length > 0) {
    console.log(`║ Allowed users:        ${config.allowedUsers.join(", ")}`)
  }
  if (config.allowedOrgs.length > 0) {
    console.log(`║ Allowed orgs:         ${config.allowedOrgs.join(", ")}`)
  }
  if (config.behindProxy) {
    console.log("║ Behind proxy:         true (secure cookies enabled)")
  }
  console.log("╚══════════════════════════════════════════════════════╝")
}
