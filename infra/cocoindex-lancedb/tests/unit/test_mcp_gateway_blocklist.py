"""Contract tests: Python gateway uses the same blocklist.json as mcp-gateway-go."""

import json
from pathlib import Path

import pytest


def _blocklist_path() -> Path:
    return Path(__file__).resolve().parents[2] / "mcp-gateway-go" / "blocklist.json"


def test_blocklist_json_shape() -> None:
    path = _blocklist_path()
    assert path.is_file(), f"missing {path}"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert "cocoindex" in data and "docindex" in data
    assert isinstance(data["cocoindex"], list)
    assert isinstance(data["docindex"], list)


def test_blocked_tools_match_json() -> None:
    data = json.loads(_blocklist_path().read_text(encoding="utf-8"))
    import mcp_gateway

    assert mcp_gateway._BLOCKED_COCOINDEX_TOOLS == frozenset(data["cocoindex"])
    assert mcp_gateway._BLOCKED_DOCINDEX_TOOLS == frozenset(data["docindex"])


def test_blocked_tools_mode_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    import mcp_gateway

    monkeypatch.delenv("GATEWAY_DOCINDEX_MODE", raising=False)
    blocked = mcp_gateway._blocked_tools()
    assert "index_repository" in blocked
    assert "index_documents" not in blocked

    monkeypatch.setenv("GATEWAY_DOCINDEX_MODE", "1")
    blocked_doc = mcp_gateway._blocked_tools()
    assert "index_documents" in blocked_doc
    assert "index_repository" not in blocked_doc
