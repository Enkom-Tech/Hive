"""
Bearer token authentication for CocoIndex API.
Token is read from COCOINDEX_API_TOKEN environment variable, which must be
injected from a Kubernetes Secret via secretKeyRef — never hardcoded.
Uses hmac.compare_digest to prevent timing attacks.
"""

import hmac
import os

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer = HTTPBearer()


def require_token(
    creds: HTTPAuthorizationCredentials = Security(_bearer),
) -> str:
    """
    FastAPI dependency that enforces Bearer token authentication.
    Inject with: dependencies=[Depends(require_token)]

    Returns the validated token string on success.
    Raises HTTP 401 on wrong token, HTTP 500 if server is misconfigured.
    """
    expected = os.environ.get("COCOINDEX_API_TOKEN", "")
    if not expected:
        raise HTTPException(
            status_code=500,
            detail="Server authentication not configured (COCOINDEX_API_TOKEN unset)",
        )
    if not hmac.compare_digest(creds.credentials.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return creds.credentials
