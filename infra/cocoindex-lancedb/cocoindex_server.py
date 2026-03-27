#!/usr/bin/env python3
"""
CocoIndex v1 + LanceDB Server
Local Git repository indexing with llama.cpp embeddings.
"""

import asyncio
import hashlib
import json
import os
import time
import re
import threading
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, List, Optional

import httpx
import lancedb
import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sse_starlette.sse import EventSourceResponse
from pydantic import AliasChoices, BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from auth import require_token

# Configure logging
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer()
    ]
)
logger = structlog.get_logger()

# IvfPq trains product quantization on a sample; below this row count use IvfFlat.
_LANCE_PQ_MIN_ROWS = 256

# -----------------------------------------------------------------------------
# Safe filter helpers — prevent LanceDB filter injection
# -----------------------------------------------------------------------------
_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-\.]+$')
_SAFE_STR_FILTER_MAX_LEN = 1000

def _safe_str_filter(column: str, value: str) -> str:
    """
    Build a LanceDB WHERE clause for a string equality check.
    Raises ValueError if value contains SQL metacharacters, preventing injection.
    Only alphanumeric characters plus _ - . are permitted.
    """
    if len(value) > _SAFE_STR_FILTER_MAX_LEN:
        raise ValueError(f"Invalid filter value for '{column}': exceeds maximum length")
    if not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid filter value for '{column}': {value!r}")
    return f"{column} = '{value}'"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        populate_by_name=True,
        extra="ignore",
    )

    repos_path: str = Field(
        default="/data/repos",
        validation_alias=AliasChoices("COCOINDEX_REPOS_PATH", "repos_path"),
    )
    lancedb_uri: str = Field(
        default="/data/lancedb",
        validation_alias=AliasChoices("COCOINDEX_LANCEDB_URI", "lancedb_uri"),
    )
    embedding_url: str = Field(
        default="http://llama-embeddings:8080",
        validation_alias=AliasChoices("COCOINDEX_EMBEDDING_URL", "embedding_url"),
    )
    embedding_dim: int = Field(
        default=4096,
        validation_alias=AliasChoices("COCOINDEX_EMBEDDING_DIM", "embedding_dim"),
    )
    embedding_batch_size: int = Field(
        default=32,
        validation_alias=AliasChoices("COCOINDEX_EMBEDDING_BATCH_SIZE", "embedding_batch_size"),
    )
    embedding_max_concurrent_batches: int = Field(
        default=1,
        ge=1,
        le=64,
        validation_alias=AliasChoices(
            "COCOINDEX_EMBEDDING_MAX_CONCURRENT_BATCHES",
            "embedding_max_concurrent_batches",
        ),
    )
    max_concurrent_file_tasks: int = Field(
        default=8,
        ge=1,
        le=64,
        validation_alias=AliasChoices(
            "COCOINDEX_MAX_CONCURRENT_FILE_TASKS",
            "max_concurrent_file_tasks",
        ),
    )
    rate_limit_index: str = Field(
        default="10/minute",
        validation_alias=AliasChoices("COCOINDEX_RATE_LIMIT_INDEX", "rate_limit_index"),
    )
    rate_limit_search: str = Field(
        default="60/minute",
        validation_alias=AliasChoices("COCOINDEX_RATE_LIMIT_SEARCH", "rate_limit_search"),
    )
    api_host: str = Field(
        default="0.0.0.0",
        validation_alias=AliasChoices("COCOINDEX_API_HOST", "api_host"),
    )
    api_port: int = Field(
        default=8080,
        validation_alias=AliasChoices("COCOINDEX_API_PORT", "api_port"),
    )
    index_on_startup: bool = Field(
        default=True,
        validation_alias=AliasChoices("COCOINDEX_INDEX_ON_STARTUP", "index_on_startup"),
    )
    watch_repos: bool = Field(
        default=True,
        validation_alias=AliasChoices("COCOINDEX_WATCH_REPOS", "watch_repos"),
    )
    log_level: str = Field(
        default="info",
        validation_alias=AliasChoices("COCOINDEX_LOG_LEVEL", "log_level"),
    )


settings = Settings()

