export const forgejoOauth = async ({ client: _client, directory: _directory, $: _$ }: Record<string, any>) => {
  const proxyUrl = process.env.OAUTH2_PROXY_URL || "http://localhost:3000"

  return {
    tool: {
      forgejo_oauth_status: {
        description:
          "Check the Forgejo OAuth2 proxy authentication status. " +
          "Returns whether the current user is authenticated, their Forgejo username, " +
          "and session expiry information.",
        args: {},
        async execute(_args: Record<string, unknown>, _context: Record<string, unknown>) {
          try {
            const response = await fetch(`${proxyUrl}/auth/status`, {
              headers: { Accept: "application/json" },
            })
            const data = await response.json()
            return JSON.stringify(data, null, 2)
          } catch (error) {
            return JSON.stringify(
              {
                authenticated: false,
                error: "proxy_unreachable",
                message: `Cannot reach OAuth2 proxy at ${proxyUrl}. Is it running?`,
                proxyUrl,
              },
              null,
              2
            )
          }
        },
      },
    },
  }
}
