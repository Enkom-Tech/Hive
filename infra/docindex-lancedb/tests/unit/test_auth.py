"""
Unit tests for auth.py — Bearer token authentication.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from auth import require_token


def make_app() -> FastAPI:
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
    monkeypatch.setenv("DOCINDEX_API_TOKEN", "correct-token-abc123")
    return TestClient(make_app(), raise_server_exceptions=False)


def test_correct_token_returns_200(client):
    resp = client.get("/protected", headers={"Authorization": "Bearer correct-token-abc123"})
    assert resp.status_code == 200


def test_wrong_token_returns_401(client):
    resp = client.get("/protected", headers={"Authorization": "Bearer wrong-token-xyz789"})
    assert resp.status_code == 401


def test_equal_length_wrong_token_returns_401(client):
    resp = client.get("/protected", headers={"Authorization": "Bearer correct-token-XXX000"})
    assert resp.status_code == 401


def test_no_authorization_header_returns_403_or_401(client):
    resp = client.get("/protected")
    assert resp.status_code in (401, 403)


def test_unconfigured_token_returns_500(monkeypatch):
    monkeypatch.delenv("DOCINDEX_API_TOKEN", raising=False)
    app = make_app()
    tc = TestClient(app, raise_server_exceptions=False)
    resp = tc.get("/protected", headers={"Authorization": "Bearer anything"})
    assert resp.status_code == 500


def test_public_endpoint_requires_no_token(client):
    resp = client.get("/public")
    assert resp.status_code == 200
