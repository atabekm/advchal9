"""Check that each quote really is in the chunk it cites.

Both texts are normalized (PDF hyphenation, invisible characters, quote marks, dashes, case,
whitespace), then fuzzy-matched: `partial_ratio` is the best similarity of the quote against
any span of the chunk with the quote's length, 0..100. A copied quote scores ~100 even with small
extraction differences; a paraphrase scores far lower (~60–80).

One gap is allowed: PDF chunks can have a page break inside a sentence (a footnote and the
running header spliced in). If the whole quote does not match, it may still match as a head and
a tail, each at least MIN_PART words, in that order; the score is the weaker of the two.
"""

from __future__ import annotations

import re
import unicodedata

from rapidfuzz import fuzz

from .cited import Quote
from .retrieve import Hit

MIN_SCORE = 90.0
MIN_PART = 4  # words on each side of a gap

_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿­"))
_CHARS = str.maketrans({"‘": "'", "’": "'", "‚": "'", "′": "'", "“": '"', "”": '"', "„": '"', "″": '"',
                        "–": "-", "—": "-", "−": "-", "‐": "-", "‑": "-", "•": " ", "…": "..."})
_HYPHEN_BREAK = re.compile(r"(\w)-\s*\n\s*(\w)")  # "transcri-\nbed" → "transcribed"
_SPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_INVISIBLE)
    text = _HYPHEN_BREAK.sub(r"\1\2", text).translate(_CHARS)
    return _SPACE.sub(" ", text).strip().lower()


def match(quote: str, chunk: str) -> float:
    """How well the quote matches some span of the chunk, 0..100."""
    q, c = normalize(quote).strip(" \"'"), normalize(chunk)
    if not q:
        return 0.0
    if q in c:
        return 100.0
    whole = fuzz.partial_ratio(q, c)
    return round(max(whole, _split_match(q, c)) if whole < MIN_SCORE else whole, 1)


def _split_match(q: str, c: str) -> float:
    """The best head + tail match with a gap in the chunk between them."""
    words = q.split()
    best = 0.0
    for i in range(MIN_PART, len(words) - MIN_PART + 1):
        head, tail = " ".join(words[:i]), " ".join(words[i:])
        h = fuzz.partial_ratio_alignment(head, c)
        if h is None or h.score < MIN_SCORE:
            continue
        t = fuzz.partial_ratio(tail, c[h.dest_end:])
        best = max(best, min(h.score, t))
    return best


def verify(quotes: list[Quote], hits: list[Hit], min_score: float = MIN_SCORE) -> tuple[list[Quote], list[Quote]]:
    """Score every quote against its chunk: (verified, failed), each quote with its score set."""
    by_rank = {h.rank: h for h in hits}
    verified, failed = [], []
    for q in quotes:
        hit = by_rank.get(q.ref)
        q.score = match(q.text, hit.text) if hit else 0.0
        (verified if q.score >= min_score else failed).append(q)
    return verified, failed
