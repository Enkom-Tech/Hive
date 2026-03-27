#!/usr/bin/env bash
# Optional full stack smoke test when docker compose (or equivalent) is already running.
# Requires: curl, COCOINDEX_API_TOKEN in the environment.
set -euo pipefail
BASE="${COCOINDEX_URL:-http://127.0.0.1:8080}"
TOKEN="${COCOINDEX_API_TOKEN:?set COCOINDEX_API_TOKEN}"

curl -sfS "${BASE}/health" | grep -q healthy
curl -sfS -X POST "${BASE}/index" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"force_reindex":true}' | grep -q duration_ms
curl -sfS -X POST "${BASE}/search" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query":"def","limit":3}' | grep -q file_path

echo "cocoindex e2e-smoke: ok"
