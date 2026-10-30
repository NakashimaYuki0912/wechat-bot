#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
source config/env.sh
export DOCKER_CONFIG="$ROOT/work/docker-config"
export BUILDX_CONFIG="$ROOT/work/buildx"

MAIN_IMAGE="wechat-bot-mimicwx:4.1.13.26-a42a3ee"
INGEST_IMAGE="wechat-bot-mimicwx:4.1.13.26-reliable2"

mkdir -p work/docker-config work/buildx data/mimicwx data/wechat/home data/wechat/key data/bridge data/reliability logs/wechat
chmod 700 data/wechat/home data/wechat/key data/reliability
chmod 600 data/mimicwx/api-token data/mimicwx/config.toml data/wechat/vnc-password

need_build=0
if [ "${1:-}" = "--build" ]; then need_build=1; fi
if ! docker image inspect "$MAIN_IMAGE" >/dev/null 2>&1; then need_build=1; fi
if ! docker image inspect "$INGEST_IMAGE" >/dev/null 2>&1; then need_build=1; fi

if [ "$need_build" = "1" ]; then
  # Build the main image and the ingest image from the same pinned Dockerfile.
  # The second build is cache-served; it is needed because compose uses a
  # separate image tag for the independent DB-cursor ingest.
  docker build -f deploy/image/Dockerfile -t "$MAIN_IMAGE" .
  docker build -f deploy/image/Dockerfile -t "$INGEST_IMAGE" .
fi

docker compose -f deploy/compose.yaml up -d

echo
echo "containers:"
docker compose -f deploy/compose.yaml ps
echo
echo "loopback endpoints:"
echo "  API       http://127.0.0.1:18899/status"
echo "  noVNC     http://127.0.0.1:16080/vnc.html"
echo "  VNC       vnc://127.0.0.1:15901 (optional raw VNC; use a VNC client)"
echo
echo "from your PC, first run:"
echo "  ssh -N -L 16080:127.0.0.1:16080 -L 18899:127.0.0.1:18899 -L 15901:127.0.0.1:15901 kirby@<server>"
echo "then open http://127.0.0.1:16080/vnc.html"
