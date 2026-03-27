#!/usr/bin/env python3
"""
Hive DocIndex — non-code documents + LanceDB + llama.cpp embeddings.
Mirrors CocoIndex: mount → parse → chunk → embed → LanceDB → REST/MCP.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx
import lancedb
import redis.asyncio as aioredis
import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from pydantic import AliasChoices, BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sse_starlette.sse import EventSourceResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from auth import require_token
from docindex_constants import ALLOWED_INDEX_EXTENSIONS
from docindex_jobs import JOB_LIST_KEY, RESULT_LIST_KEY, hash_file_bytes, make_chunk_id, sign_job
from docindex_mcp_policy import blocked_doc_mcp_tool_names

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
logger = structlog.get_logger()
_audit = structlog.get_logger("docindex.audit")

# IvfPq trains product quantization on a sample; below this row count use IvfFlat.
_LANCE_PQ_MIN_ROWS = 256

# -----------------------------------------------------------------------------
# Safe filter helpers — prevent LanceDB filter injection
# -----------------------------------------------------------------------------
_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-\.]+$")
_SAFE_PATH_RE = re.compile(r"^[a-zA-Z0-9_\-./]+$")
_SAFE_MIME_RE = re.compile(r"^[a-zA-Z0-9_.+/\-]+$")
_SAFE_STR_FILTER_MAX_LEN = 1000
_SAFE_PATH_FILTER_MAX_LEN = 2048
_SAFE_MIME_FILTER_MAX_LEN = 256


def _safe_str_filter(column: str, value: str) -> str:
    if len(value) > _SAFE_STR_FILTER_MAX_LEN:
        raise ValueError(f"Invalid filter value for '{column}': exceeds maximum length")
    if not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid filter value for '{column}': {value!r}")
    if "'" in value:
        raise ValueError("Invalid character in filter value")
    return f"{column} = '{value}'"


def _safe_path_filter(column: str, value: str) -> str:
    if len(value) > _SAFE_PATH_FILTER_MAX_LEN:
        raise ValueError("Invalid path filter: exceeds maximum length")
    if ".." in value or "'" in value or not _SAFE_PATH_RE.match(value):
        raise ValueError(f"Invalid path filter: {value!r}")
    return f"{column} = '{value}'"


def _safe_mime_filter(column: str, value: str) -> str:
    if len(value) > _SAFE_MIME_FILTER_MAX_LEN:
        raise ValueError("Invalid mime filter: exceeds maximum length")
    if not _SAFE_MIME_RE.match(value) or "'" in value:
        raise ValueError(f"Invalid mime filter: {value!r}")
    return f"{column} = '{value}'"


def _safe_principal_filter(principal: str) -> str:
    """Build a filter that checks acl_scope='public' OR acl_principals contains the principal.

    NOTE: LanceDB LIKE matching is substring-based and does not enforce exact
    set membership. A principal 'a' would match 'ab'. For strict enforcement,
    post-filter in Python: [r for r in results if principal in r.acl_principals.split(',')].
    Exact set membership enforcement is Phase 3 (Postgres or LanceDB scalar index).
    """
    if len(principal) > _SAFE_STR_FILTER_MAX_LEN:
        raise ValueError("Invalid principal value: exceeds maximum length")
    if not _SAFE_ID_RE.match(principal) or "'" in principal:
        raise ValueError(f"Invalid principal value: {principal!r}")
    return f"(acl_scope = 'public' OR acl_principals LIKE '%{principal}%')"


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
class Settings(BaseSettings):
    model_config = SettingsConfigDict(populate_by_name=True, extra="ignore")

    docs_path: str = Field(
        default="/data/docs",
        validation_alias=AliasChoices("DOCINDEX_DOCS_PATH", "docs_path"),
    )
    lancedb_uri: str = Field(
        default="/data/lancedb",
        validation_alias=AliasChoices("DOCINDEX_LANCEDB_URI", "lancedb_uri"),
    )
    embedding_url: str = Field(
        default="http://llama-embeddings:8080",
        validation_alias=AliasChoices("DOCINDEX_EMBEDDING_URL", "embedding_url"),
    )
    embedding_dim: int = Field(
        default=4096,
        validation_alias=AliasChoices("DOCINDEX_EMBEDDING_DIM", "embedding_dim"),
    )
    embedding_batch_size: int = Field(
        default=32,
        validation_alias=AliasChoices("DOCINDEX_EMBEDDING_BATCH_SIZE", "embedding_batch_size"),
    )
    embedding_max_concurrent_batches: int = Field(
        default=1,
        ge=1,
        le=64,
        validation_alias=AliasChoices(
            "DOCINDEX_EMBEDDING_MAX_CONCURRENT_BATCHES",
            "embedding_max_concurrent_batches",
        ),
    )
    api_host: str = Field(
        default="0.0.0.0",  # nosec: B104
        validation_alias=AliasChoices("DOCINDEX_API_HOST", "api_host"),
    )
    api_port: int = Field(
        default=8082,
        validation_alias=AliasChoices("DOCINDEX_API_PORT", "api_port"),
    )
    index_on_startup: bool = Field(
        default=True,
        validation_alias=AliasChoices("DOCINDEX_INDEX_ON_STARTUP", "index_on_startup"),
    )
    watch_docs: bool = Field(
        default=True,
        validation_alias=AliasChoices("DOCINDEX_WATCH_DOCS", "watch_docs"),
    )
    log_level: str = Field(
        default="info",
        validation_alias=AliasChoices("DOCINDEX_LOG_LEVEL", "log_level"),
    )
    chunk_size: int = Field(
        default=2000,
        validation_alias=AliasChoices("DOCINDEX_CHUNK_SIZE", "chunk_size"),
    )
    chunk_overlap: int = Field(
        default=200,
        validation_alias=AliasChoices("DOCINDEX_CHUNK_OVERLAP", "chunk_overlap"),
    )
    default_source_id: str = Field(
        default="default",
        validation_alias=AliasChoices("DOCINDEX_DEFAULT_SOURCE_ID", "default_source_id"),
    )
    default_acl_scope: str = Field(
        default="public",
        validation_alias=AliasChoices("DOCINDEX_DEFAULT_ACL_SCOPE", "default_acl_scope"),
    )
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("DOCINDEX_REDIS_URL", "redis_url"),
    )
    use_worker_queue: bool = Field(
        default=False,
        validation_alias=AliasChoices("DOCINDEX_USE_WORKER_QUEUE", "use_worker_queue"),
    )
    job_signing_key: str = Field(
        default="",
        validation_alias=AliasChoices("DOCINDEX_JOB_SIGNING_KEY", "job_signing_key"),
    )
    rate_limit_index: str = Field(
        default="10/minute",
        validation_alias=AliasChoices("DOCINDEX_RATE_LIMIT_INDEX", "rate_limit_index"),
    )
    rate_limit_search: str = Field(
        default="60/minute",
        validation_alias=AliasChoices("DOCINDEX_RATE_LIMIT_SEARCH", "rate_limit_search"),
    )


settings = Settings()


def _inline_extract_and_chunk() -> Tuple[Any, Any]:
    """Lazy import — only used when DOCINDEX_USE_WORKER_QUEUE=false (dev/tests)."""
    from document_chunker import chunk_document_text as _chunk
    from document_parsers import extract_text as _extract

    return _extract, _chunk


# -----------------------------------------------------------------------------
# Data models
# -----------------------------------------------------------------------------
class DocChunk(BaseModel):
    id: str
    file_path: str
    content: str
    mime: str
    chunk_index: int
    content_hash: str
    file_bytes_hash: str = ""
    source_id: str
    acl_scope: str
    acl_principals: str = ""
    vector: Optional[List[float]] = None


class SearchRequest(BaseModel):
    query: str
    source_id: Optional[str] = None
    acl_scope: Optional[str] = None
    acl_principal: Optional[str] = None
    mime: Optional[str] = None
    limit: int = Field(default=10, ge=1, le=100)


class SearchResult(BaseModel):
    id: str
    file_path: str
    content: str
    mime: str
    chunk_index: int
    score: float
    source_id: str
    acl_scope: str


class IndexRequest(BaseModel):
    paths: Optional[List[str]] = None
    force_reindex: bool = False
    source_id: Optional[str] = None
    acl_scope: Optional[str] = None


class IndexResponse(BaseModel):
    indexed: int
    updated: int
    skipped: int
    errors: int
    duration_ms: float


# -----------------------------------------------------------------------------
# Embedding client (llama.cpp server — same contract as CocoIndex)
# -----------------------------------------------------------------------------
class EmbeddingClient:
    def __init__(self, base_url: str, *, max_concurrent_batches: int = 1):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=300.0)
        self._embed_sem = asyncio.Semaphore(max(1, max_concurrent_batches))

    async def embed(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        async with self._embed_sem:
            response = await self.client.post(
                f"{self.base_url}/embedding",
                json={"input": texts},
            )
            response.raise_for_status()
            data = response.json()
            embeddings = data.get("data", [])
            normalized: List[List[float]] = []
            for emb in embeddings:
                vec = emb.get("embedding", [])
                norm = sum(x * x for x in vec) ** 0.5
                if norm > 0:
                    vec = [x / norm for x in vec]
                normalized.append(vec)
            return normalized

    async def close(self) -> None:
        await self.client.aclose()


# -----------------------------------------------------------------------------
# LanceDB
# -----------------------------------------------------------------------------
def _ivf_pq_subvectors(embedding_dim: int) -> int:
    for candidate in (8, 4, 2, 1):
        if embedding_dim >= candidate and embedding_dim % candidate == 0:
            return candidate
    return 1


class LanceDBManager:
    TABLE_NAME = "document_embeddings"

    def __init__(self, uri: str):
        self.uri = uri
        self.db: Optional[lancedb.AsyncConnection] = None
        self.table: Optional[lancedb.AsyncTable] = None
        self._vector_index_ready: bool = False

    def _require_table(self) -> lancedb.AsyncTable:
        if self.table is None:
            raise RuntimeError("LanceDB table not initialized")
        return self.table

    async def connect(self) -> None:
        self.db = await lancedb.connect_async(self.uri)
        await self._ensure_table()

    async def _refresh_vector_index_state(self) -> None:
        if self.table is None:
            self._vector_index_ready = False
            return
        try:
            indices = await self.table.list_indices()
        except Exception as e:
            logger.warning("vector_index_list_failed", table=self.TABLE_NAME, error=str(e))
            self._vector_index_ready = False
            return
        self._vector_index_ready = any(
            "vector" in (getattr(ic, "columns", None) or []) for ic in indices
        )

    def _ivf_partition_count(self, row_count: int) -> int:
        if row_count < 1:
            return 1
        return min(256, max(1, min(16, row_count), int(row_count**0.5)))

    def _vector_index_config(self, row_count: int):
        from lancedb.index import IvfFlat, IvfPq

        k = self._ivf_partition_count(row_count)
        if row_count < _LANCE_PQ_MIN_ROWS:
            return IvfFlat(distance_type="cosine", num_partitions=k)
        sub = _ivf_pq_subvectors(settings.embedding_dim)
        return IvfPq(
            distance_type="cosine",
            num_partitions=k,
            num_sub_vectors=sub,
        )

    async def _upgrade_ivf_flat_to_pq_if_needed(self, row_count: int) -> None:
        if row_count < _LANCE_PQ_MIN_ROWS or self.table is None:
            return
        try:
            indices = await self.table.list_indices()
        except Exception:
            return
        has_flat = any(
            "vector" in (getattr(ic, "columns", None) or [])
            and getattr(ic, "index_type", "") == "IvfFlat"
            for ic in indices
        )
        if not has_flat:
            return
        from lancedb.index import IvfPq

        cfg = self._vector_index_config(row_count)
        if not isinstance(cfg, IvfPq):
            return
        try:
            await self.table.create_index("vector", config=cfg, replace=True)
            logger.info(
                "vector_index_upgraded_ivf_pq",
                table=self.TABLE_NAME,
                rows=row_count,
            )
        except RuntimeError as e:
            logger.warning(
                "vector_index_upgrade_failed",
                table=self.TABLE_NAME,
                rows=row_count,
                error=str(e),
            )

    async def ensure_vector_index_after_write(self) -> None:
        if self.table is None:
            return
        n = await self.table.count_rows()
        if n < 1:
            return

        if not self._vector_index_ready:
            cfg = self._vector_index_config(n)
            try:
                await self.table.create_index("vector", config=cfg, replace=True)
                self._vector_index_ready = True
                logger.info(
                    "vector_index_ready",
                    table=self.TABLE_NAME,
                    rows=n,
                    index_type=type(cfg).__name__,
                )
            except RuntimeError as e:
                logger.warning(
                    "vector_index_build_failed",
                    table=self.TABLE_NAME,
                    rows=n,
                    error=str(e),
                )
            return

        await self._upgrade_ivf_flat_to_pq_if_needed(n)

    async def _ensure_table(self) -> None:
        import pyarrow as pa

        if self.db is None:
            raise RuntimeError("LanceDB connection not initialized")

        try:
            self.table = await self.db.open_table(self.TABLE_NAME)
            logger.info("Opened existing table", table=self.TABLE_NAME)
            await self._refresh_vector_index_state()
        except Exception:
            schema = pa.schema(
                [
                    ("id", pa.string()),
                    ("source_id", pa.string()),
                    ("file_path", pa.string()),
                    ("mime", pa.string()),
                    ("content", pa.string()),
                    ("chunk_index", pa.int64()),
                    ("content_hash", pa.string()),
                    ("file_bytes_hash", pa.string()),
                    ("acl_scope", pa.string()),
                    ("acl_principals", pa.string()),
                    ("vector", pa.list_(pa.float32(), settings.embedding_dim)),
                ]
            )
            self.table = await self.db.create_table(
                self.TABLE_NAME,
                schema=schema,
                mode="create",
            )
            self._vector_index_ready = False

    async def delete_chunks_for_file(self, source_id: str, file_path: str) -> None:
        filt = f"{_safe_str_filter('source_id', source_id)} AND {_safe_path_filter('file_path', file_path)}"
        await self._require_table().delete(filt)

    async def upsert_chunks(
        self,
        chunks: List[DocChunk],
        *,
        refresh_vector_index: bool = True,
    ) -> None:
        if not chunks:
            return
        import pyarrow as pa

        data = {
            "id": [c.id for c in chunks],
            "source_id": [c.source_id for c in chunks],
            "file_path": [c.file_path for c in chunks],
            "mime": [c.mime for c in chunks],
            "content": [c.content for c in chunks],
            "chunk_index": [c.chunk_index for c in chunks],
            "content_hash": [c.content_hash for c in chunks],
            "file_bytes_hash": [c.file_bytes_hash or "" for c in chunks],
            "acl_scope": [c.acl_scope for c in chunks],
            "acl_principals": [c.acl_principals or "" for c in chunks],
            "vector": [c.vector for c in chunks],
        }
        arrow_table = pa.table(data)
        t_merge = time.perf_counter()
        await (
            self._require_table()
            .merge_insert("id")
            .when_matched_update_all()
            .when_not_matched_insert_all()
            .execute(arrow_table)
        )
        merge_ms = (time.perf_counter() - t_merge) * 1000.0
        logger.debug("lance_merge_insert_ms", ms=round(merge_ms, 2), rows=len(chunks))
        if refresh_vector_index:
            t_idx = time.perf_counter()
            await self.ensure_vector_index_after_write()
            logger.debug(
                "lance_vector_index_refresh_ms",
                ms=round((time.perf_counter() - t_idx) * 1000.0, 2),
            )

    async def search(
        self,
        query_vector: List[float],
        limit: int = 10,
        source_id: Optional[str] = None,
        acl_scope: Optional[str] = None,
        acl_principal: Optional[str] = None,
        mime: Optional[str] = None,
    ) -> List[SearchResult]:
        query = (
            (await self._require_table().search(query_vector))
            .distance_type("cosine")
            .limit(limit)
        )
        filters: List[str] = []
        if source_id:
            filters.append(_safe_str_filter("source_id", source_id))
        if acl_scope:
            filters.append(_safe_str_filter("acl_scope", acl_scope))
        if acl_principal:
            filters.append(_safe_principal_filter(acl_principal))
        if mime:
            filters.append(_safe_mime_filter("mime", mime))
        if filters:
            query = query.where(" AND ".join(filters))

        tbl = await query.to_arrow()
        out: List[SearchResult] = []
        has_dist = "_distance" in tbl.column_names
        for i in range(tbl.num_rows):
            dist = float(tbl.column("_distance")[i].as_py()) if has_dist else 0.0
            score = 1.0 - dist
            content = tbl.column("content")[i].as_py()
            if not isinstance(content, str):
                content = str(content)
            out.append(
                SearchResult(
                    id=tbl.column("id")[i].as_py(),
                    file_path=tbl.column("file_path")[i].as_py(),
                    content=content[:500],
                    mime=tbl.column("mime")[i].as_py(),
                    chunk_index=int(tbl.column("chunk_index")[i].as_py()),
                    score=score,
                    source_id=tbl.column("source_id")[i].as_py(),
                    acl_scope=tbl.column("acl_scope")[i].as_py(),
                )
            )
        return out

    async def get_existing_hashes(self, source_id: str) -> dict:
        """file_path -> content_hash (text-derived) for inline skip."""
        tbl = await (
            self._require_table()
            .query()
            .where(_safe_str_filter("source_id", source_id))
            .select(["file_path", "content_hash"])
            .to_arrow()
        )
        if tbl.num_rows == 0:
            return {}
        out: dict = {}
        for i in range(tbl.num_rows - 1, -1, -1):
            fp = tbl.column("file_path")[i].as_py()
            if fp not in out:
                out[fp] = tbl.column("content_hash")[i].as_py()
        return out

    async def get_existing_file_byte_hashes(self, source_id: str) -> dict:
        """file_path -> file_bytes_hash for queue-mode skip without parsing."""
        try:
            tbl = await (
                self._require_table()
                .query()
                .where(_safe_str_filter("source_id", source_id))
                .select(["file_path", "file_bytes_hash"])
                .to_arrow()
            )
        except Exception as e:
            logger.warning("file_bytes_hash_query_failed", error=str(e))
            return {}
        if tbl.num_rows == 0:
            return {}
        out: dict = {}
        for i in range(tbl.num_rows - 1, -1, -1):
            fp = tbl.column("file_path")[i].as_py()
            if fp not in out:
                out[fp] = tbl.column("file_bytes_hash")[i].as_py()
        return out

    async def count_rows(self) -> int:
        return await self._require_table().count_rows()


# -----------------------------------------------------------------------------
# Path helpers
# -----------------------------------------------------------------------------
def _skip_path_parts(path: Path) -> bool:
    return any(
        part.startswith(".") or part in {"node_modules", "vendor", "target", "dist", "build", "__pycache__"}
        for part in path.parts
    )


def _relative_docs_path(root: Path, full: Path) -> str:
    return str(full.relative_to(root)).replace("\\", "/")


def _safe_under_docs_root(docs_root: Path, rel: str) -> Path:
    docs_root = docs_root.resolve()
    candidate = (docs_root / rel).resolve()
    try:
        candidate.relative_to(docs_root)
    except ValueError:
        raise ValueError(f"Path escapes docs root: {rel!r}")
    return candidate


# -----------------------------------------------------------------------------
# File watcher
# -----------------------------------------------------------------------------
class DocsWatcher(FileSystemEventHandler):
    def __init__(self, indexer: "DocIndexer", loop: asyncio.AbstractEventLoop):
        self.indexer = indexer
        self._loop = loop
        self._pending: set[str] = set()
        self._lock = threading.Lock()

    def on_modified(self, event):  # type: ignore[no-untyped-def]
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() not in ALLOWED_INDEX_EXTENSIONS:
            return
        if _skip_path_parts(path):
            return
        asyncio.run_coroutine_threadsafe(self._queue_index(event.src_path), self._loop)

    async def _queue_index(self, file_path: str):
        with self._lock:
            if file_path in self._pending:
                return
            self._pending.add(file_path)
        await asyncio.sleep(2)
        with self._lock:
            self._pending.discard(file_path)
        logger.info("Reindexing modified document", file=file_path)
        await self.indexer.index_single_path(file_path, force=True)


# -----------------------------------------------------------------------------
# Main indexer
# -----------------------------------------------------------------------------
class DocIndexer:
    def __init__(self) -> None:
        self.db = LanceDBManager(settings.lancedb_uri)
        self.embedder: Optional[EmbeddingClient] = None
        self.observer: Optional[Any] = None
        self._index_lock = asyncio.Lock()
        self._redis: Optional[aioredis.Redis] = None
        self._pending: Dict[str, asyncio.Future[Any]] = {}
        self._consumer_task: Optional[asyncio.Task[None]] = None

    async def initialize(self) -> None:
        await self.db.connect()
        self.embedder = EmbeddingClient(
            settings.embedding_url,
            max_concurrent_batches=settings.embedding_max_concurrent_batches,
        )
        if settings.use_worker_queue:
            self._redis = aioredis.from_url(settings.redis_url, decode_responses=True)
            self._consumer_task = asyncio.create_task(self._consume_results_loop())
            logger.info("DocIndexer queue mode", redis=settings.redis_url)
        logger.info("DocIndexer initialized")

    async def close(self) -> None:
        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass
            self._consumer_task = None
        if self._redis:
            await self._redis.aclose()
            self._redis = None
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=5)
            self.observer = None
        if self.embedder:
            await self.embedder.close()
            self.embedder = None
        if self.db.db is not None:
            self.db.db.close()
            self.db.db = None
            self.db.table = None

    async def _consume_results_loop(self) -> None:
        assert self._redis is not None
        while True:
            try:
                item = await self._redis.brpop(RESULT_LIST_KEY, timeout=5)
                if not item:
                    continue
                _, payload = item
                await self._handle_worker_result(json.loads(payload))
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.exception("result_consumer_error", error=str(e))

    async def _handle_worker_result(self, data: dict) -> None:
        job_id = data.get("job_id", "")
        fut = self._pending.pop(job_id, None)
        try:
            if data.get("ok"):
                chunks: List[DocChunk] = []
                for c in data.get("chunks", []):
                    chunks.append(
                        DocChunk(
                            id=c["id"],
                            file_path=c["file_path"],
                            content=c["content"],
                            mime=c["mime"],
                            chunk_index=int(c["chunk_index"]),
                            content_hash=c["content_hash"],
                            file_bytes_hash=c.get("file_bytes_hash") or "",
                            source_id=c["source_id"],
                            acl_scope=c["acl_scope"],
                            vector=c.get("vector"),
                        )
                    )
                if chunks:
                    await self.db.upsert_chunks(chunks)
                _audit.info("job_completed", job_id=job_id, chunk_count=len(chunks))
                if fut and not fut.done():
                    fut.set_result(None)
            else:
                err = data.get("error", "unknown worker error")
                _audit.error("job_failed", job_id=job_id, error=err)
                if fut and not fut.done():
                    fut.set_exception(RuntimeError(err))
                logger.error("worker_job_failed", job_id=job_id, error=err)
        except Exception as e:
            if fut and not fut.done():
                fut.set_exception(e)
            logger.exception("handle_worker_result_error", job_id=job_id, error=str(e))

    async def _enqueue_parse_job(
        self,
        rel_path: str,
        source_id: str,
        acl_scope: str,
        file_bytes_hash: str,
        wait_for_result: bool,
    ) -> Optional[asyncio.Future[Any]]:
        assert self._redis is not None
        job_id = str(uuid.uuid4())
        fut: Optional[asyncio.Future[Any]] = None
        if wait_for_result:
            fut = asyncio.get_running_loop().create_future()
            self._pending[job_id] = fut
        job: Dict[str, Any] = {
            "job_id": job_id,
            "rel_path": rel_path,
            "source_id": source_id,
            "acl_scope": acl_scope,
            "file_bytes_hash": file_bytes_hash,
        }
        if settings.job_signing_key:
            job["sig"] = sign_job(job, settings.job_signing_key)
        elif settings.use_worker_queue:
            logger.warning("job_signing_key_not_set_queue_unauthenticated")
        await self._redis.lpush(JOB_LIST_KEY, json.dumps(job))
        _audit.info("job_enqueued", job_id=job_id, rel_path=rel_path, source_id=source_id)
        return fut

    def start_watching(self) -> None:
        if not settings.watch_docs:
            return
        root = Path(settings.docs_path)
        if not root.is_dir():
            return
        loop = asyncio.get_running_loop()
        handler = DocsWatcher(self, loop)
        self.observer = Observer()
        self.observer.schedule(handler, str(root), recursive=True)
        self.observer.start()
        logger.info("Started document watcher", path=str(root))

    def _make_chunk_id(self, source_id: str, file_path: str, chunk_index: int, content_hash: str) -> str:
        return make_chunk_id(source_id, file_path, chunk_index, content_hash)

    def _build_chunks(
        self,
        text: str,
        mime: str,
        rel: str,
        source_id: str,
        acl_scope: str,
    ) -> List[DocChunk]:
        _, chunk_document_text = _inline_extract_and_chunk()
        content_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
        pieces = chunk_document_text(text, settings.chunk_size, settings.chunk_overlap)
        chunks: List[DocChunk] = []
        for i, content in enumerate(pieces):
            cid = self._make_chunk_id(source_id, rel, i, content_hash)
            chunks.append(
                DocChunk(
                    id=cid,
                    file_path=rel,
                    content=content,
                    mime=mime,
                    chunk_index=i,
                    content_hash=content_hash,
                    file_bytes_hash="",
                    source_id=source_id,
                    acl_scope=acl_scope,
                )
            )
        return chunks

    async def _embed_and_upsert(
        self,
        chunks: List[DocChunk],
        *,
        finalize_vector_index: bool = True,
    ) -> None:
        assert self.embedder is not None
        batch_size = settings.embedding_batch_size
        batch_list = [chunks[i : i + batch_size] for i in range(0, len(chunks), batch_size)]

        async def _embed_batch(idx: int, batch: List[DocChunk]) -> tuple:
            texts = [c.content for c in batch]
            t0 = time.perf_counter()
            embeddings = await self.embedder.embed(texts)
            embed_ms = (time.perf_counter() - t0) * 1000.0
            logger.debug(
                "embed_batch_complete",
                batch_num=idx,
                size=len(batch),
                embed_ms=round(embed_ms, 2),
            )
            return batch, embeddings

        results = await asyncio.gather(
            *[_embed_batch(i + 1, b) for i, b in enumerate(batch_list)]
        )
        for batch, embeddings in results:
            for chunk, vec in zip(batch, embeddings):
                chunk.vector = vec
            await self.db.upsert_chunks(batch, refresh_vector_index=False)
            logger.debug("lance_upsert_batch", size=len(batch))

        if finalize_vector_index:
            t_idx = time.perf_counter()
            await self.db.ensure_vector_index_after_write()
            logger.info(
                "vector_index_finalize_ms",
                ms=round((time.perf_counter() - t_idx) * 1000.0, 2),
                chunks_total=len(chunks),
            )

    async def index_single_path(self, file_path: str, force: bool = False) -> None:
        docs_root = Path(settings.docs_path)
        path = Path(file_path).resolve()
        if not path.is_file():
            return
        try:
            rel = _relative_docs_path(docs_root, path)
        except ValueError:
            logger.warning("File not under docs path", file=file_path)
            return
        source_id = settings.default_source_id
        acl_scope = settings.default_acl_scope
        if settings.use_worker_queue:
            assert self._redis is not None
            existing = {} if force else await self.db.get_existing_file_byte_hashes(source_id)
            bhash = await asyncio.to_thread(hash_file_bytes, str(path))
            if not force and existing.get(rel) == bhash:
                return
            await self.db.delete_chunks_for_file(source_id, rel)
            await self._enqueue_parse_job(rel, source_id, acl_scope, bhash, wait_for_result=False)
            return
        existing = {} if force else await self.db.get_existing_hashes(source_id)
        extract_text, _chunk_fn = _inline_extract_and_chunk()
        text, mime = await asyncio.to_thread(extract_text, path)
        content_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
        if not force and existing.get(rel) == content_hash:
            return
        await self.db.delete_chunks_for_file(source_id, rel)
        chunks = self._build_chunks(text, mime, rel, source_id, acl_scope)
        if chunks:
            await self._embed_and_upsert(chunks)

    async def index_documents(self, request: IndexRequest) -> IndexResponse:
        if self._index_lock.locked():
            raise HTTPException(status_code=429, detail="Indexing already in progress")
        async with self._index_lock:
            return await self._do_index_documents(request)

    async def _do_index_documents(self, request: IndexRequest) -> IndexResponse:
        start = time.time()
        stats = {"indexed": 0, "updated": 0, "skipped": 0, "errors": 0}
        docs_root = Path(settings.docs_path)
        if not docs_root.exists():
            raise ValueError(f"Docs path does not exist: {docs_root}")

        source_id = request.source_id or settings.default_source_id
        acl_scope = request.acl_scope or settings.default_acl_scope
        # Validate source_id / acl_scope for use in filters (strict id pattern)
        _safe_str_filter("source_id", source_id)
        _safe_str_filter("acl_scope", acl_scope)

        force = request.force_reindex
        if settings.use_worker_queue:
            existing = {} if force else await self.db.get_existing_file_byte_hashes(source_id)
        else:
            existing = {} if force else await self.db.get_existing_hashes(source_id)

        files: List[Path] = []
        if request.paths:
            for p in request.paths:
                abs_p = _safe_under_docs_root(docs_root, p.replace("\\", "/"))
                if abs_p.is_file():
                    files.append(abs_p)
                elif abs_p.is_dir():
                    for f in abs_p.rglob("*"):
                        if f.is_file() and f.suffix.lower() in ALLOWED_INDEX_EXTENSIONS and not _skip_path_parts(f):
                            files.append(f)
        else:
            for f in docs_root.rglob("*"):
                if f.is_file() and f.suffix.lower() in ALLOWED_INDEX_EXTENSIONS and not _skip_path_parts(f):
                    files.append(f)

        logger.info("Found document files", count=len(files), source_id=source_id)

        if settings.use_worker_queue:
            assert self._redis is not None
            futures_wait: List[Tuple[asyncio.Future[Any], bool]] = []
            for abs_path in files:
                try:
                    rel = _relative_docs_path(docs_root, abs_path)
                    bhash = await asyncio.to_thread(hash_file_bytes, str(abs_path))
                    if not force and existing.get(rel) == bhash:
                        stats["skipped"] += 1
                        continue
                    was_existing = rel in existing
                    await self.db.delete_chunks_for_file(source_id, rel)
                    fut = await self._enqueue_parse_job(
                        rel, source_id, acl_scope, bhash, wait_for_result=True
                    )
                    assert fut is not None
                    futures_wait.append((fut, was_existing))
                except Exception as e:
                    logger.error("Failed to enqueue file", file=str(abs_path), error=str(e))
                    stats["errors"] += 1
            for fut, was_existing in futures_wait:
                try:
                    await asyncio.wait_for(fut, timeout=3600.0)
                    if was_existing:
                        stats["updated"] += 1
                    else:
                        stats["indexed"] += 1
                except Exception as e:
                    logger.error("Job wait failed", error=str(e))
                    stats["errors"] += 1
        else:
            extract_text, _c = _inline_extract_and_chunk()
            inline_wrote = False
            for abs_path in files:
                try:
                    rel = _relative_docs_path(docs_root, abs_path)
                    text, mime = await asyncio.to_thread(extract_text, abs_path)
                    content_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
                    if not force and existing.get(rel) == content_hash:
                        stats["skipped"] += 1
                        continue
                    await self.db.delete_chunks_for_file(source_id, rel)
                    chunks = self._build_chunks(text, mime, rel, source_id, acl_scope)
                    if chunks:
                        await self._embed_and_upsert(
                            chunks, finalize_vector_index=False
                        )
                        inline_wrote = True
                    if existing.get(rel):
                        stats["updated"] += 1
                    else:
                        stats["indexed"] += 1
                except Exception as e:
                    logger.error("Failed to index file", file=str(abs_path), error=str(e))
                    stats["errors"] += 1
            if inline_wrote:
                t_idx = time.perf_counter()
                await self.db.ensure_vector_index_after_write()
                logger.info(
                    "vector_index_finalize_ms",
                    ms=round((time.perf_counter() - t_idx) * 1000.0, 2),
                    mode="inline_bulk",
                )

        duration_ms = (time.time() - start) * 1000
        logger.info(
            "index_documents_complete",
            duration_ms=round(duration_ms, 2),
            **stats,
        )
        return IndexResponse(**stats, duration_ms=duration_ms)

    async def search(self, request: SearchRequest) -> List[SearchResult]:
        assert self.embedder is not None
        t0 = time.perf_counter()
        embeddings = await self.embedder.embed([request.query])
        logger.debug(
            "search_query_embed_ms",
            ms=round((time.perf_counter() - t0) * 1000.0, 2),
        )
        return await self.db.search(
            embeddings[0],
            limit=request.limit,
            source_id=request.source_id,
            acl_scope=request.acl_scope,
            acl_principal=request.acl_principal,
            mime=request.mime,
        )


# -----------------------------------------------------------------------------
# FastAPI
# -----------------------------------------------------------------------------
indexer = DocIndexer()
limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await indexer.initialize()
    if settings.index_on_startup:
        docs_root = Path(settings.docs_path)
        if docs_root.is_dir():
            logger.info("Starting initial document indexing...")
            result = await indexer.index_documents(
                IndexRequest(paths=None, force_reindex=False, source_id=None, acl_scope=None)
            )
            logger.info("Initial indexing complete", result=result.model_dump())
        else:
            logger.warning("Docs path missing; skipping initial index", path=str(docs_root))
    indexer.start_watching()
    yield
    await indexer.close()


app = FastAPI(
    title="Hive DocIndex",
    description="Non-code document indexing with LanceDB and llama.cpp embeddings",
    version="1.0.0",
    lifespan=lifespan,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.get("/health")
async def health():
    return {"status": "healthy", "indexer_ready": indexer.embedder is not None}


@app.post("/index", response_model=IndexResponse, dependencies=[Depends(require_token)])
@limiter.limit(settings.rate_limit_index)
async def index_endpoint(request: Request, body: IndexRequest):
    try:
        return await indexer.index_documents(body)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", response_model=List[SearchResult], dependencies=[Depends(require_token)])
@limiter.limit(settings.rate_limit_search)
async def search_post(request: Request, body: SearchRequest):
    try:
        return await indexer.search(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/search", dependencies=[Depends(require_token)])
@limiter.limit(settings.rate_limit_search)
async def search_get(
    request: Request,
    q: str = Query(..., description="Search query"),
    source_id: Optional[str] = Query(None),
    acl_scope: Optional[str] = Query(None),
    acl_principal: Optional[str] = Query(None, description="Filter by principal (approx; see docs)"),
    mime: Optional[str] = Query(None),
    limit: int = Query(10, ge=1, le=100),
):
    return await indexer.search(
        SearchRequest(
            query=q,
            source_id=source_id,
            acl_scope=acl_scope,
            acl_principal=acl_principal,
            mime=mime,
            limit=limit,
        )
    )


@app.get("/stats", dependencies=[Depends(require_token)])
async def stats():
    try:
        count = await indexer.db.count_rows()
        return {
            "total_chunks": count,
            "table": LanceDBManager.TABLE_NAME,
            "status": "ready",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _mcp_tools_public() -> list[dict[str, Any]]:
    blocked = blocked_doc_mcp_tool_names()
    if not blocked:
        return list(_MCP_TOOLS)
    return [t for t in _MCP_TOOLS if t["name"] not in blocked]


_MCP_TOOLS = [
    {
        "name": "search_documents",
        "description": "Semantic search over indexed non-code documents (PDF, Office, HTML, etc.).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "source_id": {"type": "string"},
                "acl_scope": {"type": "string"},
                "mime": {"type": "string"},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
        },
    },
    {
        "name": "index_documents",
        "description": "Trigger document indexing under the configured docs path (admin).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"}},
                "force_reindex": {"type": "boolean", "default": False},
                "source_id": {"type": "string"},
                "acl_scope": {"type": "string"},
            },
        },
    },
    {
        "name": "get_index_stats",
        "description": "Return document index statistics.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


@app.get("/mcp", dependencies=[Depends(require_token)])
async def mcp_sse(request: Request):
    async def generator():
        yield {"event": "endpoint", "data": "/mcp/message"}
        while not await request.is_disconnected():
            yield {"event": "ping", "data": ""}
            await asyncio.sleep(15)

    return EventSourceResponse(generator())


@app.post("/mcp/message", dependencies=[Depends(require_token)])
async def mcp_message(body: dict):
    method = body.get("method")
    params = body.get("params", {})
    req_id = body.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hive-docindex", "version": "1.0.0"},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": _mcp_tools_public()}}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments", {})
        blocked = blocked_doc_mcp_tool_names()
        if name in blocked:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32602,
                    "message": (
                        f"Tool {name!r} is blocked for worker-tier DocIndex MCP "
                        "(set DOCINDEX_MCP_WORKER_SAFE when exposing this URL to hive-worker)"
                    ),
                },
            }
        try:
            if name == "search_documents":
                req = SearchRequest(
                    query=args["query"],
                    source_id=args.get("source_id"),
                    acl_scope=args.get("acl_scope"),
                    mime=args.get("mime"),
                    limit=args.get("limit", 10),
                )
                results = await indexer.search(req)
                content = [{"type": "text", "text": json.dumps([r.model_dump() for r in results])}]
            elif name == "get_index_stats":
                count = await indexer.db.count_rows()
                content = [
                    {
                        "type": "text",
                        "text": json.dumps(
                            {"total_chunks": count, "table": LanceDBManager.TABLE_NAME, "status": "ready"}
                        ),
                    }
                ]
            elif name == "index_documents":
                ir = IndexRequest(
                    paths=args.get("paths"),
                    force_reindex=bool(args.get("force_reindex", False)),
                    source_id=args.get("source_id"),
                    acl_scope=args.get("acl_scope"),
                )
                result = await indexer.index_documents(ir)
                content = [{"type": "text", "text": json.dumps(result.model_dump())}]
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32602, "message": f"Unknown tool: {name!r}"},
                }
            return {"jsonrpc": "2.0", "id": req_id, "result": {"content": content}}
        except ValueError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": str(e)}}
        except HTTPException as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603, "message": e.detail},
            }
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": str(e)}}
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "docindex_server:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level,
    )