# -----------------------------------------------------------------------------
# Data Models
# -----------------------------------------------------------------------------
class CodeChunk(BaseModel):
    id: str
    file_path: str
    content: str
    language: str
    chunk_start: int
    chunk_end: int
    file_hash: str
    repo_name: str
    vector: Optional[List[float]] = None

class SearchRequest(BaseModel):
    query: str
    repo: Optional[str] = None
    language: Optional[str] = None
    limit: int = Field(default=10, ge=1, le=100)

class SearchResult(BaseModel):
    id: str
    file_path: str
    content: str
    language: str
    chunk_start: int
    chunk_end: int
    score: float
    repo_name: str

class IndexRequest(BaseModel):
    repo_path: Optional[str] = None
    force_reindex: bool = False

class IndexResponse(BaseModel):
    indexed: int
    updated: int
    skipped: int
    errors: int
    duration_ms: float

# -----------------------------------------------------------------------------
# Tree-sitter chunking
# -----------------------------------------------------------------------------
class CodeChunker:
    SUPPORTED_LANGUAGES = {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".rs": "rust",
        ".go": "go",
        ".java": "java",
    }
    
    CHUNK_SIZE = 512
    CHUNK_OVERLAP = 64

    def __init__(self):
        pass  # TODO: implement AST-based chunking with tree-sitter (currently uses line-based fallback)

    def get_language(self, file_path: str) -> Optional[str]:
        ext = Path(file_path).suffix.lower()
        return self.SUPPORTED_LANGUAGES.get(ext)
    
    def chunk_file(self, file_path: str, content: str, repo_name: str) -> List[CodeChunk]:
        language = self.get_language(file_path) or "text"
        file_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
        
        chunks = []
        lines = content.split('\n')
        
        # Simple line-based chunking with overlap
        start = 0
        chunk_num = 0
        
        while start < len(lines):
            end = min(start + self.CHUNK_SIZE, len(lines))
            chunk_content = '\n'.join(lines[start:end])
            
            chunk = CodeChunk(
                id=f"{file_path}:{chunk_num}",
                file_path=file_path,
                content=chunk_content,
                language=language,
                chunk_start=start,
                chunk_end=end,
                file_hash=file_hash,
                repo_name=repo_name
            )
            chunks.append(chunk)
            
            # Move forward with overlap
            start = end - self.CHUNK_OVERLAP if end < len(lines) else end
            chunk_num += 1
        
        return chunks


def _coco_read_and_chunk_file(
    repo_path: Path,
    file_path: Path,
    repo_name: str,
    chunker: CodeChunker,
) -> tuple:
    """Sync: read text, hash, chunk. Runs in a worker thread."""
    relative_path = str(file_path.relative_to(repo_path))
    content = file_path.read_text(encoding="utf-8", errors="ignore")
    file_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
    chunks = chunker.chunk_file(relative_path, content, repo_name)
    return relative_path, file_hash, chunks


def _coco_watcher_read_chunk(
    path: Path,
    relative_file_path: str,
    repo_name: str,
    chunker: CodeChunker,
) -> List[CodeChunk]:
    content = path.read_text(encoding="utf-8", errors="ignore")
    return chunker.chunk_file(relative_file_path, content, repo_name)


