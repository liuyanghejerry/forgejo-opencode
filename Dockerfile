# ── Stage 1: Build OAuth2 proxy ──────────────────────────────
FROM oven/bun:1 AS proxy-builder

WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/
RUN bun install --frozen-lockfile && \
    bun build src/server.ts --target=bun --outdir=dist

# ── Stage 2: Runtime ─────────────────────────────────────────
FROM oven/bun:1-slim

# ── Pinned versions (override with --build-arg) ──
ARG OPENCODE_VERSION=1.14.31
ARG OMO_VERSION=3.17.5

LABEL org.opencontainers.image.title="forgejo-opencode-oauth2"
LABEL org.opencontainers.image.description="OpenCode + oh-my-openagent + Forgejo OAuth2 Proxy"
LABEL org.opencontainers.image.source="https://forgejo.draw.live/jerry/forgejo-opencode"
LABEL org.opencontainers.image.version="${OPENCODE_VERSION}"
LABEL org.opencontainers.image.omo-version="${OMO_VERSION}"

# ── System dependencies ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client tmux \
    && rm -rf /var/lib/apt/lists/*

# ── Create non-root user ──
RUN useradd --create-home --shell /bin/bash opencode && \
    mkdir -p /workspace /home/opencode/.config/opencode/plugins /home/opencode/.local/share/opencode && \
    chown -R opencode:opencode /workspace /home/opencode

# ── Install OpenCode (pinned version) ──
RUN npm install -g @opencode-ai/cli@${OPENCODE_VERSION}
ENV PATH="/root/.local/bin:${PATH}"

# ── Install oh-my-openagent (pinned version, non-interactive) ──
# Providers configured via mounted auth.json later
RUN bunx oh-my-opencode@${OMO_VERSION} install --no-tui --claude=no --chatgpt=no --gemini=no || true

# ── Copy default configs (auto-update disabled) ──
COPY config/opencode.json /home/opencode/.config/opencode/opencode.json
COPY config/oh-my-opencode.json /home/opencode/.config/opencode/oh-my-opencode.json
RUN chown -R opencode:opencode /home/opencode/.config/opencode

# ── Make installed binaries read-only to prevent runtime overwrite ──
RUN chmod -R a-w /root/.local/lib/node_modules /root/.local/bin 2>/dev/null || true

# ── Copy pre-built OAuth2 proxy ──
COPY --from=proxy-builder /build/dist/server.js /app/proxy.js

# ── Copy entrypoint ──
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# ── Copy plugin files (for OpenCode plugin loading) ──
COPY --chown=opencode:opencode plugin/ /home/opencode/.config/opencode/plugins/
COPY --chown=opencode:opencode .opencode/plugins/ /home/opencode/.config/opencode/plugins/

EXPOSE 3000 4096

WORKDIR /workspace
USER opencode
ENTRYPOINT ["/docker-entrypoint.sh"]
