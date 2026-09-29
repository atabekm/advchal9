"""Structure-based chunking: one chunk per section, cut where the document cuts.

1. Every heading starts a new section; its heading path is the chunk's section.
2. A section longer than `max_chars` is packed into several chunks on
   paragraph boundaries (sentence boundaries for a paragraph that is itself
   too long). Only the first carries the heading line; the rest keep the path
   in metadata.
3. A section shorter than `min_chars` (typically a heading followed straight
   by its first subsection) is merged into the next section, so a lone
   heading is never a chunk of its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .chunk import Chunk, Flat, make_chunk, split_long
from .extract import Document

MAX_CHARS = 1500
MIN_CHARS = 200


@dataclass
class _Piece:
    section: str
    text: str = ""
    pages: set[int] = field(default_factory=set)
    sections: set[str] = field(default_factory=set)

    def add(self, text: str, page: int, section: str) -> None:
        self.text = f"{self.text}\n\n{text}" if self.text else text
        self.pages.add(page)
        self.sections.add(section)

    def absorb(self, other: _Piece, before: bool) -> None:
        self.text = f"{other.text}\n\n{self.text}" if before else f"{self.text}\n\n{other.text}"
        self.pages |= other.pages
        self.sections |= other.sections


def chunk_struct(doc: Document, max_chars: int = MAX_CHARS, min_chars: int = MIN_CHARS) -> list[Chunk]:
    flat = Flat(doc)

    # Group spans into sections: a heading opens a new one.
    sections: list[list] = []
    for span in flat.spans:
        if span.heading or not sections or sections[-1][0].section != span.section:
            sections.append([])
        sections[-1].append(span)

    per_section: list[list[_Piece]] = []
    for spans in sections:
        name = spans[0].section
        pieces = [_Piece(name)]
        for span in spans:
            para = flat.text[span.start:span.end]
            for part in split_long(para, max_chars):
                cur = pieces[-1]
                if cur.text and len(cur.text) + 2 + len(part) > max_chars:
                    cur = _Piece(name)
                    pieces.append(cur)
                cur.add(part, span.page, name)
        per_section.append(pieces)

    # Merge sections too small to stand alone into their neighbour.
    merged: list[list[_Piece]] = []
    carry: _Piece | None = None
    for pieces in per_section:
        if carry:
            pieces[0].absorb(carry, before=True)
            carry = None
        if len(pieces) == 1 and len(pieces[0].text) < min_chars:
            carry = pieces[0]
            continue
        merged.append(pieces)
    if carry:
        if merged:
            merged[-1][-1].absorb(carry, before=False)
        else:
            merged.append([carry])

    out: list[Chunk] = []
    for pieces in merged:
        for p in pieces:
            out.append(make_chunk(doc, "struct", len(out), p.text, p.section, sorted(p.pages), p.sections))
    return out
