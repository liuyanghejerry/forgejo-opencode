/**
 * MCP token bridge: launched by OpenCode as the MCP server "command". Reads
 * the latest stored Forgejo OAuth token, refreshes it if it is near expiry,
 * sets FORGEJOMCP_SERVER and FORGEJOMCP_TOKEN, then execs the real
 * forgejo-mcp binary in stdio mode.
 *
 * If no token is stored yet (user has not logged in), we emit a JSON-RPC
 * error frame on stderr and exit non-zero so OpenCode surfaces a useful
 * message instead of hanging on a silent stdio process.
 */
import { spawn } from "node:child_process"
import { loadConfig } from "./config"
import { TokenStore } from "./tokenstore"
import { refreshAccessToken } from "./oauth"

const REFRESH_LEEWAY_SEC = 300
const FORGEJO_MCP_BINARY = process.env.FORGEJO_MCP_BINARY || "/usr/local/bin/forgejo-mcp"

async function main(): Promise<void> {
  const config = loadConfig()
  const store = new TokenStore(config.tokenStoreDir, config.jwtSecret)

  const token = await store.loadLatest()
  if (!token) {
    console.error(
      "[forgejo-mcp-bridge] No stored Forgejo token found. " +
        "Log in via the OAuth proxy first, then restart this MCP server.",
    )
    process.exit(2)
  }

  let accessToken = token.accessToken
  const now = Math.floor(Date.now() / 1000)

  if (token.expiresAt - now < REFRESH_LEEWAY_SEC && token.refreshToken) {
    try {
      const fresh = await refreshAccessToken(config, token.refreshToken)
      accessToken = fresh.access_token
      const ttl = fresh.expires_in ?? 3600
      await store.save({
        username: token.username,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token ?? token.refreshToken,
        expiresAt: now + ttl,
        updatedAt: now,
      })
      console.error(`[forgejo-mcp-bridge] Refreshed token for ${token.username}`)
    } catch (err) {
      console.error(
        `[forgejo-mcp-bridge] Token refresh failed (continuing with existing token):`,
        err,
      )
    }
  }

  const args = process.argv.slice(2)
  const finalArgs = args.length > 0 ? args : ["stdio"]

  const child = spawn(FORGEJO_MCP_BINARY, finalArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      FORGEJOMCP_SERVER: config.forgejoUrl,
      FORGEJOMCP_TOKEN: accessToken,
    },
  })

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  child.on("error", (err) => {
    console.error(`[forgejo-mcp-bridge] Failed to spawn ${FORGEJO_MCP_BINARY}:`, err)
    process.exit(1)
  })
}

main().catch((err) => {
  console.error("[forgejo-mcp-bridge] Fatal:", err)
  process.exit(1)
})
