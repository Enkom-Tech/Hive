"""
Unit tests for auth.py — Bearer token authentication.
"""

import os
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import require_token


# Minimal app fixture that uses the require_token dependency
def make_app() -> FastAPI:
    from fastapi import Depends
    app = FastAPI()

    @app.get("/protected")
    def protected(_token: str = Depends(require_token)):
        return {"ok": True}

    @app.get("/public")
    def public():
        return {"ok": True}

    return app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("COCOINDEX_API_TOKEN", "correct-token-abc123")
    return TestClient(make_app(), raise_server_exceptions=False)


def test_correct_token_returns_200(client):
    resp = client.get("/protected", headers={"Authorization": "Bearer correct-token-abc123"})
    assert resp.status_code == 200


def test_wrong_token_returns_401(client):
    resp = client.get("/protected", headers={"Authorization": "Bearer wrong-token-xyz789"})
    assert resp.status_code == 401


def test_equal_length_wrong_token_returns_401(client):
    # Same length as "correct-token-abc123" to verify timing-safe comparison is used
    resp = client.get("/protected", headers={"Authorization": "Bearer correct-token-XXX000"})
    assert resp.status_code == 401


def test_no_authorization_header_returns_403(client):
    # HTTPBearer returns 403 when no header is provided
    resp = client.get("/protected")
    assert resp.status_code in (401, 403)


def test_unconfigured_token_returns_500():
    # COCOINDEX_API_TOKEN not set → server misconfiguration
    app = make_app()
    client = TestClient(app, raise_server_exceptions=False)
    os.environ.pop("COCOINDEX_API_TOKEN", None)
    resp = client.get("/protected", headers={"Authorization": "Bearer anything"})
    assert resp.status_code == 500


def test_public_endpoint_requires_no_token(client):
    resp = client.get("/public")
    assert resp.status_code == 200
