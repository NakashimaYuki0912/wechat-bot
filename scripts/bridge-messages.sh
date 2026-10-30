#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
docker compose -f deploy/compose.yaml exec -T bridge node /app/bridge/reliable.js messages
