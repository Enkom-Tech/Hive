"""
Extension sets for document indexing — no Docling/Unstructured imports (safe for slim API image).
"""

from __future__ import annotations

# Mirrors document_parsers.DOCLING_EXTENSIONS without importing docling.
DOCLING_EXTENSIONS = frozenset({".pdf", ".docx", ".pptx", ".ppt", ".xlsx", ".xls"})

ALLOWED_INDEX_EXTENSIONS = DOCLING_EXTENSIONS | {
    ".html",
    ".htm",
    ".md",
    ".markdown",
    ".txt",
    ".rst",
    ".csv",
    ".eml",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
}
