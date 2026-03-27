#!/usr/bin/env python3
"""
DocIndex parser worker — consumes Redis jobs, runs Docling/Unstructured, embeds via llama.cpp, returns vectors.
No API token, no LanceDB. Runs in the heavy image only.
"""

from __future__ import annotations

import concurrent.futures as _cf
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import httpx
import redis
import structlog
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from document_chunker import chunk_document_text
from document_parsers import extract_text
from docindex_jobs import JOB_LIST_KEY, RESULT_LIST_KEY, make_chunk_id, verify_job

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
logger = structlog.get_logger()


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(populate_by_name=True, extra="ignore")

    docs_path: str = Field(
        default="/data/docs",
        validation_alias=AliasChoices("DOCINDEX_DOCS_PATH", "docs_path"),
    )
    redis_url: str = Field(
        default="redis://dragonfly:6379/0",
        validation_alias=AliasChoices("DOCINDEX_REDIS_URL", "redis_url"),
    )
    embedding_url: str = Field(
        default="http://llama-embeddings:8080",
        validation_alias=AliasChoices("DOCINDEX_EMBEDDING_URL", "embedding_url"),
    )
    embedding_batch_size: int = Field(
        default=32,
        validation_alias=AliasChoices("DOCINDEX_EMBEDDING_BATCH_SIZE", "embedding_batch_size"),
    )
    chunk_size: int = Field(
        default=2000,
        validation_alias=AliasChoices("DOCINDEX_CHUNK_SIZE", "chunk_size"),
    )
    chunk_overlap: int = Field(
        default=200,
        validation_alias=AliasChoices("DOCINDEX_CHUNK_OVERLAP", "chunk_overlap"),
    )
    max_file_bytes: int = Field(
        default=100 * 1024 * 1024,
        validation_alias=AliasChoices("DOCINDEX_MAX_FILE_BYTES", "max_file_bytes"),
    )
    brpop_timeout: int = Field(
        default=30,
        validation_alias=AliasChoices("DOCINDEX_WORKER_BRPOP_TIMEOUT", "brpop_timeout"),
    )
    job_signing_key: str = Field(
        default="",
        validation_alias=AliasChoices("DOCINDEX_JOB_SIGNING_KEY", "job_signing_key"),
    )
    job_timeout_secs: int = Field(
        default=300,
        validation_alias=AliasChoices("DOCINDEX_JOB_TIMEOUT_SECS", "job_timeout_secs"),
    )


settings = WorkerSettings()


def _embed_sync(client: httpx.Client, texts: List[str]) -> List[List[float]]:
    if not texts:
        return []
    r = client.post(
        f"{settings.embedding_url.rstrip('/')}/embedding",
        json={"input": texts},
        timeout=300.0,
    )
    r.raise_for_status()
    data = r.json()
    embeddings = data.get("data", [])
    out: List[List[float]] = []
    for emb in embeddings:
        vec = emb.get("embedding", [])
        norm = sum(x * x for x in vec) ** 0.5
        if norm > 0:
            vec = [x / norm for x in vec]
        out.append(vec)
    return out


_executor = _cf.ThreadPoolExecutor(max_workers=1)


def _dispatch_job(job: Dict[str, Any], http: httpx.Client, rcli: redis.Redis) -> None:
    """Verify signature then run with timeout in a thread pool."""
    job_id = job.get("job_id", "unknown")
    if settings.job_signing_key:
        sig = job.pop("sig", None)
        if sig is None:
            logger.error("job_missing_signature", job_id=job_id)
            _reply_error(rcli, job_id, "missing job signature")
            return
        if not verify_job(job, sig, settings.job_signing_key):
            logger.error("job_signature_invalid", job_id=job_id)
            _reply_error(rcli, job_id, "invalid job signature")
            return
    elif not settings.job_signing_key:
        logger.warning("job_signing_key_not_configured")
    fut = _executor.submit(_process_job, job, http, rcli)
    try:
        fut.result(timeout=settings.job_timeout_secs)
    except _cf.TimeoutError:
        logger.error("job_timed_out", job_id=job_id, timeout=settings.job_timeout_secs)
        _reply_error(rcli, job_id, f"job timed out after {settings.job_timeout_secs}s")


def _process_job(job: Dict[str, Any], http: httpx.Client, rcli: redis.Redis) -> None:
    job_id = job["job_id"]
    rel_path = job["rel_path"]
    source_id = job["source_id"]
    acl_scope = job["acl_scope"]
    file_bytes_hash = job.get("file_bytes_hash", "")
    docs_root = Path(settings.docs_path)
    abs_path = (docs_root / rel_path).resolve()
    try:
        abs_path.relative_to(docs_root.resolve())
    except ValueError:
        _reply_error(rcli, job_id, "path escapes docs root")
        return
    if not abs_path.is_file():
        _reply_error(rcli, job_id, f"not a file: {rel_path}")
        return
    size = abs_path.stat().st_size
    if size > settings.max_file_bytes:
        _reply_error(rcli, job_id, f"file too large: {size} bytes")
        return
    try:
        text, mime = extract_text(abs_path)
        content_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
        pieces = chunk_document_text(text, settings.chunk_size, settings.chunk_overlap)
        chunk_dicts: List[Dict[str, Any]] = []
        for i, content in enumerate(pieces):
            cid = make_chunk_id(source_id, rel_path, i, content_hash)
            chunk_dicts.append(
                {
                    "id": cid,
                    "file_path": rel_path,
                    "content": content,
                    "mime": mime,
                    "chunk_index": i,
                    "content_hash": content_hash,
                    "file_bytes_hash": file_bytes_hash,
                    "source_id": source_id,
                    "acl_scope": acl_scope,
                }
            )
        vectors: List[List[float]] = []
        for i in range(0, len(chunk_dicts), settings.embedding_batch_size):
            batch = chunk_dicts[i : i + settings.embedding_batch_size]
            texts = [c["content"] for c in batch]
            vecs = _embed_sync(http, texts)
            vectors.extend(vecs)
        for c, vec in zip(chunk_dicts, vectors):
            c["vector"] = vec
        payload = json.dumps({"job_id": job_id, "ok": True, "chunks": chunk_dicts})
        rcli.lpush(RESULT_LIST_KEY, payload)
        logger.info("job_ok", job_id=job_id, rel_path=rel_path, chunks=len(chunk_dicts))
    except Exception as e:
        logger.exception("job_failed", job_id=job_id, error=str(e))
        _reply_error(rcli, job_id, str(e))


def _reply_error(rcli: redis.Redis, job_id: str, message: str) -> None:
    rcli.lpush(
        RESULT_LIST_KEY,
        json.dumps({"job_id": job_id, "ok": False, "error": message}),
    )


def main() -> None:
    logger.info("docindex_worker_starting", redis=settings.redis_url)
    rcli = redis.from_url(settings.redis_url, decode_responses=True)
    http = httpx.Client(timeout=300.0)
    try:
        while True:
            try:
                item = rcli.brpop(JOB_LIST_KEY, timeout=settings.brpop_timeout)
                if not item:
                    continue
                _, raw = item
                job = json.loads(raw)
                _dispatch_job(job, http, rcli)
            except redis.ConnectionError as e:
                logger.error("redis_connection_error", error=str(e))
                time.sleep(5)
            except KeyboardInterrupt:
                logger.info("worker_stopping")
                break
            except Exception as e:
                logger.exception("worker_loop_error", error=str(e))
                time.sleep(1)
    finally:
        http.close()
        rcli.close()


if __name__ == "__main__":
    main()
    sys.exit(0)
