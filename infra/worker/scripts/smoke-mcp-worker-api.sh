#!/usr/bin/env bash
# Optional smoke: worker-mediated control plane from an enrolled drone context.
#
# curl mode (default): POST /api/worker-api/cost-report with a worker-instance JWT.
# stdio mode: pipe JSON-RPC to "hive-worker mcp" (same env as a real agent run: state dir,
# HIVE_AGENT_ID, control plane URL, etc.).
#
# Environment (curl):
#   WORKER_JWT       — Bearer token (worker_instance JWT)
#   HIVE_AGENT_ID    — UUID of an active agent in that company
#   HIVE_API_BASE    — e.g. https://cp.example.com/api  (or set HIVE_CONTROL_PLANE_URL; /api is appended)
#
# Environment (stdio, SMOKE_MODE=stdio):
#   HIVE_WORKER_BINARY — path to hive-worker (default: hive-worker on PATH)
#   Plus normal hive-worker mcp env (HIVE_WORKER_STATE_DIR with worker-jwt, HIVE_CONTROL_PLANE_URL, …)
#
# Exit 0 on success; exit 0 with message to stderr if required env is missing (CI-friendly skip);
# non-zero on failure.

set -euo pipefail

SMOKE_MODE="${SMOKE_MODE:-curl}"

api_base="${HIVE_API_BASE:-}"
if [[ -z "$api_base" && -n "${HIVE_CONTROL_PLANE_URL:-}" ]]; then
  base="${HIVE_CONTROL_PLANE_URL%/}"
  if [[ "$base" == */api ]]; then
    api_base="$base"
  else
    api_base="${base}/api"
  fi
fi

assert_jq_or_grep_ok() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -e '.ok == true' >/dev/null
  else
    echo "$json" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
  fi
}

if [[ "$SMOKE_MODE" == "curl" ]]; then
  if [[ -z "${WORKER_JWT:-}" || -z "${HIVE_AGENT_ID:-}" || -z "$api_base" ]]; then
    echo "SKIP: set WORKER_JWT, HIVE_AGENT_ID, and HIVE_API_BASE (or HIVE_CONTROL_PLANE_URL)" >&2
    exit 0
  fi
  occurred_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  body="$(curl -sfS -X POST "${api_base%/}/worker-api/cost-report" \
    -H "Authorization: Bearer ${WORKER_JWT}" \
    -H "Content-Type: application/json" \
    -d "{\"agentId\":\"${HIVE_AGENT_ID}\",\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"costCents\":0,\"occurredAt\":\"${occurred_at}\"}")"
  assert_jq_or_grep_ok "$body"
  echo "OK: worker-api cost-report"
  exit 0
fi

if [[ "$SMOKE_MODE" == "stdio" ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP: SMOKE_MODE=stdio requires jq to parse newline-delimited JSON-RPC" >&2
    exit 0
  fi
  if [[ -z "${HIVE_AGENT_ID:-}" ]]; then
    echo "SKIP: HIVE_AGENT_ID required for MCP stdio smoke" >&2
    exit 0
  fi
  BIN="${HIVE_WORKER_BINARY:-hive-worker}"
  if ! command -v "$BIN" >/dev/null 2>&1 && [[ "$BIN" == "hive-worker" ]]; then
    echo "SKIP: hive-worker not on PATH; set HIVE_WORKER_BINARY" >&2
    exit 0
  fi
  # Minimal initialize + tools/call cost.report (worker injects agentId).
  out="$(
    {
      echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}'
      echo '{"jsonrpc":"2.0","id":2,"method":"notifications/initialized","params":{}}'
      echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cost.report","arguments":{"provider":"openai","model":"gpt-4o-mini","costCents":0}}}'
    } | "$BIN" mcp 2>/dev/null
  )"
  if ! echo "$out" | jq -es 'map(select(.id == 3)) | .[0] | (.error == null) and (.result != null)' | grep -q true; then
    echo "FAIL: MCP id=3 missing result or has error" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "OK: MCP stdio cost.report"
  exit 0
fi

echo "Unknown SMOKE_MODE=$SMOKE_MODE (use curl or stdio)" >&2
exit 2
