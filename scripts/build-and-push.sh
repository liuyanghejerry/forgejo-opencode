#!/bin/bash
# Build and push Docker image to GitHub Container Registry
# Usage:
#   ./scripts/build-and-push.sh              # push to latest
#   ./scripts/build-and-push.sh v1.0.0       # push with version tag
set -euo pipefail

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE="${REGISTRY}/${GITHUB_USER:-liuyanghejerry}/forgejo-opencode"
USERNAME="${GITHUB_USER:-liuyanghejerry}"
TAG="${1:-latest}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.14.31}"
OMO_VERSION="${OMO_VERSION:-3.17.5}"

echo "============================================"
echo " Building and pushing Docker image"
echo " Image:   ${IMAGE}:${TAG}"
echo " OpenCode: v${OPENCODE_VERSION}"
echo " omo:     v${OMO_VERSION}"
echo "============================================"
echo ""

if [ -z "${REGISTRY_TOKEN:-}" ]; then
    echo "[ERROR] REGISTRY_TOKEN (GitHub PAT) is not set."
    echo ""
    echo "Generate a token at: https://github.com/settings/tokens"
    echo "Required scope: write:packages"
    echo ""
    echo "Then run:"
    echo "  export REGISTRY_TOKEN=ghp_xxxxxxxxxxxx"
    echo "  ./scripts/build-and-push.sh"
    exit 1
fi

echo "[1/3] Logging in to GitHub Container Registry..."
echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" --username "$USERNAME" --password-stdin

echo "[2/3] Building image..."
docker build \
    -t "${IMAGE}:${TAG}" \
    -t "${IMAGE}:latest" \
    --build-arg "OPENCODE_VERSION=${OPENCODE_VERSION}" \
    --build-arg "OMO_VERSION=${OMO_VERSION}" \
    -f Dockerfile \
    .

echo "[3/3] Pushing image..."
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

echo ""
echo "Done! Image published: ${IMAGE}:${TAG}"
echo ""
echo "Pull with:"
echo "  docker pull ${IMAGE}:${TAG}"