# -----------------------------------------------------------------------------
# Embedding client
# -----------------------------------------------------------------------------
class EmbeddingClient:
    def __init__(
        self,
        base_url: str,
        *,
        openai_compatible: bool = False,
        openai_model: str = "",
        max_concurrent_batches: int = 1,
    ):
        self.base_url = base_url.rstrip('/')
        self.openai_compatible = openai_compatible
        self.openai_model = (openai_model or "").strip()
        self.client = httpx.AsyncClient(timeout=300.0)
        self._embed_sem = asyncio.Semaphore(max(1, max_concurrent_batches))

    async def embed(self, texts: List[str]) -> List[List[float]]:
        """Get embeddings from llama.cpp server (/embedding) or OpenAI-compatible /v1/embeddings."""
        if not texts:
            return []

        async with self._embed_sem:
            return await self._embed_unlocked(texts)

    async def _embed_unlocked(self, texts: List[str]) -> List[List[float]]:
        if self.openai_compatible:
            if not self.openai_model:
                raise ValueError(
                    "COCOINDEX_EMBEDDING_MODEL_ID is required when COCOINDEX_EMBEDDING_OPENAI_COMPATIBLE is enabled"
                )
            response = await self.client.post(
                f"{self.base_url}/v1/embeddings",
                json={"model": self.openai_model, "input": texts},
            )
            response.raise_for_status()
            data = response.json()
            items = sorted(data.get("data", []), key=lambda x: int(x.get("index", 0)))
            normalized: List[List[float]] = []
            for emb in items:
                vec = emb.get("embedding", [])
                norm = sum(x * x for x in vec) ** 0.5
                if norm > 0:
                    vec = [x / norm for x in vec]
                normalized.append(vec)
            return normalized

        response = await self.client.post(
            f"{self.base_url}/embedding",
            json={"input": texts}
        )
        response.raise_for_status()

        data = response.json()
        embeddings = data.get("data", [])

        # Normalize embeddings (L2 norm) - compatible with BGE-M3 style
        normalized = []
        for emb in embeddings:
            vec = emb.get("embedding", [])
            norm = sum(x * x for x in vec) ** 0.5
            if norm > 0:
                vec = [x / norm for x in vec]
            normalized.append(vec)

        return normalized

    async def close(self):
        await self.client.aclose()

# -----------------------------------------------------------------------------
# LanceDB manager
# -----------------------------------------------------------------------------
def _ivf_pq_subvectors(embedding_dim: int) -> int:
    """Product quantization subvector count must divide embedding_dim."""
    for candidate in (8, 4, 2, 1):
        if embedding_dim >= candidate and embedding_dim % candidate == 0:
            return candidate
    return 1


