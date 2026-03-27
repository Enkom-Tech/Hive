"""document_parsers routing — Docling vs Unstructured via mocks."""

from pathlib import Path
from unittest.mock import patch

import pytest

from document_parsers import DOCLING_EXTENSIONS, extract_text


def test_docling_extensions_cover_office():
    assert ".pdf" in DOCLING_EXTENSIONS
    assert ".docx" in DOCLING_EXTENSIONS


def test_extract_plain_md_without_heavy_parsers(tmp_path: Path):
    p = tmp_path / "note.md"
    p.write_text("# Hi\n\nbody text", encoding="utf-8")
    with patch("document_parsers.extract_with_docling", side_effect=RuntimeError("skip")):
        with patch("document_parsers.extract_with_unstructured", side_effect=RuntimeError("skip")):
            text, mime = extract_text(p)
    assert "Hi" in text
    assert "body" in text


@patch("document_parsers.extract_with_unstructured")
@patch("document_parsers.extract_with_docling")
def test_pdf_uses_docling_first(mock_dl, mock_us, tmp_path: Path):
    p = tmp_path / "a.pdf"
    p.write_bytes(b"%PDF-1.4 minimal")
    mock_dl.return_value = "from docling"
    text, _ = extract_text(p)
    assert text == "from docling"
    mock_dl.assert_called_once()
    mock_us.assert_not_called()


@patch("document_parsers.extract_with_unstructured")
@patch("document_parsers.extract_with_docling", side_effect=RuntimeError("fail"))
def test_docling_failure_falls_back_unstructured(mock_dl, mock_us, tmp_path: Path):
    p = tmp_path / "a.pdf"
    p.write_bytes(b"x")
    mock_us.return_value = "from unstructured"
    text, _ = extract_text(p)
    assert text == "from unstructured"
    mock_us.assert_called_once()
