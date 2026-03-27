"""DocIndex MCP worker-safe policy uses the same blocklist.json as CocoIndex mcp-gateway-go."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from docindex_mcp_policy import blocked_doc_mcp_tool_names, default_doc_mcp_blocklist_path, truthy_env


def test_truthy_env() -> None:
    import os

    assert truthy_env("MISSING_VAR_XYZ") is False
    os.environ["__T_TEST"] = "1"
    try:
        assert truthy_env("__T_TEST") is True
    finally:
        del os.environ["__T_TEST"]


def test_default_blocklist_path_exists() -> None:
    p = default_doc_mcp_blocklist_path()
    assert p.name == "blocklist.json"
    assert p.parent.name == "mcp-gateway-go"


def test_worker_safe_loads_docindex_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    bl = tmp_path / "blocklist.json"
    bl.write_text(json.dumps({"docindex": ["index_documents", "force_reindex"], "cocoindex": []}), encoding="utf-8")
    monkeypatch.setenv("DOCINDEX_MCP_WORKER_SAFE", "1")
    monkeypatch.setenv("DOCINDEX_MCP_BLOCKLIST_FILE", str(bl))
    assert blocked_doc_mcp_tool_names() == frozenset({"index_documents", "force_reindex"})


def test_worker_safe_off_allows_empty_blockset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DOCINDEX_MCP_WORKER_SAFE", raising=False)
    assert blocked_doc_mcp_tool_names() == frozenset()