class LanceDBManager:
    TABLE_NAME = "code_embeddings"
    
    def __init__(self, uri: str):
        self.uri = uri
        self.db: Optional[lancedb.AsyncConnection] = None
        self.table: Optional[lancedb.AsyncTable] = None
        self._vector_index_ready: bool = False
    
    async def connect(self):
        self.db = await lancedb.connect_async(self.uri)
        await self._ensure_table()
    
    async def _refresh_vector_index_state(self) -> None:
        """Set _vector_index_ready from table metadata (no guessing)."""
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
        """KMeans clusters must be <= row_count; scale with sqrt(rows) at larger scale."""
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
        """Replace IvfFlat with IvfPq once PQ training has enough rows (storage + recall)."""
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
        """Build vector index after ingest; upgrade IvfFlat→IvfPq when scale allows."""
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
    
    async def _ensure_table(self):
        """Create table if not exists."""
        import pyarrow as pa
        
        try:
            self.table = await self.db.open_table(self.TABLE_NAME)
            logger.info("Opened existing table", table=self.TABLE_NAME)
            await self._refresh_vector_index_state()
        except Exception:
            # Create new table (vector index is created after first ingest — IVF cannot train on 0 rows).
            schema = pa.schema([
                ("id", pa.string()),
                ("file_path", pa.string()),
                ("content", pa.string()),
                ("language", pa.string()),
                ("chunk_start", pa.int64()),
                ("chunk_end", pa.int64()),
                ("file_hash", pa.string()),
                ("repo_name", pa.string()),
                # float32 (not float64): halves storage (16KB vs 32KB per chunk)
                # with no precision loss — llama.cpp outputs float32 and
                # Qwen3-Embedding-8B-Q4_K_M is 4-bit quantized.
                ("vector", pa.list_(pa.float32(), settings.embedding_dim)),
            ])
            
            self.table = await self.db.create_table(
                self.TABLE_NAME,
                schema=schema,
                mode="create"
            )
            self._vector_index_ready = False
    
    async def upsert_chunks(
        self,
        chunks: List[CodeChunk],
        *,
        refresh_vector_index: bool = True,
    ):
        """Upsert code chunks with embeddings."""
        if not chunks:
            return

        import pyarrow as pa

        # Convert to Arrow table
        data = {
            "id": [c.id for c in chunks],
            "file_path": [c.file_path for c in chunks],
            "content": [c.content for c in chunks],
            "language": [c.language for c in chunks],
            "chunk_start": [c.chunk_start for c in chunks],
            "chunk_end": [c.chunk_end for c in chunks],
            "file_hash": [c.file_hash for c in chunks],
            "repo_name": [c.repo_name for c in chunks],
            "vector": [c.vector for c in chunks],
        }

        arrow_table = pa.table(data)
        t_merge = time.perf_counter()
        await self.table.merge_insert("id") \
            .when_matched_update_all() \
            .when_not_matched_insert_all() \
            .execute(arrow_table)
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
        repo: Optional[str] = None,
        language: Optional[str] = None
    ) -> List[SearchResult]:
        """Search for similar code chunks."""
        query = (await self.table.search(query_vector)).distance_type("cosine").limit(limit)

        # Apply filters — use _safe_str_filter to prevent injection
        filters = []
        if repo:
            filters.append(_safe_str_filter("repo_name", repo))
        if language:
            # Additionally allowlist against known language values
            if language not in CodeChunker.SUPPORTED_LANGUAGES.values():
                raise ValueError(f"Unsupported language filter: {language!r}")
            filters.append(_safe_str_filter("language", language))

        if filters:
            query = query.where(" AND ".join(filters))

        tbl = await query.to_arrow()
        search_results: List[SearchResult] = []
        has_dist = "_distance" in tbl.column_names
        for i in range(tbl.num_rows):
            dist = float(tbl.column("_distance")[i].as_py()) if has_dist else 0.0
            score = 1.0 - dist
            content = tbl.column("content")[i].as_py()
            if not isinstance(content, str):
                content = str(content)
            search_results.append(
                SearchResult(
                    id=tbl.column("id")[i].as_py(),
                    file_path=tbl.column("file_path")[i].as_py(),
                    content=content[:500],
                    language=tbl.column("language")[i].as_py(),
                    chunk_start=int(tbl.column("chunk_start")[i].as_py()),
                    chunk_end=int(tbl.column("chunk_end")[i].as_py()),
                    score=score,
                    repo_name=tbl.column("repo_name")[i].as_py(),
                )
            )

        return search_results

    async def get_existing_hashes(self, repo_name: str) -> dict:
        """Get existing file hashes for incremental indexing."""
        tbl = await (
            self.table.query()
            .where(_safe_str_filter("repo_name", repo_name))
            .select(["file_path", "file_hash"])
            .to_arrow()
        )
        if tbl.num_rows == 0:
            return {}
        # Last row per file_path wins (matches previous pandas drop_duplicates(keep="last")).
        out: dict = {}
        for i in range(tbl.num_rows - 1, -1, -1):
            fp = tbl.column("file_path")[i].as_py()
            if fp not in out:
                out[fp] = tbl.column("file_hash")[i].as_py()
        return out

# -----------------------------------------------------------------------------
# File system watcher
# -----------------------------------------------------------------------------
class RepoWatcher(FileSystemEventHandler):
    def __init__(self, indexer: "CocoIndexer", loop: asyncio.AbstractEventLoop):
        self.indexer = indexer
        self._loop = loop  # asyncio event loop captured from the async context at startup
        self._pending: set = set()
        # threading.Lock (not asyncio.Lock) because on_modified is called from
        # Watchdog's OS thread — asyncio primitives cannot be used cross-thread.
        self._lock = threading.Lock()

    def on_modified(self, event):
        if not event.is_directory and self._is_code_file(event.src_path):
            # asyncio.run_coroutine_threadsafe is the correct way to schedule a
            # coroutine onto an asyncio event loop from a non-asyncio thread.
            # asyncio.create_task() would fail here with RuntimeError.
            asyncio.run_coroutine_threadsafe(
                self._queue_index(event.src_path), self._loop
            )

    def _is_code_file(self, path: str) -> bool:
        ext = Path(path).suffix.lower()
        return ext in CodeChunker.SUPPORTED_LANGUAGES

    async def _queue_index(self, file_path: str):
        with self._lock:
            if file_path in self._pending:
                return
            self._pending.add(file_path)

        # Debounce: wait before indexing to avoid thrashing on rapid saves
        await asyncio.sleep(2)

        with self._lock:
            self._pending.discard(file_path)

        logger.info("Reindexing modified file", file=file_path)
        await self.indexer.index_file(file_path)

