"""Tests for document_chunker.chunk_document_text."""

import pytest

from document_chunker import chunk_document_text


def test_empty_text():
    assert chunk_document_text("", 100, 10) == []
    assert chunk_document_text("   ", 100, 10) == []


def test_short_text_single_chunk():
    t = "Hello world"
    chunks = chunk_document_text(t, 1000, 50)
    assert len(chunks) == 1
    assert chunks[0] == "Hello world"


def test_heading_split():
    t = "# Title\n\nFirst section.\n\n## Sub\n\nMore here."
    chunks = chunk_document_text(t, 500, 50)
    assert len(chunks) >= 1
    joined = "\n".join(chunks)
    assert "Title" in joined
    assert "More here" in joined


def test_long_segment_windowed():
    long_line = "x" * 5000
    chunks = chunk_document_text(long_line, 1000, 100)
    assert len(chunks) >= 4
    total = sum(len(c) for c in chunks)
    assert total >= 4000


def test_invalid_chunk_size():
    with pytest.raises(ValueError):
        chunk_document_text("a", 0, 0)
