#!/usr/bin/env python3
"""
CocoIndex v1 + LanceDB Server
Local Git repository indexing with llama.cpp embeddings.
"""

import asyncio
import hashlib
import json
import os
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
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel, Field
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

# -----------------------------------------------------------------------------
# Safe filter helpers — prevent LanceDB filter injection
# -----------------------------------------------------------------------------
_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-\.]+$')

def _safe_str_filter(column: str, value: str) -> str:
    """
    Build a LanceDB WHERE clause for a string equality check.
    Raises ValueError if value contains SQL metacharacters, preventing injection.
    Only alphanumeric characters plus _ - . are permitted.
    """
    if not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid filter value for '{column}': {value!r}")
    return f"{column} = '{value}'"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
class Settings(BaseModel):
    repos_path: str = Field(default="/data/repos", alias="COCOINDEX_REPOS_PATH")
    lancedb_uri: str = Field(default="/data/lancedb", alias="COCOINDEX_LANCEDB_URI")
    embedding_url: str = Field(default="http://llama-embeddings:8080", alias="COCOINDEX_EMBEDDING_URL")
    embedding_dim: int = Field(default=4096, alias="COCOINDEX_EMBEDDING_DIM")
    embedding_batch_size: int = Field(default=32, alias="COCOINDEX_EMBEDDING_BATCH_SIZE")
    api_host: str = Field(default="0.0.0.0", alias="COCOINDEX_API_HOST")
    api_port: int = Field(default=8080, alias="COCOINDEX_API_PORT")
    index_on_startup: bool = Field(default=True, alias="COCOINDEX_INDEX_ON_STARTUP")
    watch_repos: bool = Field(default=True, alias="COCOINDEX_WATCH_REPOS")
    log_level: str = Field(default="info", alias="COCOINDEX_LOG_LEVEL")

    class Config:
        env_prefix = ""
        populate_by_name = True

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

