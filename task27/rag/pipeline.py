"""Question → the chunks that go into the prompt. The one place the retrieval modes are defined.

  base        cosine top-k_after (task 22 rag/struct)
  cos-filter  cosine top-k_after, minus chunks more than cos_delta below the best cosine score
  rerank      cosine top-k_before → cross-encoder → top-k_after, minus chunks under threshold
  rewrite     the question and its rewrites each search top-k_before, merged by reciprocal rank
              fusion → top-k_after
  rewrite+rerank   the same merged pool → cross-encoder (best score over the question and its
              rewrites) → top-k_after, minus chunks under threshold

Every mode searches k_before, so the pool (and its recall) is comparable across modes; base
just keeps the first k_after of it in cosine order. A filter may keep nothing: the agent
then refuses without calling the LLM.

`floor` splits the rerank threshold's two jobs. The threshold decides whether the question is
answerable at all: the best chunk must reach it. Once it does, the other chunks of the top k_after
are kept down to the floor. With no floor (task 24) the threshold does both. The chat uses a
floor: a follow-up is phrased more loosely than a control question, and the chunk with the
number often scores just under the best one (0.28 against a 0.3 threshold). The default cutoffs come from `rag calibrate`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .rerank import Reranker
from .rewrite import Rewrite, Rewriter
from .retrieve import DEFAULT_STRATEGY, Hit, Retriever

MODES = ("base", "cos-filter", "rerank", "rewrite", "rewrite+rerank")
DEFAULT_MODE = "rewrite+rerank"
DEFAULT_K_BEFORE = 20
DEFAULT_K_AFTER = 5
# cross-encoder score, 0..1, per mode: the strictest cutoff that loses no hit in `rag calibrate`
# (`--rewrite` for rewrite+rerank, whose scores are the best over several queries, so higher)
DEFAULT_THRESHOLDS = {"rerank": 0.05, "rewrite+rerank": 0.3}
DEFAULT_COS_DELTA = 0.06  # cosine distance from the best hit; from `rag calibrate`


@dataclass(frozen=True)
class Config:
    mode: str = DEFAULT_MODE
    k_before: int = DEFAULT_K_BEFORE
    k_after: int = DEFAULT_K_AFTER
    threshold: float | None = None  # None: the mode's default
    cos_delta: float = DEFAULT_COS_DELTA
    sources: tuple[str, ...] = ()  # search only these documents (the chat's scope); empty = all
    floor: float | None = None  # rerank modes: keep chunks down to this once the best passes the threshold

    def __post_init__(self):
        if self.mode not in MODES:
            raise ValueError(f"unknown mode {self.mode!r}, expected one of {MODES}")
        if self.threshold is None:
            object.__setattr__(self, "threshold", DEFAULT_THRESHOLDS.get(self.mode, 0.0))
        if not 0 < self.k_after <= self.k_before:
            raise ValueError(f"need 0 < k_after ({self.k_after}) <= k_before ({self.k_before})")
        if self.floor is not None and not 0 <= self.floor <= self.threshold:
            raise ValueError(f"need 0 <= floor ({self.floor}) <= threshold ({self.threshold})")
        if not 0 <= self.threshold <= 1 or self.cos_delta < 0:
            raise ValueError(f"need 0 <= threshold ({self.threshold}) <= 1 and cos_delta ({self.cos_delta}) >= 0")

    @classmethod
    def parse(cls, spec: str, **kw) -> Config:
        """"rerank" or "rerank@0.3": a mode, optionally with its own threshold."""
        mode, _, threshold = spec.partition("@")
        return cls(mode, threshold=float(threshold) if threshold else None, **kw)

    @property
    def label(self) -> str:
        default = DEFAULT_THRESHOLDS.get(self.mode, 0.0)
        return self.mode if not self.reranks or self.threshold == default else f"{self.mode}@{self.threshold:g}"

    @property
    def reranks(self) -> bool:
        return self.mode.endswith("rerank")

    @property
    def rewrites(self) -> bool:
        return self.mode.startswith("rewrite")


@dataclass
class Retrieval:
    question: str
    config: Config
    queries: list[str]  # what was searched: the question, then its rewrites
    pool: list[Hit]  # cosine top-k_before (fused over the queries), in that order
    ranked: list[Hit]  # the pool in final order (reranked or not), numbered [1..]
    kept: list[Hit]  # the head of `ranked` that goes into the prompt
    timings: dict[str, float] = field(default_factory=dict)  # stage → seconds
    rewrite: Rewrite | None = None


class Pipeline:
    def __init__(self, retriever: Retriever, reranker: Reranker | None = None, rewriter: Rewriter | None = None):
        self.retriever = retriever
        self.reranker = reranker
        self.rewriter = rewriter

    def retrieve(self, question: str, config: Config) -> Retrieval:
        timings, queries, rewrite = {}, [question], None
        if config.rewrites:
            if self.rewriter is None:
                raise ValueError(f"mode {config.mode!r} needs a rewriter")
            rewrite = self.rewriter.rewrite(question)
            timings["rewrite"] = rewrite.seconds
            queries += [q for q in rewrite.queries if q != question]
        t = time.monotonic()
        scope = {"sources": config.sources} if config.sources else {}
        if len(queries) == 1:
            pool = self.retriever.search(question, DEFAULT_STRATEGY, config.k_before, **scope)
        else:
            pool = self.retriever.search_many(queries, DEFAULT_STRATEGY, config.k_before, **scope)
        timings["search"] = time.monotonic() - t
        if config.reranks:
            if self.reranker is None:
                raise ValueError(f"mode {config.mode!r} needs a reranker")
            self.reranker.encoder  # load the model outside the timing
            t = time.monotonic()
            ranked = self.reranker.rerank(queries, pool)
            timings["rerank"] = time.monotonic() - t
            floor = config.threshold if config.floor is None else config.floor
            passes = bool(ranked) and ranked[0].rerank >= config.threshold
            kept = [h for h in ranked[:config.k_after] if h.rerank >= floor] if passes else []
        else:
            ranked = pool
            kept = ranked[:config.k_after]
            if config.mode == "cos-filter" and pool:
                kept = [h for h in kept if h.score >= pool[0].score - config.cos_delta]
        return Retrieval(question, config, queries, pool, ranked, kept, timings, rewrite)
