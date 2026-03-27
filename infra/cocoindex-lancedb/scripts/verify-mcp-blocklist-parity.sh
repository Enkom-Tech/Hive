#!/usr/bin/env bash
# Ensures a single canonical blocklist.json is wired for both Go (mcp-gateway-go) and Python (mcp_gateway.py).
# Run from repo root or from infra/cocoindex-lancedb (script locates paths relative to this file).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(cd "$SCRIPT_DIR/.." && pwd)"
BL="$BASE/mcp-gateway-go/blocklist.json"
MAIN="$BASE/mcp-gateway-go/main.go"
PY="$BASE/mcp_gateway.py"

test -f "$BL" || { echo "verify-mcp-blocklist-parity: missing $BL" >&2; exit 1; }
grep -q '//go:embed blocklist.json' "$MAIN" || {
  echo "verify-mcp-blocklist-parity: $MAIN must contain //go:embed blocklist.json" >&2
  exit 1
}
grep -qE 'mcp-gateway-go/blocklist\.json|blocklist\.json' "$PY" || {
  echo "verify-mcp-blocklist-parity: $PY must reference mcp-gateway-go/blocklist.json (or blocklist.json)" >&2
  exit 1
}
python3 -c "import json; d=json.load(open('$BL')); assert 'cocoindex' in d and 'docindex' in d, 'keys'; assert isinstance(d['cocoindex'], list) and isinstance(d['docindex'], list)"
