/**
 * Type definitions for the Forgejo OpenCode OAuth2 Proxy.
 */

/** OAuth2 tokens returned by Forgejo's token endpoint */
export interface OAuth2Tokens {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
}

/** User information fetched from Forgejo's API */
export interface ForgejoUser {
  id: number
  login: string
  username: string
  full_name: string
  email: string
  avatar_url: string
  language: string
  is_admin: boolean
  last_login: string
  created: string
  restricted: boolean
  active: boolean
  prohibit_login: boolean
  location: string
  website: string
  description: string
  visibility: string
}

/** User email from Forgejo's emails API */
export interface ForgejoEmail {
  email: string
  verified: boolean
  primary: boolean
  user_id: number
}

/** JWT session payload */
export interface SessionPayload {
  /** Forgejo user ID */
  sub: string
  /** Forgejo username */
  username: string
  /** Forgejo user full name */
  name: string
  /** Forgejo user email */
  email: string
  /** Forgejo user avatar URL */
  avatar_url: string
  /** Session issued at (Unix timestamp) */
  iat: number
  /** Session expiration (Unix timestamp) */
  exp: number
}

/** Resolved configuration */
export interface Config {
  proxyPort: number
  proxyHost: string
  opencodeBackendUrl: string
  forgejoUrl: string
  clientId: string
  clientSecret: string
  jwtSecret: string
  sessionMaxAge: number
  redirectUri: string
  allowedUsers: string[]
  allowedOrgs: string[]
  cookieDomain?: string
  behindProxy: boolean
}

/** Error response for OAuth2 failures */
export interface OAuthError {
  error: string
  error_description?: string
}

/** OAuth2 state stored during the authorization flow */
export interface OAuthState {
  /** PKCE code verifier */
  codeVerifier: string
  /** URL to redirect back to after auth */
  returnTo: string
  /** CSRF state token */
  state: string
  /** Timestamp when state was created */
  createdAt: number
}

/** Authentication check response for the plugin tool */
export interface AuthStatus {
  authenticated: boolean
  username?: string
  email?: string
  expiresAt?: number
  forgejoUrl: string
}
