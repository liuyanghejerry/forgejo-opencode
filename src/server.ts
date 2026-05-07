/**
 * Main OAuth2 proxy server entry point.
 *
 * Start with: bun run src/server.ts
 * Or: OAUTH2_PROXY_PORT=3000 FORGEJO_URL=https://git.example.com ... bun run src/server.ts
 */
import { Hono } from "hono"
import { loadConfig, logConfig } from "./config"
import { buildAuthorizationUrl, handleCallback, OAuthError } from "./oauth"
import { createSessionToken, buildSessionCookie, buildClearSessionCookie } from "./session"
import { proxyToOpenCode, authMiddleware } from "./proxy"

const app = new Hono()

try {
  const config = loadConfig()
  logConfig(config)

  const isSecure = config.behindProxy || config.redirectUri.startsWith("https")

  // --- Auth routes ---

  // GET /auth/login - Start OAuth2 flow
  app.get("/auth/login", async (c) => {
    const returnTo = c.req.query("return_to") || "/"
    try {
      const { url } = await buildAuthorizationUrl(config, returnTo)
      return c.redirect(url)
    } catch (error) {
      console.error("Failed to build authorization URL:", error)
      return c.html(
        `<h1>Authentication Error</h1><p>Failed to start OAuth2 flow. Check server logs.</p>`,
        500
      )
    }
  })

  // GET /auth/callback - OAuth2 callback from Forgejo
  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code")
    const state = c.req.query("state")
    const error = c.req.query("error")
    const errorDescription = c.req.query("error_description")

    if (error) {
      console.error(`OAuth2 error from Forgejo: ${error} - ${errorDescription}`)
      return c.html(
        `<h1>Authentication Failed</h1><p>Forgejo returned an error: ${error}</p>`,
        400
      )
    }

    if (!code) {
      return c.html(
        `<h1>Authentication Failed</h1><p>No authorization code received.</p>`,
        400
      )
    }

    if (!state) {
      return c.html(
        `<h1>Authentication Failed</h1><p>No state parameter received. Possible CSRF attack.</p>`,
        400
      )
    }

    try {
      const { user, returnTo } = await handleCallback(config, code, state)

      // Check access control
      if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(user.username)) {
        console.warn(`Access denied for user: ${user.username} (not in allowlist)`)
        return c.html(
          `<h1>Access Denied</h1><p>User <strong>${user.username}</strong> is not authorized to access this proxy.</p>`,
          403
        )
      }

      // Create session
      const token = await createSessionToken(
        {
          sub: String(user.id),
          username: user.username,
          name: user.full_name || user.username,
          email: user.email,
          avatar_url: user.avatar_url,
        },
        config.jwtSecret,
        config.sessionMaxAge
      )

      const cookie = buildSessionCookie(token, config.sessionMaxAge, {
        domain: config.cookieDomain,
        secure: isSecure,
      })

      // Redirect back to where the user was going
      return new Response(null, {
        status: 302,
        headers: {
          Location: returnTo,
          "Set-Cookie": cookie,
        },
      })
    } catch (error) {
      if (error instanceof OAuthError) {
        console.error(`OAuth error: ${error.code} - ${error.message}`)
        return c.html(
          `<h1>Authentication Error</h1><p>${error.message} (${error.code})</p>`,
          500
        )
      }
      console.error("Unexpected auth error:", error)
      return c.html(
        `<h1>Authentication Error</h1><p>An unexpected error occurred. Check server logs.</p>`,
        500
      )
    }
  })

  // GET /auth/logout - Clear session
  app.get("/auth/logout", (c) => {
    const cookie = buildClearSessionCookie({
      domain: config.cookieDomain,
      secure: isSecure,
    })
    return c.html(
      `<h1>Logged Out</h1><p>You have been logged out. <a href="/auth/login">Login again</a></p>`,
      200,
      { "Set-Cookie": cookie }
    )
  })

  // GET /auth/status - Check authentication status (useful for health checks)
  app.get("/auth/status", async (c) => {
    const result = await authMiddleware(c.req.raw, config)
    if (result.authenticated) {
      return c.json({
        authenticated: true,
        username: result.session.username,
        email: result.session.email,
        expiresAt: result.session.exp,
        forgejoUrl: config.forgejoUrl,
      })
    }
    return c.json({
      authenticated: false,
      forgejoUrl: config.forgejoUrl,
    })
  })

  // --- Proxy all other routes to OpenCode ---
  app.all("*", async (c) => {
    const result = await authMiddleware(c.req.raw, config)

    if (!result.authenticated) {
      // Store the current URL to redirect back after login
      const currentPath = new URL(c.req.url).pathname + new URL(c.req.url).search
      const loginUrl = `/auth/login?return_to=${encodeURIComponent(currentPath || "/")}`
      return c.redirect(loginUrl)
    }

    return proxyToOpenCode(c.req.raw, result.session, config)
  })

  // --- Start server ---
  console.log(`\nStarting proxy server on http://${config.proxyHost}:${config.proxyPort} ...\n`)

  Bun.serve({
    hostname: config.proxyHost,
    port: config.proxyPort,
    fetch: app.fetch,
  })
} catch (error) {
  console.error("Failed to start OAuth2 proxy server:", error)
  process.exit(1)
}