# -----------------------------------------------------------------------------
# Main indexer
# -----------------------------------------------------------------------------
class CocoIndexer:
    def __init__(self):
        self.chunker = CodeChunker()
        self.db = LanceDBManager(settings.lancedb_uri)
        self.embedder: Optional[EmbeddingClient] = None
        self.observer: Optional[Observer] = None
        self._index_lock = asyncio.Lock()  # prevents concurrent reindex (DoS guard)
    
    async def initialize(self):
        await self.db.connect()
        _oa = os.environ.get("COCOINDEX_EMBEDDING_OPENAI_COMPATIBLE", "").lower() in ("1", "true", "yes")
        self.embedder = EmbeddingClient(
            settings.embedding_url,
            openai_compatible=_oa,
            openai_model=os.environ.get("COCOINDEX_EMBEDDING_MODEL_ID", "").strip(),
            max_concurrent_batches=settings.embedding_max_concurrent_batches,
        )
        logger.info("Indexer initialized")
    
    async def close(self):
        # Stop filesystem watcher first so Watchdog cannot enqueue work during teardown.
        if self.observer:
            self.observer.stop()
            self.observer.join()
            self.observer = None
        if self.embedder:
            await self.embedder.close()
            self.embedder = None
        if self.db.db is not None:
            self.db.db.close()
            self.db.db = None
            self.db.table = None
    
    def start_watching(self):
        """Start file system watcher. Must be called from within the running asyncio event loop."""
        if not settings.watch_repos:
            return

        # Capture the running event loop so RepoWatcher can schedule coroutines
        # from Watchdog's OS thread via asyncio.run_coroutine_threadsafe().
        loop = asyncio.get_running_loop()
        watcher = RepoWatcher(self, loop)
        self.observer = Observer()
        self.observer.schedule(watcher, settings.repos_path, recursive=True)
        self.observer.start()
        logger.info("Started file watcher", path=settings.repos_path)
    
    async def index_repositories(self, force: bool = False) -> IndexResponse:
        """Index all repositories in the repos path. Only one indexing run at a time."""
        if self._index_lock.locked():
            raise HTTPException(status_code=429, detail="Indexing already in progress")
        async with self._index_lock:
            return await self._do_index_repositories(force)

    async def _do_index_repositories(self, force: bool = False) -> IndexResponse:
        """Internal indexing implementation (called under _index_lock)."""
        start_time = time.time()
        
        repos_path = Path(settings.repos_path)
        if not repos_path.exists():
            raise ValueError(f"Repos path does not exist: {repos_path}")
        
        stats = {"indexed": 0, "updated": 0, "skipped": 0, "errors": 0}
        
        # Find all repositories
        for repo_dir in repos_path.iterdir():
            if not repo_dir.is_dir():
                continue
            
            try:
                repo_stats = await self._index_repository(repo_dir, force)
                for key in stats:
                    stats[key] += repo_stats[key]
            except Exception as e:
                logger.error("Failed to index repository", repo=str(repo_dir), error=str(e))
                stats["errors"] += 1
        
        duration_ms = (time.time() - start_time) * 1000
        logger.info(
            "index_repositories_complete",
            duration_ms=round(duration_ms, 2),
            **stats,
        )
        return IndexResponse(**stats, duration_ms=duration_ms)
    
    async def _index_repository(self, repo_path: Path, force: bool = False) -> dict:
        """Index a single repository."""
        repo_name = repo_path.name
        stats = {"indexed": 0, "updated": 0, "skipped": 0, "errors": 0}
        
        # Get existing hashes for incremental indexing
        existing_hashes = {} if force else await self.db.get_existing_hashes(repo_name)
        
        # Collect all chunks
        all_chunks: List[CodeChunk] = []
        files_to_process: List[Path] = []
        
        for ext in CodeChunker.SUPPORTED_LANGUAGES.keys():
            for file_path in repo_path.rglob(f"*{ext}"):
                # Skip common non-source directories
                if any(part.startswith(".") or part in ["node_modules", "vendor", "target", "dist", "build"] 
                       for part in file_path.parts):
                    continue
                
                files_to_process.append(file_path)
        
        logger.info("Found files to index", repo=repo_name, count=len(files_to_process))

        file_sem = asyncio.Semaphore(settings.max_concurrent_file_tasks)

        async def _one_file(fp: Path):
            async with file_sem:
                return await asyncio.to_thread(
                    _coco_read_and_chunk_file,
                    repo_path,
                    fp,
                    repo_name,
                    self.chunker,
                )

        file_results = await asyncio.gather(
            *[_one_file(fp) for fp in files_to_process],
            return_exceptions=True,
        )
        for file_path, res in zip(files_to_process, file_results):
            if isinstance(res, BaseException):
                logger.error(
                    "Failed to process file",
                    file=str(file_path),
                    error=str(res),
                )
                stats["errors"] += 1
                continue
            relative_path, file_hash, chunks = res
            if not force and existing_hashes.get(relative_path) == file_hash:
                stats["skipped"] += 1
                continue
            all_chunks.extend(chunks)
            if existing_hashes.get(relative_path):
                stats["updated"] += 1
            else:
                stats["indexed"] += 1

        # Get embeddings in batches
        if all_chunks:
            await self._embed_and_upsert(all_chunks)
        
        logger.info("Repository indexed", repo=repo_name, **stats)
        return stats
    
    async def _embed_and_upsert(
        self,
        chunks: List[CodeChunk],
        *,
        finalize_vector_index: bool = True,
    ):
        """Get embeddings and upsert to LanceDB. One vector-index refresh when finalize_vector_index."""
        assert self.embedder is not None
        batch_size = settings.embedding_batch_size
        batch_list = [chunks[i : i + batch_size] for i in range(0, len(chunks), batch_size)]

        async def _embed_batch(idx: int, batch: List[CodeChunk]) -> tuple:
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
            for chunk, embedding in zip(batch, embeddings):
                chunk.vector = embedding
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
    
    async def index_file(self, file_path: str):
        """Index a single file (for incremental updates)."""
        path = Path(file_path)
        if not path.exists():
            return
        
        # Find which repo this file belongs to
        repos_path = Path(settings.repos_path)
        try:
            rel_path = path.relative_to(repos_path)
            repo_name = rel_path.parts[0]
            relative_file_path = str(rel_path.relative_to(repo_name))
        except ValueError:
            logger.warning("File not in repos path", file=file_path)
            return
        
        try:
            chunks = await asyncio.to_thread(
                _coco_watcher_read_chunk,
                path,
                relative_file_path,
                repo_name,
                self.chunker,
            )
            await self._embed_and_upsert(chunks)
            logger.info("File indexed", file=file_path)
        except Exception as e:
            logger.error("Failed to index file", file=file_path, error=str(e))
    
    async def search(self, request: SearchRequest) -> List[SearchResult]:
        """Search for code."""
        t0 = time.perf_counter()
        embeddings = await self.embedder.embed([request.query])
        logger.debug(
            "search_query_embed_ms",
            ms=round((time.perf_counter() - t0) * 1000.0, 2),
        )
        query_vector = embeddings[0]
        
        # Search database
        results = await self.db.search(
            query_vector,
            limit=request.limit,
            repo=request.repo,
            language=request.language
        )
        
        return results

# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------
indexer = CocoIndexer()
limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Startup
    await indexer.initialize()
    
    if settings.index_on_startup:
        logger.info("Starting initial indexing...")
        result = await indexer.index_repositories()
        logger.info("Initial indexing complete", result=result.model_dump())
    
    indexer.start_watching()
    
    yield
    
    # Shutdown
    await indexer.close()

app = FastAPI(
    title="CocoIndex v1 + LanceDB",
    description="Local Git repository indexing with llama.cpp embeddings",
    version="1.0.0",
    lifespan=lifespan,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.get("/health")
async def health():
    # Unauthenticated — required for Kubernetes liveness/readiness probes.
    return {"status": "healthy", "indexer_ready": indexer.embedder is not None}

@app.post("/index", response_model=IndexResponse, dependencies=[Depends(require_token)])
@limiter.limit(settings.rate_limit_index)
async def index_repos(request: Request, body: IndexRequest):
    """Trigger indexing of repositories. Requires Bearer token."""
    try:
        result = await indexer.index_repositories(force=body.force_reindex)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/search", response_model=List[SearchResult], dependencies=[Depends(require_token)])
@limiter.limit(settings.rate_limit_search)
async def search_post_body(request: Request, body: SearchRequest):
    """Search indexed code. Requires Bearer token."""
    try:
        results = await indexer.search(body)
        return results
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/search", dependencies=[Depends(require_token)])
@limiter.limit(settings.rate_limit_search)
async def search_get(
    request: Request,
    q: str = Query(..., description="Search query"),
    repo: Optional[str] = Query(None, description="Filter by repository"),
    language: Optional[str] = Query(None, description="Filter by language"),
    limit: int = Query(10, ge=1, le=100),
):
    """Search indexed code (GET endpoint). Requires Bearer token."""
    sr = SearchRequest(query=q, repo=repo, language=language, limit=limit)
    return await search_post_body(request, sr)

@app.get("/stats", dependencies=[Depends(require_token)])
async def stats():
    """Get indexing statistics. Requires Bearer token.
    Returns only operational metrics — internal paths are not exposed.
    """
    try:
        count = await indexer.db.table.count_rows()
        return {
            "total_chunks": count,
            "table": LanceDBManager.TABLE_NAME,
            "status": "ready",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# -----------------------------------------------------------------------------
# MCP Server (internal — only called by the MCP gateway, not by workers directly)
# -----------------------------------------------------------------------------
_MCP_TOOLS = [
    {
        "name": "search_code",
        "description": "Semantic search over indexed source code. Returns code chunks with file paths and line numbers.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language search query"},
                "repo": {"type": "string", "description": "Optional: restrict to a specific project/repo directory name"},
                "language": {"type": "string", "description": "Optional: restrict to a language (python, go, typescript, etc.)"},
                "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_index_stats",
        "description": "Return indexing statistics: total chunk count and table name.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]
# NOTE: index_repository and delete_repo are intentionally absent — they are
# REST-only (POST /index) and require the full admin token. The gateway blocks
# any attempt to call them via MCP.


@app.get("/mcp", dependencies=[Depends(require_token)])
async def mcp_sse(request: Request):
    """MCP SSE transport endpoint (internal). Clients connect here first to get the message URL."""
    async def generator():
        yield {"event": "endpoint", "data": "/mcp/message"}
        while not await request.is_disconnected():
            yield {"event": "ping", "data": ""}
            await asyncio.sleep(15)
    return EventSourceResponse(generator())


@app.post("/mcp/message", dependencies=[Depends(require_token)])
async def mcp_message(body: dict):
    """MCP JSON-RPC message handler (internal). Only the MCP gateway should call this."""
    method = body.get("method")
    params = body.get("params", {})
    req_id = body.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hive-cocoindex", "version": "1.0.0"},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": _MCP_TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments", {})
        try:
            if name == "search_code":
                req = SearchRequest(
                    query=args["query"],
                    repo=args.get("repo"),
                    language=args.get("language"),
                    limit=args.get("limit", 10),
                )
                results = await indexer.search(req)
                content = [{"type": "text", "text": json.dumps([r.model_dump() for r in results])}]
            elif name == "get_index_stats":
                count = await indexer.db.table.count_rows()
                content = [{"type": "text", "text": json.dumps({
                    "total_chunks": count,
                    "table": LanceDBManager.TABLE_NAME,
                    "status": "ready",
                })}]
            else:
                return {"jsonrpc": "2.0", "id": req_id,
                        "error": {"code": -32602, "message": f"Unknown tool: {name!r}"}}
            return {"jsonrpc": "2.0", "id": req_id, "result": {"content": content}}
        except ValueError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": str(e)}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": str(e)}}
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": "Method not found"}}


# -----------------------------------------------------------------------------
# Main entry point
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "cocoindex_server:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level
    )