#!/usr/bin/env bash
# Optional smoke: Moltis join and optionally claim. Exit 0 if join 201; with --claim, exit 0 if claim 200 and agent exists.
# Requires: HIVE_URL, INVITE_TOKEN, MOLTIS_WS_URL, MOLTIS_TOKEN (for join). For --claim: REQUEST_ID, CLAIM_SECRET.
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

HIVE_URL="${HIVE_URL:-http://localhost:3100}"
INVITE_TOKEN="${INVITE_TOKEN:-}"
MOLTIS_WS_URL="${MOLTIS_WS_URL:-}"
MOLTIS_TOKEN="${MOLTIS_TOKEN:-}"
REQUEST_ID="${REQUEST_ID:-}"
CLAIM_SECRET="${CLAIM_SECRET:-}"

API_BASE="${HIVE_URL%/}/api"

do_claim=false
for arg in "$@"; do
  if [[ "$arg" == "--claim" ]]; then
    do_claim=true
    break
  fi
done

if [[ "$do_claim" == "true" ]]; then
  if [[ -z "$REQUEST_ID" || -z "$CLAIM_SECRET" ]]; then
    echo "Usage: REQUEST_ID=<id> CLAIM_SECRET=<secret> $0 --claim" >&2
    echo "Approve the join request in Hive UI first, then run with REQUEST_ID and CLAIM_SECRET from the join response." >&2
    exit 1
  fi
  CODE=$(curl -sS -o /tmp/moltis_claim.json -w "%{http_code}" -X POST "${API_BASE}/join-requests/${REQUEST_ID}/claim-api-key" \
    -H "Content-Type: application/json" \
    -d "{\"claimSecret\":\"${CLAIM_SECRET}\"}")
  if [[ "$CODE" != "200" ]]; then
    echo "claim-api-key returned HTTP $CODE" >&2
    cat /tmp/moltis_claim.json | jq . 2>/dev/null || cat /tmp/moltis_claim.json
    exit 1
  fi
  AGENT_ID=$(jq -r '.agentId // empty' /tmp/moltis_claim.json)
  if [[ -z "$AGENT_ID" ]]; then
    echo "claim response missing agentId" >&2
    exit 1
  fi
  echo "Claim OK, agentId=$AGENT_ID"
  exit 0
fi

# Join
if [[ -z "$INVITE_TOKEN" || -z "$MOLTIS_WS_URL" || -z "$MOLTIS_TOKEN" ]]; then
  echo "Usage: INVITE_TOKEN=... MOLTIS_WS_URL=... MOLTIS_TOKEN=... $0" >&2
  echo "Optional: after approve, REQUEST_ID=... CLAIM_SECRET=... $0 --claim" >&2
  exit 1
fi

BODY=$(jq -n \
  --arg url "$MOLTIS_WS_URL" \
  --arg token "$MOLTIS_TOKEN" \
  --arg hiveUrl "$HIVE_URL" \
  '{
    requestType: "agent",
    agentName: "Moltis Smoke Agent",
    adapterType: "openclaw_gateway",
    capabilities: "Moltis smoke",
    agentDefaultsPayload: {
      url: $url,
      gatewayVariant: "moltis",
      hiveApiUrl: $hiveUrl,
      headers: { "x-openclaw-token": $token },
      waitTimeoutMs: 120000,
      sessionKeyStrategy: "issue",
      role: "operator",
      scopes: ["operator.admin"]
    }
  }')

CODE=$(curl -sS -o /tmp/moltis_join.json -w "%{http_code}" -X POST "${API_BASE}/invites/${INVITE_TOKEN}/accept" \
  -H "Content-Type: application/json" \
  -d "$BODY")

if [[ "$CODE" != "202" ]]; then
  echo "invite accept (join) returned HTTP $CODE" >&2
  cat /tmp/moltis_join.json | jq . 2>/dev/null || cat /tmp/moltis_join.json
  exit 1
fi

echo "Join accepted (202). Approve in Hive UI, then run:"
echo "  REQUEST_ID=<id> CLAIM_SECRET=<claimSecret> $0 --claim"
jq -r 'if .id then "  REQUEST_ID=\(.id) CLAIM_SECRET=\(.claimSecret // "<from-response>")" else empty end' /tmp/moltis_join.json 2>/dev/null || true
exit 0
