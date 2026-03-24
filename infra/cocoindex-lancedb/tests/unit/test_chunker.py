"""
Unit tests for CodeChunker — line-based chunking with overlap.
"""

import pytest
import cocoindex_server as cs


CHUNK_SIZE = cs.CodeChunker.CHUNK_SIZE
CHUNK_OVERLAP = cs.CodeChunker.CHUNK_OVERLAP


@pytest.fixture
def chunker():
    return cs.CodeChunker()


class TestChunkFile:
    def test_empty_file_produces_no_chunks(self, chunker):
        chunks = chunker.chunk_file("src/empty.py", "", "my-repo")
        assert chunks == []

    def test_single_line_file_produces_one_chunk(self, chunker):
        content = "x = 1"
        chunks = chunker.chunk_file("src/x.py", content, "my-repo")
        assert len(chunks) == 1
        assert chunks[0].content == content
        assert chunks[0].chunk_start == 0
        assert chunks[0].chunk_end == 1

    def test_file_smaller_than_chunk_size_produces_one_chunk(self, chunker):
        lines = [f"line_{i}" for i in range(100)]
        content = "\n".join(lines)
        chunks = chunker.chunk_file("src/small.py", content, "my-repo")
        assert len(chunks) == 1
        assert chunks[0].chunk_start == 0
        assert chunks[0].chunk_end == 100

    def test_file_larger_than_chunk_size_produces_multiple_chunks(self, chunker):
        lines = [f"line_{i}" for i in range(CHUNK_SIZE * 2)]
        content = "\n".join(lines)
        chunks = chunker.chunk_file("src/large.py", content, "my-repo")
        assert len(chunks) > 1

    def test_chunks_have_overlap(self, chunker):
        lines = [f"line_{i}" for i in range(CHUNK_SIZE + 100)]
        content = "\n".join(lines)
        chunks = chunker.chunk_file("src/overlap.py", content, "my-repo")
        assert len(chunks) >= 2
        # Second chunk should start before first chunk ends (overlap)
        assert chunks[1].chunk_start < chunks[0].chunk_end

    def test_chunk_ids_are_unique(self, chunker):
        lines = [f"line_{i}" for i in range(CHUNK_SIZE * 3)]
        content = "\n".join(lines)
        chunks = chunker.chunk_file("src/big.py", content, "my-repo")
        ids = [c.id for c in chunks]
        assert len(ids) == len(set(ids))

    def test_file_hash_is_deterministic(self, chunker):
        content = "def foo():\n    return 42\n"
        chunks1 = chunker.chunk_file("src/foo.py", content, "repo-a")
        chunks2 = chunker.chunk_file("src/foo.py", content, "repo-b")
        assert chunks1[0].file_hash == chunks2[0].file_hash

    def test_different_content_produces_different_hash(self, chunker):
        c1 = chunker.chunk_file("src/a.py", "x = 1", "repo")
        c2 = chunker.chunk_file("src/a.py", "x = 2", "repo")
        assert c1[0].file_hash != c2[0].file_hash

    def test_repo_name_propagated(self, chunker):
        chunks = chunker.chunk_file("src/a.py", "x = 1", "my-special-repo")
        assert all(c.repo_name == "my-special-repo" for c in chunks)

    def test_language_detected_from_extension(self, chunker):
        chunks = chunker.chunk_file("src/app.ts", "const x = 1;", "repo")
        assert chunks[0].language == "typescript"

    def test_unknown_extension_defaults_to_text(self, chunker):
        chunks = chunker.chunk_file("README.md", "# Hello", "repo")
        assert chunks[0].language == "text"

    def test_chunk_id_format(self, chunker):
        chunks = chunker.chunk_file("src/foo.py", "x = 1", "repo")
        assert ":" in chunks[0].id
        assert chunks[0].id.startswith("src/foo.py:")
