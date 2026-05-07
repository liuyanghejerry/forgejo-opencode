#!/bin/bash
set -e

echo "============================================"
echo " Forgejo OpenCode OAuth2 Stack"
echo "============================================"
echo ""

# ── Defaults ──
OAUTH2_PROXY_PORT="${OAUTH2_PROXY_PORT:-3000}"
OAUTH2_PROXY_HOST="${OAUTH2_PROXY_HOST:-0.0.0.0}"
OPENCODE_BACKEND_URL="${OPENCODE_BACKEND_URL:-http://localhost:4096}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCODE_HOSTNAME="${OPENCODE_HOSTNAME:-127.0.0.1}"

# ── Enforce oh-my-openagent auto-update disabled ──
OMO_CONFIG="$HOME/.config/opencode/oh-my-opencode.json"
if [ ! -f "$OMO_CONFIG" ]; then
    echo "[INFO] Creating oh-my-opencode.json with auto-update disabled..."
    mkdir -p "$(dirname "$OMO_CONFIG")"
    cat > "$OMO_CONFIG" <<'EOF'
{
  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-openagent.schema.json",
  "disabled_hooks": [
    "auto-update-checker"
  ]
}
EOF
else
    echo "[INFO] oh-my-opencode.json exists, auto-update control via mounted config"
fi

# ── Validate required OAuth2 config (warn, don't fail) ──
if [ -z "$FORGEJO_CLIENT_ID" ] || [ -z "$FORGEJO_CLIENT_SECRET" ] || [ -z "$JWT_SECRET" ]; then
    echo "[WARN] OAuth2 proxy not fully configured. Set FORGEJO_CLIENT_ID, FORGEJO_CLIENT_SECRET, and JWT_SECRET."
    echo "[WARN] OAuth2 proxy will still start but auth will fail until configured."
    echo ""
fi

# ── Start OpenCode server in background ──
echo "[INFO] Starting OpenCode server on ${OPENCODE_HOSTNAME}:${OPENCODE_PORT}..."
opencode serve \
    --hostname "$OPENCODE_HOSTNAME" \
    --port "$OPENCODE_PORT" \
    &
OPENCODE_PID=$!

# Wait for OpenCode to be ready
echo "[INFO] Waiting for OpenCode server..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${OPENCODE_PORT}/" | grep -qE "^(200|302|303)$"; then
        echo "[INFO] OpenCode server is ready."
        break
    fi
    if [ $i -eq 30 ]; then
        echo "[WARN] OpenCode server may not be ready, proceeding..."
    fi
    sleep 1
done

# ── Start OAuth2 proxy ──
echo "[INFO] Starting OAuth2 proxy on ${OAUTH2_PROXY_HOST}:${OAUTH2_PROXY_PORT}..."
echo "[INFO] Proxying to OpenCode backend at ${OPENCODE_BACKEND_URL}"
echo ""

exec bun run /app/proxy.js
