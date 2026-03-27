"""Worker-tier MCP tool policy for DocIndex — shares blocklist.json with CocoIndex mcp-gateway-go."""

from __future__ import annotations

import json
import os
from pathlib import Path


def truthy_env(name: str) -> bool:
    v = os.environ.get(name, "").strip().lower()
    return v in ("1", "true", "yes", "on")


def default_doc_mcp_blocklist_path() -> Path:
    return Path(__file__).resolve().parent.parent / "cocoindex-lancedb" / "mcp-gateway-go" / "blocklist.json"


def blocked_doc_mcp_tool_names() -> frozenset[str]:
    """When DOCINDEX_MCP_WORKER_SAFE is set, block admin tools listed under docindex in blocklist.json."""
    if not truthy_env("DOCINDEX_MCP_WORKER_SAFE"):
        return frozenset()
    raw = os.environ.get("DOCINDEX_MCP_BLOCKLIST_FILE", "").strip()
    path = Path(raw) if raw else default_doc_mcp_blocklist_path()
    if not path.is_file():
        return frozenset({"index_documents", "force_reindex"})
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        tools = data.get("docindex", [])
        return frozenset(str(x) for x in tools if isinstance(x, str))
    except (json.JSONDecodeError, OSError, TypeError):
        return frozenset({"index_documents", "force_reindex"})
