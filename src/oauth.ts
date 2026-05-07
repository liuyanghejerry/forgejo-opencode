/**
 * Forgejo OAuth2 flow handlers - authorize, callback, token exchange, user info.
 */
import type { Config, OAuth2Tokens, ForgejoUser, OAuthState } from "./types"

/**
 * PKCE (Proof Key for Code Exchange) utilities for enhanced OAuth2 security.
 */

/** Generate a cryptographically random string for PKCE code verifier */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** Generate a PKCE code challenge from a verifier (S256 method) */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

/** Base64url encoding (without padding) */
function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** In-memory store for OAuth2 state (code verifier + return URL) */
const stateStore = new Map<string, OAuthState>()

/** Clean up expired state entries every 5 minutes */
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of stateStore) {
    if (now - value.createdAt > 600_000) {
      // 10 minutes
      stateStore.delete(key)
    }
  }
}, 300_000)

/**
 * Build the Forgejo OAuth2 authorization URL and generate PKCE state.
 */
export async function buildAuthorizationUrl(
  config: Config,
  returnTo: string
): Promise<{ url: string; state: string }> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateCodeVerifier() // Separate random value for CSRF state

  // Store state for callback verification
  stateStore.set(state, {
    codeVerifier,
    returnTo,
    state,
    createdAt: Date.now(),
  })

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Scopes required for the bundled forgejo-mcp tools to operate on behalf
    // of the user: read identity, manage repositories, manage issues.
    scope: "read:user write:repository write:issue",
  })

  const url = `${config.forgejoUrl}/login/oauth/authorize?${params.toString()}`
  return { url, state }
}

/**
 * Handle the OAuth2 callback - exchange code for tokens, then fetch user info.
 * Returns both the user and the return-to URL from the stored state.
 */
export async function handleCallback(
  config: Config,
  code: string,
  state: string
): Promise<{ user: ForgejoUser; returnTo: string; tokens: OAuth2Tokens }> {
  const stored = stateStore.get(state)
  if (!stored) {
    throw new OAuthError("invalid_state", "OAuth2 state parameter is missing or expired")
  }

  const returnTo = stored.returnTo
  stateStore.delete(state)

  const tokens = await exchangeCodeForTokens(config, code, stored.codeVerifier)
  const user = await fetchUserInfo(config, tokens.access_token)

  return { user, returnTo, tokens }
}

/**
 * Exchange a refresh token for a fresh access token. Used by the token bridge
 * when the stored access token is near expiry.
 */
export async function refreshAccessToken(
  config: Config,
  refreshToken: string,
): Promise<OAuth2Tokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })

  const response = await fetch(`${config.forgejoUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new OAuthError(
      "refresh_failed",
      `Refresh token exchange returned HTTP ${response.status}`,
    )
  }

  const data = (await response.json()) as Record<string, unknown>
  if ("error" in data) {
    throw new OAuthError(
      String(data.error || "refresh_failed"),
      String(data.error_description || "Failed to refresh access token"),
    )
  }
  return data as unknown as OAuth2Tokens
}

/**
 * Exchange an authorization code for OAuth2 tokens.
 */
async function exchangeCodeForTokens(
  config: Config,
  code: string,
  codeVerifier: string
): Promise<OAuth2Tokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  })

  const response = await fetch(`${config.forgejoUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new OAuthError(
      "token_exchange_failed",
      `Token exchange returned HTTP ${response.status}`
    )
  }

  const data = (await response.json()) as Record<string, unknown>

  if ("error" in data) {
    throw new OAuthError(
      String(data.error || "token_exchange_failed"),
      String(data.error_description || "Failed to exchange authorization code")
    )
  }

  return data as unknown as OAuth2Tokens
}

/**
 * Fetch the authenticated user's information from Forgejo's API.
 */
async function fetchUserInfo(config: Config, accessToken: string): Promise<ForgejoUser> {
  const response = await fetch(`${config.forgejoUrl}/api/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })

  if (!response.ok) {
    throw new OAuthError(
      "user_fetch_failed",
      `Failed to fetch user info: HTTP ${response.status}`
    )
  }

  return response.json() as Promise<ForgejoUser>
}

/**
 * Check if a user is a member of a specific Forgejo organization.
 */
export async function checkOrgMembership(
  config: Config,
  accessToken: string,
  orgName: string,
  username: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${config.forgejoUrl}/api/v1/orgs/${encodeURIComponent(orgName)}/members/${encodeURIComponent(username)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    )
    return response.status === 204
  } catch {
    return false
  }
}

/**
 * Custom error class for OAuth2 errors.
 */
export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
    this.name = "OAuthError"
  }
}
