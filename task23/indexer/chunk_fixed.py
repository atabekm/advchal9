"""Fixed-size chunking: a sliding window over the flat text, blind to structure.

The window is `size` characters with `overlap` characters shared between
neighbours. Its end is pulled back to the last whitespace so words stay whole;
that is the only concession to the text.
"""

from __future__ import annotations

from .chunk import Chunk, Flat, make_chunk
from .extract import Document

SIZE = 1000
OVERLAP = 150


def chunk_fixed(doc: Document, size: int = SIZE, overlap: int = OVERLAP) -> list[Chunk]:
    if overlap >= size:
        raise ValueError("overlap must be smaller than size")
    flat = Flat(doc)
    text = flat.text
    chunks: list[Chunk] = []
    start = _skip_space(text, 0)
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            ws = _last_space(text, start + size // 2, end)
            if ws > start:
                end = ws
        piece = text[start:end].strip()
        if piece:
            spans = flat.spans_in(start, end)
            chunks.append(make_chunk(
                doc, "fixed", len(chunks), piece,
                section=flat.span_at(start).section,
                pages=[s.page for s in spans],
                sections={s.section for s in spans},
            ))
        if end >= len(text):
            break
        # Step back by the overlap, then forward to the start of a word.
        nxt = end - overlap
        while nxt > start and nxt < end and not text[nxt - 1].isspace():
            nxt += 1
        start = _skip_space(text, max(nxt, start + 1))
    return chunks


def _last_space(text: str, lo: int, hi: int) -> int:
    for i in range(hi, lo, -1):
        if text[i - 1].isspace():
            return i - 1
    return -1


def _skip_space(text: str, i: int) -> int:
    while i < len(text) and text[i].isspace():
        i += 1
    return i