# -----------------------------------------------------------------------------
# Embedding client
# -----------------------------------------------------------------------------
class EmbeddingClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip('/')
        self.client = httpx.AsyncClient(timeout=300.0)
    
    async def embed(self, texts: List[str]) -> List[List[float]]:
        """Get embeddings from llama.cpp server."""
        if not texts:
            return []
        
        # llama.cpp server embedding endpoint
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
class LanceDBManager:
    TABLE_NAME = "code_embeddings"
    
    def __init__(self, uri: str):
        self.uri = uri
        self.db: Optional[lancedb.AsyncConnection] = None
        self.table: Optional[lancedb.AsyncTable] = None
    
    async def connect(self):
        self.db = await lancedb.connect_async(self.uri)
        await self._ensure_table()
    
    async def _ensure_table(self):
        """Create table if not exists."""
        import pyarrow as pa
        
        try:
            self.table = await self.db.open_table(self.TABLE_NAME)
            logger.info("Opened existing table", table=self.TABLE_NAME)
        except Exception:
            # Create new table
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
            
            # Create vector index
            await self.table.create_index(
                "vector",
                index_type="ivf_pq",
                metric="cosine",
                num_partitions=16,
                num_sub_vectors=8
            )
            logger.info("Created new table with index", table=self.TABLE_NAME)
    
    async def upsert_chunks(self, chunks: List[CodeChunk]):
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
        await self.table.merge_insert("id") \
            .when_matched_update_all() \
            .when_not_matched_insert_all() \
            .execute(arrow_table)
    
    async def search(
        self,
        query_vector: List[float],
        limit: int = 10,
        repo: Optional[str] = None,
        language: Optional[str] = None
    ) -> List[SearchResult]:
        """Search for similar code chunks."""
        import lancedb.query
        
        query = self.table.search(query_vector).metric("cosine").limit(limit)

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
        
        results = await query.to_pandas()
        
        search_results = []
        for _, row in results.iterrows():
            # Cosine distance to similarity score
            score = 1.0 - float(row.get("_distance", 0))
            
            search_results.append(SearchResult(
                id=row["id"],
                file_path=row["file_path"],
                content=row["content"][:500],  # Truncate for response
                language=row["language"],
                chunk_start=int(row["chunk_start"]),
                chunk_end=int(row["chunk_end"]),
                score=score,
                repo_name=row["repo_name"]
            ))
        
        return search_results
    
    async def get_existing_hashes(self, repo_name: str) -> dict:
        """Get existing file hashes for incremental indexing."""
        results = await self.table.query() \
            .where(_safe_str_filter("repo_name", repo_name)) \
            .select(["file_path", "file_hash"]) \
            .to_pandas()
        
        # Get unique file_path -> file_hash mapping
        return dict(zip(results["file_path"], results["file_hash"]))

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
        self.embedder = EmbeddingClient(settings.embedding_url)
        logger.info("Indexer initialized")
    
    async def close(self):
        if self.embedder:
            await self.embedder.close()
        if self.observer:
            self.observer.stop()
            self.observer.join()
    
    def start_watching(self):
        """Start file system watcher. Must be called from within the running asyncio event loop."""
        if not settings.watch_repos:
            return

        # Capture the running event loop so RepoWatcher can schedule coroutines
        # from Watchdog's OS thread via asyncio.run_coroutine_threadsafe().
        loop = asyncio.get_event_loop()
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
        import time
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
        
        for file_path in files_to_process:
            try:
                relative_path = str(file_path.relative_to(repo_path))
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                file_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
                
                # Skip unchanged files
                if not force and existing_hashes.get(relative_path) == file_hash:
                    stats["skipped"] += 1
                    continue
                
                # Chunk the file
                chunks = self.chunker.chunk_file(relative_path, content, repo_name)
                all_chunks.extend(chunks)
                
                if existing_hashes.get(relative_path):
                    stats["updated"] += 1
                else:
                    stats["indexed"] += 1
                    
            except Exception as e:
                logger.error("Failed to process file", file=str(file_path), error=str(e))
                stats["errors"] += 1
        
        # Get embeddings in batches
        if all_chunks:
            await self._embed_and_upsert(all_chunks)
        
        logger.info("Repository indexed", repo=repo_name, **stats)
        return stats
    
    async def _embed_and_upsert(self, chunks: List[CodeChunk]):
        """Get embeddings and upsert to LanceDB."""
        batch_size = settings.embedding_batch_size
        
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            texts = [c.content for c in batch]
            
            # Get embeddings
            embeddings = await self.embedder.embed(texts)
            
            # Attach embeddings to chunks
            for chunk, embedding in zip(batch, embeddings):
                chunk.vector = embedding
            
            # Upsert to database
            await self.db.upsert_chunks(batch)
            
            logger.debug("Upserted batch", batch_num=i // batch_size + 1, size=len(batch))
    
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
            content = path.read_text(encoding="utf-8", errors="ignore")
            chunks = self.chunker.chunk_file(relative_file_path, content, repo_name)
            await self._embed_and_upsert(chunks)
            logger.info("File indexed", file=file_path)
        except Exception as e:
            logger.error("Failed to index file", file=file_path, error=str(e))
    
    async def search(self, request: SearchRequest) -> List[SearchResult]:
        """Search for code."""
        # Get query embedding
        embeddings = await self.embedder.embed([request.query])
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
    lifespan=lifespan
)

@app.get("/health")
async def health():
    # Unauthenticated — required for Kubernetes liveness/readiness probes.
    return {"status": "healthy", "indexer_ready": indexer.embedder is not None}

@app.post("/index", response_model=IndexResponse, dependencies=[Depends(require_token)])
async def index_repos(request: IndexRequest):
    """Trigger indexing of repositories. Requires Bearer token."""
    try:
        result = await indexer.index_repositories(force=request.force_reindex)
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/search", response_model=List[SearchResult], dependencies=[Depends(require_token)])
async def search(request: SearchRequest):
    """Search indexed code. Requires Bearer token."""
    try:
        results = await indexer.search(request)
        return results
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/search", dependencies=[Depends(require_token)])
async def search_get(
    q: str = Query(..., description="Search query"),
    repo: Optional[str] = Query(None, description="Filter by repository"),
    language: Optional[str] = Query(None, description="Filter by language"),
    limit: int = Query(10, ge=1, le=100)
):
    """Search indexed code (GET endpoint). Requires Bearer token."""
    request = SearchRequest(query=q, repo=repo, language=language, limit=limit)
    return await search(request)

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