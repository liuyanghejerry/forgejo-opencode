/**
 * Main OAuth2 proxy server entry point.
 *
 * Start with: bun run src/server.ts
 * Or: OAUTH2_PROXY_PORT=3000 FORGEJO_URL=https://git.example.com ... bun run src/server.ts
 */
import { Hono } from "hono"
import type { Server } from "bun"
import { loadConfig, logConfig } from "./config"
import { buildAuthorizationUrl, handleCallback, OAuthError } from "./oauth"
import { createSessionToken, buildSessionCookie, buildClearSessionCookie } from "./session"
import { proxyToOpenCode, authMiddleware } from "./proxy"
import { createRateLimiter, getClientIp } from "./ratelimit"

const app = new Hono<{ Variables: { clientIp: string } }>()

try {
  const config = loadConfig()
  logConfig(config)

  const isSecure = config.behindProxy || config.redirectUri.startsWith("https")

  // Token-bucket: capacity equals one minute's worth of requests, refilled
  // at perMinute/60 tokens per second. Allows brief bursts while bounding
  // sustained throughput per client.
  const authLimiter = createRateLimiter({
    capacity: config.authRateLimitPerMinute,
    refillPerSecond: config.authRateLimitPerMinute / 60,
    maxKeys: 10_000,
  })
  const proxyLimiter = createRateLimiter({
    capacity: config.proxyRateLimitPerMinute,
    refillPerSecond: config.proxyRateLimitPerMinute / 60,
    maxKeys: 10_000,
  })

  function rateLimitResponse(retryAfterSec: number): Response {
    return new Response(
      JSON.stringify({ error: "rate_limited", retry_after: retryAfterSec }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSec),
        },
      },
    )
  }

  app.use("*", async (c, next) => {
    const env = c.env as { clientIp?: string } | undefined
    c.set("clientIp", env?.clientIp ?? "unknown")
    await next()
  })

  app.use("/auth/*", async (c, next) => {
    const retry = authLimiter.check(`ip:${c.get("clientIp")}`)
    if (retry !== null) return rateLimitResponse(retry)
    await next()
  })

  // --- Auth routes ---

  // GET /auth/login - Start OAuth2 flow
  app.get("/auth/login", async (c) => {
    const returnTo = c.req.query("return_to") || "/"
    try {
      const { url } = await buildAuthorizationUrl(config, returnTo)
      return c.redirect(url)
    } catch (error) {
      console.error("Failed to build authorization URL:", error)
      return c.text("Authentication Error: Failed to start OAuth2 flow. Check server logs.", 500)
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
      return c.text(`Authentication Failed: Forgejo returned an error: ${error}`, 400)
    }

    if (!code) {
      return c.text("Authentication Failed: No authorization code received.", 400)
    }

    if (!state) {
      return c.text(
        "Authentication Failed: No state parameter received. Possible CSRF attack.",
        400,
      )
    }

    try {
      const { user, returnTo } = await handleCallback(config, code, state)

      // Check access control
      if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(user.username)) {
        console.warn(`Access denied for user: ${user.username} (not in allowlist)`)
        return c.text(
          `Access Denied: User ${user.username} is not authorized to access this proxy.`,
          403,
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
        return c.text(`Authentication Error: ${error.message} (${error.code})`, 500)
      }
      console.error("Unexpected auth error:", error)
      return c.text("Authentication Error: An unexpected error occurred. Check server logs.", 500)
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
      const currentPath = new URL(c.req.url).pathname + new URL(c.req.url).search
      const loginUrl = `/auth/login?return_to=${encodeURIComponent(currentPath || "/")}`
      return c.redirect(loginUrl)
    }

    const retry = proxyLimiter.check(`sub:${result.session.sub}`)
    if (retry !== null) return rateLimitResponse(retry)

    return proxyToOpenCode(c.req.raw, result.session, config)
  })

  // --- Start server ---
  console.log(`\nStarting proxy server on http://${config.proxyHost}:${config.proxyPort} ...\n`)

  Bun.serve({
    hostname: config.proxyHost,
    port: config.proxyPort,
    fetch(request: Request, server: Server<unknown>) {
      const socketAddr = server.requestIP(request)?.address
      const clientIp = getClientIp(request, socketAddr, config.behindProxy)
      return app.fetch(request, { clientIp })
    },
  })
} catch (error) {
  console.error("Failed to start OAuth2 proxy server:", error)
  process.exit(1)
}
