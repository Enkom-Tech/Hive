"""
Redis list keys and helpers shared by API and parser worker (no FastAPI/LanceDB).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Dict, List

# Redis list keys (LPUSH/BRPOP)
JOB_LIST_KEY = "docindex:jobs"
RESULT_LIST_KEY = "docindex:results"


def make_chunk_id(source_id: str, file_path: str, chunk_index: int, content_hash: str) -> str:
    raw = f"{source_id}|{file_path}|{chunk_index}|{content_hash}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def hash_file_bytes(path: str, chunk_size: int = 1024 * 1024) -> str:
    """SHA256 of raw file bytes (first 16 hex chars) for skip-without-parsing."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()[:16]


def sign_job(job: Dict[str, Any], key: str) -> str:
    """HMAC-SHA256 signature over the canonical JSON encoding of a job dict."""
    payload = json.dumps(job, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key.encode(), payload, "sha256").hexdigest()


def verify_job(job: Dict[str, Any], sig: str, key: str) -> bool:
    """Constant-time comparison of expected vs provided signature."""
    expected = sign_job(job, key)
    return hmac.compare_digest(expected, sig)
