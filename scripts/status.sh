#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
TOKEN="$(tr -d '\r\n' < data/mimicwx/api-token)"
echo "=== containers ==="
docker compose -f deploy/compose.yaml ps
echo
echo "=== API /status ==="
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18899/status 2>&1 || true
echo
echo "=== reliable bridge state ==="
docker compose -f deploy/compose.yaml exec -T bridge node /app/bridge/reliable.js status 2>&1 | head -80 || true
echo
echo "=== recent ingest log ==="
docker logs --tail 15 wechat-bot-ingest 2>&1 || true
echo
echo "=== recent bridge log ==="
tail -20 data/reliability/bridge.log 2>/dev/null || true
echo
echo "=== recent agent log ==="
tail -20 data/reliability/agent.log 2>/dev/null || true
