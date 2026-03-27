"""
Chunk long document text: prefer splits at Markdown headings, then fixed-size windows with overlap.
"""

from __future__ import annotations

import re
from typing import List


def chunk_document_text(text: str, chunk_size: int, chunk_overlap: int) -> List[str]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    overlap = min(chunk_overlap, max(0, chunk_size - 1))

    text = text.strip()
    if not text:
        return []

    # Segment on lines that look like Markdown headings (any level).
    if re.search(r"(?m)^#+\s+\S", text):
        parts = re.split(r"(?m)(?=^#+\s+\S)", text)
        segments = [p.strip() for p in parts if p.strip()]
    else:
        segments = [text]

    chunks: List[str] = []
    for seg in segments:
        if len(seg) <= chunk_size:
            chunks.append(seg)
            continue
        start = 0
        while start < len(seg):
            end = min(start + chunk_size, len(seg))
            piece = seg[start:end].strip()
            if piece:
                chunks.append(piece)
            if end >= len(seg):
                break
            start = end - overlap if end < len(seg) else end

    return [c for c in chunks if c]
