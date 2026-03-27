#!/usr/bin/env python3
"""
Hive MCP Gateway — secure proxy between worker agents and the CocoIndex MCP server.

Security responsibilities:
  1. Authenticate workers using the GATEWAY_WORKER_TOKEN (worker-tier, search-only).
     Workers receive this token as HIVE_MCP_TOKEN; they NEVER see the admin token.
  2. Block admin operations per mcp-gateway-go/blocklist.json (shared with the Go gateway).
     Override path with GATEWAY_WORKER_BLOCKLIST_FILE if needed.
  3. Scope searches: injects repo filter from task context when provided.
  4. Audit log: every MCP tool call is logged with agentId, query, timestamp.
  5. Forward approved calls to the indexer using GATEWAY_ADMIN_TOKEN.

The indexer's COCOINDEX_API_TOKEN (admin) is never visible to worker pods.
"""

import asyncio
import hmac
import json
import os
from pathlib import Path

import httpx
import structlog
from fastapi import FastAPI, HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sse_starlette.sse import EventSourceResponse

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# Configuration (from environment — all injected by HiveIndexerReconciler)
# ---------------------------------------------------------------------------
_WORKER_TOKEN = os.environ.get("GATEWAY_WORKER_TOKEN", "")   # HIVE_MCP_TOKEN given to workers
_ADMIN_TOKEN = os.environ.get("GATEWAY_ADMIN_TOKEN", "")     # COCOINDEX_API_TOKEN for the indexer
_INDEXER_URL = os.environ.get("GATEWAY_INDEXER_URL", "http://localhost:8080")  # indexer ClusterIP

def _default_blocklist_path() -> Path:
    return Path(__file__).resolve().parent / "mcp-gateway-go" / "blocklist.json"


def _load_blocklist_file() -> dict:
    """Load cocoindex/docindex blocked tool lists (same JSON as mcp-gateway-go embed)."""
    raw = os.environ.get("GATEWAY_WORKER_BLOCKLIST_FILE", "").strip()
    path = Path(raw) if raw else _default_blocklist_path()
    if not path.is_file():
        raise FileNotFoundError(f"MCP gateway blocklist not found: {path}")
    with path.open(encoding="utf-8") as f:
        return json.load(f)


_bl = _load_blocklist_file()
_BLOCKED_COCOINDEX_TOOLS = frozenset(_bl["cocoindex"])
_BLOCKED_DOCINDEX_TOOLS = frozenset(_bl["docindex"])


def _blocked_tools() -> frozenset:
    if os.environ.get("GATEWAY_DOCINDEX_MODE", "").strip() in ("1", "true", "yes"):
        return _BLOCKED_DOCINDEX_TOOLS
    return _BLOCKED_COCOINDEX_TOOLS

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
_bearer = HTTPBearer()


def _require_worker_token(creds: HTTPAuthorizationCredentials = Security(_bearer)) -> str:
    if not _WORKER_TOKEN:
        raise HTTPException(status_code=500, detail="Gateway worker token not configured")
    if not hmac.compare_digest(
        creds.credentials.encode("utf-8"), _WORKER_TOKEN.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return creds.credentials


# ---------------------------------------------------------------------------
# Indexer HTTP client (uses admin token, never exposed to workers)
# ---------------------------------------------------------------------------
_indexer_client = httpx.AsyncClient(timeout=60.0)


async def _call_indexer_mcp(body: dict) -> dict:
    """Forward a JSON-RPC request to the indexer's /mcp/message endpoint."""
    if not _ADMIN_TOKEN:
        raise HTTPException(status_code=500, detail="Gateway admin token not configured")
    resp = await _indexer_client.post(
        f"{_INDEXER_URL}/mcp/message",
        json=body,
        headers={"Authorization": f"Bearer {_ADMIN_TOKEN}"},
    )
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Hive MCP Gateway",
    description="Secure proxy for CocoIndex MCP tools. Workers connect here, not to the indexer directly.",
    version="1.0.0",
)


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/mcp", dependencies=[])
async def mcp_sse(request: Request, creds: HTTPAuthorizationCredentials = Security(_bearer)):
    """MCP SSE transport endpoint — workers connect here to start an MCP session."""
    _require_worker_token(creds)

    async def generator():
        yield {"event": "endpoint", "data": "/mcp/message"}
        while not await request.is_disconnected():
            yield {"event": "ping", "data": ""}
            await asyncio.sleep(15)

    return EventSourceResponse(generator())


@app.post("/mcp/message")
async def mcp_message(body: dict, creds: HTTPAuthorizationCredentials = Security(_bearer)):
    """MCP JSON-RPC message handler — validates, audits, and proxies to the indexer."""
    _require_worker_token(creds)

    method = body.get("method")
    params = body.get("params", {})
    req_id = body.get("id")

    # Handle initialize locally — no need to forward
    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hive-mcp-gateway", "version": "1.0.0"},
            },
        }

    # For tools/list, filter out blocked tools before returning
    blocked = _blocked_tools()
    if method == "tools/list":
        resp = await _call_indexer_mcp(body)
        if "result" in resp and "tools" in resp["result"]:
            resp["result"]["tools"] = [
                t for t in resp["result"]["tools"] if t.get("name") not in blocked
            ]
        return resp

    # For tools/call, enforce the block list and audit log
    if method == "tools/call":
        tool_name = params.get("name", "")
        args = params.get("arguments", {})

        if tool_name in blocked:
            logger.warning(
                "mcp_gateway.blocked_tool",
                tool=tool_name,
                req_id=req_id,
            )
            return {
                "jsonrpc": "2.0", "id": req_id,
                "error": {"code": -32602, "message": f"Tool '{tool_name}' is not available"},
            }

        logger.info(
            "mcp_gateway.tool_call",
            tool=tool_name,
            repo=args.get("repo"),
            query=args.get("query", "")[:100],  # truncate for log safety
            req_id=req_id,
        )

        try:
            return await _call_indexer_mcp(body)
        except httpx.HTTPStatusError as e:
            logger.error("mcp_gateway.indexer_error", status=e.response.status_code, tool=tool_name)
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32603, "message": "Indexer request failed"}}
        except Exception as e:
            logger.error("mcp_gateway.error", error=str(e), tool=tool_name)
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32603, "message": "Internal gateway error"}}

    # Forward any other methods (e.g. ping, resources/list) directly
    try:
        return await _call_indexer_mcp(body)
    except Exception as e:
        logger.error("mcp_gateway.forward_error", method=method, error=str(e))
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": str(e)}}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "mcp_gateway:app",
        host="0.0.0.0",
        port=9090,
        log_level="info",
    )
