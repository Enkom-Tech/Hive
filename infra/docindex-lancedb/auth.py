"""
Bearer token authentication for Hive DocIndex API.
Token is read from DOCINDEX_API_TOKEN environment variable, which must be
injected from a Kubernetes Secret via secretKeyRef — never hardcoded.
Uses hmac.compare_digest to prevent timing attacks.
"""

import hashlib
import hmac
import os
import random

import structlog
from fastapi import HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer = HTTPBearer()
_audit = structlog.get_logger("docindex.audit")


def _token_fingerprint(token: str) -> str:
    """First 12 hex chars of SHA-256 — enough for log correlation, not enough to reconstruct."""
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def _auth_success_log_sample_rate() -> float:
    """0 = never log successful auth; 1 = always; (0,1) = Bernoulli sample (reduces log I/O under load)."""
    raw = os.environ.get("DOCINDEX_AUTH_SUCCESS_LOG_SAMPLE_RATE", "0").strip()
    if not raw:
        return 0.0
    try:
        return max(0.0, min(1.0, float(raw)))
    except ValueError:
        return 0.0


def require_token(
    request: Request,
    creds: HTTPAuthorizationCredentials = Security(_bearer),
) -> str:
    """
    FastAPI dependency that enforces Bearer token authentication.
    Inject with: dependencies=[Depends(require_token)]

    Returns the validated token string on success.
    Raises HTTP 401 on wrong token, HTTP 500 if server is misconfigured.
    """
    expected = os.environ.get("DOCINDEX_API_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=500,
            detail="Server authentication not configured (DOCINDEX_API_TOKEN unset)",
        )
    if not hmac.compare_digest(creds.credentials.encode(), expected.encode()):
        _audit.warning(
            "auth_failed",
            path=request.url.path,
            client=request.client.host if request.client else "unknown",
        )
        raise HTTPException(status_code=401, detail="Unauthorized")
    rate = _auth_success_log_sample_rate()
    if rate >= 1.0 or (rate > 0 and random.random() < rate):
        _audit.info(
            "auth_ok",
            path=request.url.path,
            client=request.client.host if request.client else "unknown",
            token_sha256=_token_fingerprint(creds.credentials),
        )
    return creds.credentials
