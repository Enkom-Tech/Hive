"""
Document text extraction: Docling-first for layout-heavy office/PDF files,
Unstructured as fallback and for HTML, email, plain text, etc.
"""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

import structlog

from docindex_constants import DOCLING_EXTENSIONS

logger = structlog.get_logger(__name__)


def _guess_mime(path: Path) -> str:
    import mimetypes

    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def extract_with_docling(path: Path) -> str:
    """Convert document to markdown-oriented text using Docling."""
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(str(path))
    return result.document.export_to_markdown()


def extract_with_unstructured(path: Path) -> str:
    """Partition file with Unstructured; concatenate element text."""
    from unstructured.partition.auto import partition

    elements = partition(filename=str(path))
    parts = [str(el).strip() for el in elements if str(el).strip()]
    return "\n\n".join(parts)


def extract_plain_text(path: Path) -> str:
    """Best-effort UTF-8 read for simple text-like files."""
    return path.read_text(encoding="utf-8", errors="replace")


def extract_text(path: Path) -> Tuple[str, str]:
    """
    Extract text and a MIME hint from a file path.
    Tries Docling for office/PDF, then Unstructured, then plain read.
    """
    mime = _guess_mime(path)
    suffix = path.suffix.lower()

    errors: list[str] = []

    if suffix in DOCLING_EXTENSIONS:
        try:
            text = extract_with_docling(path)
            if text.strip():
                return text.strip(), mime
        except Exception as e:
            errors.append(f"docling:{e}")
            logger.warning("docling_failed", path=str(path), error=str(e))

    try:
        text = extract_with_unstructured(path)
        if text.strip():
            return text.strip(), mime
    except Exception as e:
        errors.append(f"unstructured:{e}")
        logger.warning("unstructured_failed", path=str(path), error=str(e))

    if suffix in {".md", ".markdown", ".txt", ".rst", ".csv", ".json", ".xml", ".yaml", ".yml"}:
        try:
            text = extract_plain_text(path)
            if text.strip():
                return text.strip(), mime
        except Exception as e:
            errors.append(f"plain:{e}")

    raise RuntimeError(
        "Could not extract text from "
        f"{path!s} ({', '.join(errors) if errors else 'no parsers succeeded'})"
    )
