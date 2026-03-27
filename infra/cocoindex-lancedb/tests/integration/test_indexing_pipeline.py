"""
End-to-end indexing pipeline without Docker: real LanceDB on disk, fake embedder.

Exercises chunking, upsert, and vector search the same way production does,
without llama.cpp or Dragonfly.
"""

from __future__ import annotations

from typing import List

import pytest

import cocoindex_server as cs


class _UnitFakeEmbedder:
    """Returns the same L2-normalized vector for every text so cosine search returns hits."""

    def __init__(self, dim: int) -> None:
        self.dim = dim

    async def embed(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        inv_sqrt = 1.0 / (self.dim**0.5)
        vec = [inv_sqrt] * self.dim
        return [list(vec) for _ in texts]

    async def close(self) -> None:
        pass


@pytest.fixture
def sample_repo(tmp_path):
    repos = tmp_path / "repos"
    (repos / "demo").mkdir(parents=True)
    (repos / "demo" / "hello.py").write_text(
        "def greet(name: str) -> str:\n    return f'hello {name}'\n",
        encoding="utf-8",
    )
    return repos


@pytest.mark.asyncio
async def test_index_repositories_and_search(sample_repo, tmp_path, monkeypatch):
    ldb_dir = tmp_path / "lancedb"
    ldb_dir.mkdir()
    dim = 16
    monkeypatch.setattr(cs.settings, "repos_path", str(sample_repo))
    monkeypatch.setattr(cs.settings, "lancedb_uri", str(ldb_dir))
    monkeypatch.setattr(cs.settings, "embedding_dim", dim)
    monkeypatch.setattr(cs.settings, "embedding_batch_size", 32)

    idx = cs.CocoIndexer()
    idx.embedder = _UnitFakeEmbedder(dim)
    await idx.db.connect()

    try:
        resp = await idx.index_repositories(force=True)
        assert resp.errors == 0
        assert resp.indexed + resp.updated >= 1
        results = await idx.search(cs.SearchRequest(query="greet", repo="demo", limit=10))
        assert len(results) >= 1
        assert any("greet" in r.content or "hello" in r.content for r in results)
    finally:
        await idx.embedder.close()
        if idx.db.db is not None:
            idx.db.db.close()


def _norm_embedding(dim: int) -> List[float]:
    inv = 1.0 / (dim**0.5)
    return [inv] * dim


def _make_bulk_code_chunks(offset: int, count: int, dim: int) -> List[cs.CodeChunk]:
    vec = _norm_embedding(dim)
    out: List[cs.CodeChunk] = []
    for i in range(count):
        n = offset + i
        out.append(
            cs.CodeChunk(
                id=f"bulk-{n}",
                file_path=f"src/f{n}.py",
                content=f"def fn{n}():\n    return {n}\n",
                language="python",
                chunk_start=0,
                chunk_end=24,
                file_hash=f"{n:016x}"[:16],
                repo_name="bulk",
                vector=list(vec),
            )
        )
    return out


async def _vector_index_types(table) -> List[str]:
    indices = await table.list_indices()
    return [ic.index_type for ic in indices if "vector" in (getattr(ic, "columns", None) or [])]


@pytest.mark.asyncio
async def test_ivf_flat_upgrades_to_ivf_pq_at_256_rows(tmp_path, monkeypatch):
    """Below 256 rows we use IvfFlat; after crossing 256, index upgrades to IvfPq."""
    ldb_dir = tmp_path / "lancedb"
    ldb_dir.mkdir()
    dim = 16
    monkeypatch.setattr(cs.settings, "lancedb_uri", str(ldb_dir))
    monkeypatch.setattr(cs.settings, "embedding_dim", dim)

    mgr = cs.LanceDBManager(str(ldb_dir))
    await mgr.connect()
    try:
        await mgr.upsert_chunks(_make_bulk_code_chunks(0, 100, dim))
        assert mgr.table is not None
        vtypes = await _vector_index_types(mgr.table)
        assert "IvfFlat" in vtypes
        assert "IvfPq" not in vtypes

        await mgr.upsert_chunks(_make_bulk_code_chunks(100, 156, dim))
        vtypes = await _vector_index_types(mgr.table)
        assert "IvfPq" in vtypes
        assert "IvfFlat" not in vtypes
    finally:
        if mgr.db is not None:
            mgr.db.close()
            mgr.db = None
            mgr.table = None
