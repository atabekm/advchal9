"""What both chunkers share: the Chunk record and a flat view of a Document.

Both strategies cut the same flat text (headings on their own line, paragraphs
separated by a blank line), so their numbers are comparable: same characters,
different boundaries.
"""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from .extract import Document

FRONT_MATTER = "(front matter)"


@dataclass
class Chunk:
    chunk_id: str
    strategy: str
    source: str
    title: str
    section: str  # heading path, "3 Model Architecture > 3.2 Attention"
    page_start: int
    page_end: int
    ordinal: int
    text: str
    sections_spanned: int  # distinct sections the chunk's text comes from

    @property
    def char_len(self) -> int:
        return len(self.text)


@dataclass
class _Span:
    start: int
    end: int
    page: int
    section: str
    heading: bool


class Flat:
    """The document as one string, with page and section known for every offset."""

    def __init__(self, doc: Document):
        parts: list[str] = []
        self.spans: list[_Span] = []
        stack: list[tuple[int, str]] = []  # (level, heading)
        pos = 0
        for e in doc.elements:
            if e.kind == "heading":
                while stack and stack[-1][0] >= e.level:
                    stack.pop()
                stack.append((e.level, e.text))
            section = " > ".join(h for _, h in stack) or FRONT_MATTER
            if parts:
                parts.append("\n\n")
                pos += 2
            parts.append(e.text)
            self.spans.append(_Span(pos, pos + len(e.text), e.page, section, e.kind == "heading"))
            pos += len(e.text)
        self.text = "".join(parts)
        self._starts = [s.start for s in self.spans]

    def span_at(self, offset: int) -> _Span:
        i = bisect.bisect_right(self._starts, offset) - 1
        return self.spans[max(i, 0)]

    def spans_in(self, start: int, end: int) -> list[_Span]:
        lo = max(bisect.bisect_right(self._starts, start) - 1, 0)
        hi = bisect.bisect_left(self._starts, end)
        return self.spans[lo:hi]


def slug(source: str) -> str:
    stem = PurePosixPath(source).stem.lower()
    return re.sub(r"[^a-z0-9]+", "-", stem).strip("-")[:40] or "doc"


def make_chunk(doc: Document, strategy: str, ordinal: int, text: str, section: str,
               pages: list[int], sections: set[str]) -> Chunk:
    return Chunk(
        chunk_id=f"{slug(doc.source)}:{strategy}:{ordinal:04d}",
        strategy=strategy,
        source=doc.source,
        title=doc.title,
        section=section,
        page_start=min(pages),
        page_end=max(pages),
        ordinal=ordinal,
        text=text,
        sections_spanned=len(sections),
    )


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(\[\"'])")


def split_long(text: str, max_chars: int) -> list[str]:
    """Split text over max_chars at sentence ends, and at spaces only when a
    single sentence is itself too long."""
    if len(text) <= max_chars:
        return [text]
    pieces: list[str] = []
    for sentence in _SENTENCE_END.split(text.strip()):
        while len(sentence) > max_chars:
            cut = sentence.rfind(" ", 0, max_chars)
            cut = cut if cut > max_chars // 2 else max_chars
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        pieces.append(sentence)
    out: list[str] = []
    for p in pieces:
        if out and len(out[-1]) + 1 + len(p) <= max_chars:
            out[-1] += " " + p
        elif p:
            out.append(p)
    return out
