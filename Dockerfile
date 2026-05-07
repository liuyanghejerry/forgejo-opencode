# ── Stage 1: Build OAuth2 proxy ──────────────────────────────
FROM oven/bun:1 AS proxy-builder

WORKDIR /build
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/
RUN bun install --frozen-lockfile && \
    bun build src/server.ts --target=bun --outdir=dist

# ── Stage 2: Runtime ─────────────────────────────────────────
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
RUN bun install -g opencode-ai@${OPENCODE_VERSION}

# ── Install oh-my-openagent (pinned version, non-interactive) ──
RUN bunx oh-my-opencode@${OMO_VERSION} install --no-tui || true

# ── Cleanup caches ──
RUN rm -rf /root/.bun/install/cache /root/.cache /tmp/*

# ── Ensure bun global bin is on PATH for all users ──
ENV BUN_INSTALL=/root/.bun
ENV PATH="/root/.bun/bin:${PATH}"

# ── Create non-root user ──
RUN useradd --create-home --shell /bin/bash opencode && \
    mkdir -p /workspace /home/opencode/.config/opencode/plugins /home/opencode/.local/share/opencode && \
    chown -R opencode:opencode /workspace /home/opencode

# ── Copy configs, proxy, plugin, entrypoint ──
COPY config/opencode.json /home/opencode/.config/opencode/opencode.json
COPY config/oh-my-opencode.json /home/opencode/.config/opencode/oh-my-opencode.json
COPY --from=proxy-builder /build/dist/server.js /app/proxy.js
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY --chown=opencode:opencode plugin/ /home/opencode/.config/opencode/plugins/
COPY --chown=opencode:opencode .opencode/plugins/ /home/opencode/.config/opencode/plugins/

RUN chmod +x /docker-entrypoint.sh && \
    chown -R opencode:opencode /home/opencode/.config/opencode && \
    chmod -R a-w /root/.bun 2>/dev/null || true

EXPOSE 3000 4096
WORKDIR /workspace
USER opencode
ENTRYPOINT ["/docker-entrypoint.sh"]
