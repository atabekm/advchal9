"""Pick the cutoffs from data: score every pooled chunk, label it relevant or not, sweep.

A chunk is relevant when it matches an expected source of its question (page overlap, as
in the retrieval check). For each cutoff the sweep counts what the filter keeps: answerable
questions that still have their hit in the top k_after, and unanswerable questions left
with an empty context (refused before the LLM is called).
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from . import evalset
from .evalset import Question
from .pipeline import Config, Pipeline
from .retrieve import Hit

RERANK_THRESHOLDS = (0.0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9)
COSINE_DELTAS = (0.20, 0.15, 0.10, 0.08, 0.06, 0.04, 0.02)


@dataclass
class Scored:
    question: Question
    ranked: list[Hit]  # the whole pool, reranked; each hit keeps its cosine rank and score

    @property
    def cosine(self) -> list[Hit]:
        """The pool in cosine order, numbered by cosine rank."""
        return [replace(h, rank=h.cosine_rank) for h in sorted(self.ranked, key=lambda h: h.cosine_rank)]

    def relevant(self, h: Hit) -> bool:
        return any(s.matches(h) for s in self.question.sources)


@dataclass(frozen=True)
class Row:
    cutoff: float
    hits: int  # answerable questions whose expected sources are all in what is kept
    answerable_emptied: int  # answerable questions left with nothing (bad)
    unanswerable_emptied: int  # unanswerable questions left with nothing (good)
    relevant_kept: int
    irrelevant_kept: int
    mean_kept: float


def collect(questions: list[Question], pipeline: Pipeline, k_before: int) -> list[Scored]:
    config = Config("rerank", k_before, k_before, threshold=0.0)
    return [Scored(q, pipeline.retrieve(q.question, config).ranked) for q in questions]


def _row(cutoff: float, scored: list[Scored], kept: list[list[Hit]]) -> Row:
    hits = a_empty = u_empty = rel = irr = 0
    for s, k in zip(scored, kept):
        q = s.question
        if q.answerable:
            hits += evalset.retrieval_check(q, k).hit
            a_empty += not k
        else:
            u_empty += not k
        rel += sum(s.relevant(h) for h in k)
        irr += sum(not s.relevant(h) for h in k)
    return Row(cutoff, hits, a_empty, u_empty, rel, irr, sum(map(len, kept)) / len(kept) if kept else 0.0)


def rerank_sweep(scored: list[Scored], k_after: int, thresholds=RERANK_THRESHOLDS) -> list[Row]:
    return [_row(t, scored, [[h for h in s.ranked[:k_after] if h.rerank >= t] for s in scored]) for t in thresholds]


def cosine_sweep(scored: list[Scored], k_after: int, deltas=COSINE_DELTAS) -> list[Row]:
    rows = []
    for d in deltas:
        kept = []
        for s in scored:
            pool = s.cosine
            kept.append([h for h in pool[:k_after] if pool and h.score >= pool[0].score - d])
        rows.append(_row(d, scored, kept))
    return rows


def suggest(rows: list[Row]) -> Row:
    """The strictest cutoff that loses no hit compared with no filtering (rows[0] is the loosest);
    among those, the one that empties the most unanswerable questions."""
    best_hits = max(r.hits for r in rows)
    ok = [r for r in rows if r.hits == best_hits and r.answerable_emptied == 0]
    return max(ok, key=lambda r: (r.unanswerable_emptied, -r.irrelevant_kept))


def per_question(s: Scored) -> dict:
    """Best relevant and best irrelevant chunk, by rerank score and by cosine."""
    rel = [h for h in s.ranked if s.relevant(h)]
    irr = [h for h in s.ranked if not s.relevant(h)]
    return {
        "rel_rerank": max((h.rerank for h in rel), default=None),
        "rel_rank": min((h.rank for h in rel), default=None),
        "irr_rerank": max((h.rerank for h in irr), default=None),
        "top_cos": max(h.score for h in s.ranked) if s.ranked else None,
        "rel_cos": max((h.score for h in rel), default=None),
        "irr_cos": max((h.score for h in irr), default=None),
    }
