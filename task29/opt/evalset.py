"""The control questions and the checks that need no LLM: keywords and retrieval hits."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .hits import TASK_DIR, Hit

DEFAULT_QUESTIONS = TASK_DIR / "questions.json"
KINDS = ("fact", "explain", "multi", "unanswerable", "ambiguous")
NO_ANSWER = ("unanswerable", "ambiguous")  # the right reply is "I don't know" and a clarifying question


@dataclass(frozen=True)
class Source:
    source: str  # file name as stored in the index
    pages: tuple[int, ...]  # empty = anywhere in the document

    def matches(self, hit: Hit) -> bool:
        if hit.source != self.source:
            return False
        return not self.pages or any(hit.page_start <= p <= hit.page_end for p in self.pages)


@dataclass(frozen=True)
class Question:
    id: str
    kind: str
    question: str
    expect: str
    must_contain: tuple[tuple[str, ...], ...]  # every group must match, any alternative inside it
    sources: tuple[Source, ...]  # empty = the corpus does not answer it

    @property
    def answerable(self) -> bool:
        return bool(self.sources)


def load(path: Path = DEFAULT_QUESTIONS) -> list[Question]:
    out = []
    for q in json.loads(path.read_text()):
        if q["kind"] not in KINDS:
            raise ValueError(f"{q['id']}: unknown kind {q['kind']!r}")
        if (q["kind"] in NO_ANSWER) != (not q["sources"]):
            raise ValueError(f"{q['id']}: only unanswerable and ambiguous questions have no sources")
        out.append(Question(
            id=q["id"], kind=q["kind"], question=q["question"], expect=q["expect"],
            must_contain=tuple(tuple(g) for g in q["must_contain"]),
            sources=tuple(Source(s["source"], tuple(s.get("pages", []))) for s in q["sources"]),
        ))
    ids = [q.id for q in out]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate question ids")
    return out


def _norm(text: str) -> str:
    # "1,850" and "1850" should match either way; curly apostrophes as straight ones.
    text = text.lower().replace("’", "'")
    return re.sub(r"(?<=\d),(?=\d{3})", "", text)


def keyword_score(q: Question, answer: str) -> tuple[float, list[bool]]:
    """Fraction of must_contain groups matched, and which ones."""
    text = _norm(answer)
    matched = [any(_norm(alt) in text for alt in group) for group in q.must_contain]
    return (sum(matched) / len(matched) if matched else 1.0), matched


@dataclass(frozen=True)
class RetrievalCheck:
    found: tuple[bool, ...]  # per expected source
    first_rank: int | None  # rank of the first chunk from any expected source

    @property
    def hit(self) -> bool:
        """Every expected source was retrieved (for multi-source questions, all of them)."""
        return bool(self.found) and all(self.found)

    @property
    def recall(self) -> float:
        return sum(self.found) / len(self.found) if self.found else 0.0


def retrieval_check(q: Question, hits: list[Hit]) -> RetrievalCheck | None:
    """None for unanswerable questions: there is nothing to find."""
    if not q.answerable:
        return None
    found = tuple(any(s.matches(h) for h in hits) for s in q.sources)
    ranks = [h.rank for h in hits if any(s.matches(h) for s in q.sources)]
    return RetrievalCheck(found, min(ranks) if ranks else None)


def cited_expected(q: Question, cited: list[Hit]) -> bool | None:
    """Whether the cited chunks include an expected source. None when not applicable."""
    if not q.answerable:
        return None
    return any(s.matches(h) for s in q.sources for h in cited)
