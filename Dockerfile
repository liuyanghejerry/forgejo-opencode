# ── Stage 1: Build OAuth2 proxy ──────────────────────────────
FROM oven/bun:1 AS proxy-builder

WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/
RUN bun install --frozen-lockfile && \
    bun build src/server.ts --target=bun --outdir=dist && \
    bun build src/mcp-bridge.ts --target=bun --outdir=dist

# ── Stage 2: Fetch forgejo-mcp pre-built binary ──────────────
FROM debian:12-slim AS forgejo-mcp-fetcher

ARG FORGEJO_MCP_VERSION=v0.0.7
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pre-built binaries are published per-arch on the upstream releases page;
# we verify the sha1 sum that ships alongside each asset before installing.
# Sha1 is what upstream provides - not ideal vs sha256 but better than nothing,
# and the binary is also fetched over TLS from github.com.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64) ARCH=amd64 ;; \
        arm64) ARCH=arm64 ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    BASE="https://github.com/raohwork/forgejo-mcp/releases/download/${FORGEJO_MCP_VERSION}"; \
    curl -fsSL -o /tmp/forgejo-mcp "${BASE}/forgejo-mcp.linux.${ARCH}"; \
    curl -fsSL -o /tmp/forgejo-mcp.sha1 "${BASE}/forgejo-mcp.linux.${ARCH}.sha1"; \
    EXPECTED=$(cut -d' ' -f1 /tmp/forgejo-mcp.sha1); \
    ACTUAL=$(sha1sum /tmp/forgejo-mcp | cut -d' ' -f1); \
    if [ "$EXPECTED" != "$ACTUAL" ]; then \
        echo "forgejo-mcp checksum mismatch: expected=$EXPECTED actual=$ACTUAL" >&2; \
        exit 1; \
    fi; \
    chmod +x /tmp/forgejo-mcp

# ── Stage 3: Runtime ─────────────────────────────────────────
FROM oven/bun:1-slim

ARG OPENCODE_VERSION=1.14.31
ARG OMO_VERSION=3.17.5

LABEL org.opencontainers.image.title="forgejo-opencode-oauth2"
LABEL org.opencontainers.image.description="OpenCode + oh-my-openagent + Forgejo OAuth2 Proxy"
LABEL org.opencontainers.image.source="https://github.com/liuyanghejerry/forgejo-opencode"
LABEL org.opencontainers.image.version="${OPENCODE_VERSION}"

# ── Install system deps ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client tmux \
    && rm -rf /var/lib/apt/lists/*

# ── Install OpenCode (pinned version) ──
ENV BUN_INSTALL=/usr/local
RUN bun install -g opencode-ai@${OPENCODE_VERSION}

# ── Install oh-my-openagent (pinned version, non-interactive) ──
RUN bunx oh-my-opencode@${OMO_VERSION} install --no-tui || true

# ── Cleanup caches ──
RUN rm -rf /root/.cache /tmp/*

# ── Create non-root user ──
RUN useradd --create-home --shell /bin/bash opencode && \
    mkdir -p /workspace /home/opencode/.config/opencode/plugins /home/opencode/.local/share/opencode && \
    chown -R opencode:opencode /workspace /home/opencode

# ── Copy configs, proxy, plugin, entrypoint, MCP binary ──
COPY config/opencode.json /home/opencode/.config/opencode/opencode.json
COPY config/oh-my-opencode.json /home/opencode/.config/opencode/oh-my-opencode.json
COPY --from=proxy-builder /build/dist/server.js /app/proxy.js
COPY --from=proxy-builder /build/dist/mcp-bridge.js /app/mcp-bridge.js
COPY --from=forgejo-mcp-fetcher /tmp/forgejo-mcp /usr/local/bin/forgejo-mcp
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY --chown=opencode:opencode plugin/ /home/opencode/.config/opencode/plugins/
COPY --chown=opencode:opencode .opencode/plugins/ /home/opencode/.config/opencode/plugins/

# Wrapper that lets OpenCode launch the bridge as a single command. The bridge
# itself is a Bun-bundled program that loads the user's stored OAuth token
# and execs forgejo-mcp with the right env vars.
RUN printf '#!/bin/sh\nexec bun run /app/mcp-bridge.js "$@"\n' > /usr/local/bin/forgejo-mcp-bridge && \
    chmod +x /usr/local/bin/forgejo-mcp-bridge

RUN chmod +x /docker-entrypoint.sh /usr/local/bin/forgejo-mcp && \
    chown -R opencode:opencode /home/opencode/.config/opencode && \
    chmod -R a-w /usr/local/bin 2>/dev/null || true

# Only expose the OAuth2 proxy port. The OpenCode backend listens on 127.0.0.1
# inside the container and must NEVER be reached without going through the proxy.
EXPOSE 3000
WORKDIR /workspace
ENTRYPOINT ["/docker-entrypoint.sh"]
