"""
End-to-end DocIndex pipeline without Docker: real LanceDB, inline parsing (no worker queue),
fake embedder. Covers index → upsert → search without llama.cpp or Redis.
"""

from __future__ import annotations

from typing import List

import pytest

import docindex_server as ds


class _UnitFakeEmbedder:
    """Same normalized vector per text so vector search returns indexed rows."""

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
def sample_docs(tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    (root / "note.md").write_text("# Hello\n\nThis is a test document for DocIndex.\n", encoding="utf-8")
    return root


@pytest.mark.asyncio
async def test_index_documents_and_search(sample_docs, tmp_path, monkeypatch):
    ldb_dir = tmp_path / "lancedb"
    ldb_dir.mkdir()
    dim = 16
    monkeypatch.setattr(ds.settings, "docs_path", str(sample_docs))
    monkeypatch.setattr(ds.settings, "lancedb_uri", str(ldb_dir))
    monkeypatch.setattr(ds.settings, "embedding_dim", dim)
    monkeypatch.setattr(ds.settings, "embedding_batch_size", 32)
    monkeypatch.setattr(ds.settings, "use_worker_queue", False)

    idx = ds.DocIndexer()
    idx.embedder = _UnitFakeEmbedder(dim)
    await idx.db.connect()

    try:
        resp = await idx.index_documents(
            ds.IndexRequest(paths=None, force_reindex=True, source_id=None, acl_scope=None)
        )
        assert resp.errors == 0
        assert resp.indexed + resp.updated >= 1
        results = await idx.search(ds.SearchRequest(query="test document", limit=10))
        assert len(results) >= 1
        assert any("test" in r.content.lower() or "docindex" in r.content.lower() for r in results)
    finally:
        await idx.embedder.close()
        if idx.db.db is not None:
            idx.db.db.close()


def _norm_embedding(dim: int) -> List[float]:
    inv = 1.0 / (dim**0.5)
    return [inv] * dim


def _make_bulk_doc_chunks(offset: int, count: int, dim: int) -> List[ds.DocChunk]:
    vec = _norm_embedding(dim)
    out: List[ds.DocChunk] = []
    for i in range(count):
        n = offset + i
        out.append(
            ds.DocChunk(
                id=f"doc-bulk-{n}",
                file_path=f"notes/p{n}.md",
                content=f"# Section {n}\n\nbody {n}\n",
                mime="text/markdown",
                chunk_index=0,
                content_hash=f"{n:016x}"[:16],
                file_bytes_hash="",
                source_id="bulk",
                acl_scope="public",
                acl_principals="",
                vector=list(vec),
            )
        )
    return out


async def _vector_index_types(table) -> List[str]:
    indices = await table.list_indices()
    return [ic.index_type for ic in indices if "vector" in (getattr(ic, "columns", None) or [])]


@pytest.mark.asyncio
async def test_ivf_flat_upgrades_to_ivf_pq_at_256_rows(tmp_path, monkeypatch):
    ldb_dir = tmp_path / "lancedb"
    ldb_dir.mkdir()
    dim = 16
    monkeypatch.setattr(ds.settings, "lancedb_uri", str(ldb_dir))
    monkeypatch.setattr(ds.settings, "embedding_dim", dim)

    mgr = ds.LanceDBManager(str(ldb_dir))
    await mgr.connect()
    try:
        await mgr.upsert_chunks(_make_bulk_doc_chunks(0, 100, dim))
        assert mgr.table is not None
        vtypes = await _vector_index_types(mgr.table)
        assert "IvfFlat" in vtypes
        assert "IvfPq" not in vtypes

        await mgr.upsert_chunks(_make_bulk_doc_chunks(100, 156, dim))
        vtypes = await _vector_index_types(mgr.table)
        assert "IvfPq" in vtypes
        assert "IvfFlat" not in vtypes
    finally:
        if mgr.db is not None:
            mgr.db.close()
            mgr.db = None
            mgr.table = None
