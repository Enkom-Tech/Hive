#!/usr/bin/env bash
# Optional full stack smoke test when docker compose is already running.
# Requires: curl, DOCINDEX_API_TOKEN (and queue secrets if compose uses them).
set -euo pipefail
BASE="${DOCINDEX_URL:-http://127.0.0.1:8082}"
TOKEN="${DOCINDEX_API_TOKEN:?set DOCINDEX_API_TOKEN}"

curl -sfS "${BASE}/health" | grep -q healthy
curl -sfS -X POST "${BASE}/index" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"force_reindex":true}' | grep -q duration_ms
curl -sfS -X POST "${BASE}/search" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","limit":3}' | grep -q file_path

echo "docindex e2e-smoke: ok"
