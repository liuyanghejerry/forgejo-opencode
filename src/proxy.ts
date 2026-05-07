/**
 * Reverse proxy to forward authenticated requests to the OpenCode server.
 */
import type { Config, SessionPayload } from "./types"
import { extractSessionToken, verifySessionToken } from "./session"

const SESSION_COOKIE = "forgejo_oauth_session"

/**
 * Proxy a request to the OpenCode backend.
 * Strips auth cookies and adds identity headers before forwarding.
 */
export async function proxyToOpenCode(
  request: Request,
  session: SessionPayload,
  config: Config
): Promise<Response> {
  const targetUrl = new URL(request.url)
  const backendPath = targetUrl.pathname + targetUrl.search
  const backendUrl = `${config.opencodeBackendUrl}${backendPath}`

  // Clone headers, stripping the auth cookie
  const headers = new Headers(request.headers)
  if (headers.has("cookie")) {
    const cookies = headers
      .get("cookie")!
      .split(";")
      .map((c) => c.trim())
      .filter((c) => !c.startsWith(`${SESSION_COOKIE}=`))
    if (cookies.length > 0) {
      headers.set("cookie", cookies.join("; "))
    } else {
      headers.delete("cookie")
    }
  }

  // Add authenticated user identity headers
  headers.set("X-Authenticated-User", session.username)
  headers.set("X-Authenticated-Email", session.email)
  headers.set("X-Authenticated-Name", session.name)
  headers.set("X-Forwarded-User", session.username)

  // Build the proxied request
  const proxyRequest = new Request(backendUrl, {
    method: request.method,
    headers,
    body:
      request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
    redirect: "manual",
  })

  try {
    const response = await fetch(proxyRequest)

    // Bun fetch auto-decompresses the response body but keeps Content-Encoding.
    // Strip it to prevent browser double-decompression (ERR_CONTENT_DECODING_FAILED).
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.delete("transfer-encoding")
    headers.delete("content-length")

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "backend_unreachable",
        message: `Failed to connect to OpenCode backend at ${config.opencodeBackendUrl}`,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    )
  }
}

/**
 * Authentication middleware for the proxy.
 * Checks for a valid JWT session and either authenticates or redirects to login.
 */
export async function authMiddleware(
  request: Request,
  config: Config
): Promise<{
  authenticated: true
  session: SessionPayload
} | {
  authenticated: false
  redirectUrl: string
}> {
  const cookieHeader = request.headers.get("cookie")
  const token = extractSessionToken(cookieHeader)

  if (!token) {
    return { authenticated: false, redirectUrl: currentUrl(request) }
  }

  const session = await verifySessionToken(token, config.jwtSecret)

  if (!session) {
    return { authenticated: false, redirectUrl: currentUrl(request) }
  }

  return { authenticated: true, session }
}

function currentUrl(request: Request): string {
  const url = new URL(request.url)
  return url.pathname + url.search
}
