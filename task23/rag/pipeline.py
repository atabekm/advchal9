"""Question → the chunks that go into the prompt. The one place the retrieval modes are defined.

  base     cosine top-k_after (task 22 rag/struct)
  rerank   cosine top-k_before → cross-encoder → top-k_after

Every mode searches k_before, so the pool (and its recall) is comparable across modes; base
just keeps the first k_after of it in cosine order.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .rerank import Reranker
from .retrieve import DEFAULT_STRATEGY, Hit, Retriever

MODES = ("base", "rerank")
DEFAULT_MODE = "rerank"
DEFAULT_K_BEFORE = 20
DEFAULT_K_AFTER = 5


@dataclass(frozen=True)
class Config:
    mode: str = DEFAULT_MODE
    k_before: int = DEFAULT_K_BEFORE
    k_after: int = DEFAULT_K_AFTER

    def __post_init__(self):
        if self.mode not in MODES:
            raise ValueError(f"unknown mode {self.mode!r}, expected one of {MODES}")
        if not 0 < self.k_after <= self.k_before:
            raise ValueError(f"need 0 < k_after ({self.k_after}) <= k_before ({self.k_before})")

    @property
    def reranks(self) -> bool:
        return self.mode == "rerank"


@dataclass
class Retrieval:
    question: str
    config: Config
    pool: list[Hit]  # cosine top-k_before, cosine order
    ranked: list[Hit]  # the pool in final order (reranked or not), numbered [1..]
    kept: list[Hit]  # the head of `ranked` that goes into the prompt
    timings: dict[str, float] = field(default_factory=dict)  # stage → seconds


class Pipeline:
    def __init__(self, retriever: Retriever, reranker: Reranker | None = None):
        self.retriever = retriever
        self.reranker = reranker

    def retrieve(self, question: str, config: Config) -> Retrieval:
        timings = {}
        t = time.monotonic()
        pool = self.retriever.search(question, DEFAULT_STRATEGY, config.k_before)
        timings["search"] = time.monotonic() - t
        if config.reranks:
            if self.reranker is None:
                raise ValueError(f"mode {config.mode!r} needs a reranker")
            self.reranker.encoder  # load the model outside the timing
            t = time.monotonic()
            ranked = self.reranker.rerank(question, pool)
            timings["rerank"] = time.monotonic() - t
        else:
            ranked = pool
        return Retrieval(question, config, pool, ranked, ranked[:config.k_after], timings)
