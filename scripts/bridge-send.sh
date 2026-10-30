#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
if [ "$#" -eq 0 ]; then
  echo "usage: $0 <text>" >&2
  exit 2
fi
# This only inserts a queued outbox row. The single bridge worker sends it.
docker compose -f deploy/compose.yaml exec -T bridge node /app/bridge/reliable.js send "$*"
echo
echo "queued only; check status with: ./scripts/bridge-status.sh"
