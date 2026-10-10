"""A retrieved chunk, as task 27's retriever returns it and as the frozen contexts store it."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Hit:
    rank: int  # 1-based, the [n] the prompt and the citations use
    score: float  # cosine similarity
    chunk_id: str
    source: str
    title: str
    section: str
    page_start: int
    page_end: int
    text: str
    cosine_rank: int = 0  # rank in the cosine order, set when a reranker reorders the hits
    rerank: float | None = None  # cross-encoder relevance, 0..1

    @property
    def pages(self) -> str:
        return f"p. {self.page_start}" if self.page_start == self.page_end else f"pp. {self.page_start}–{self.page_end}"

    def to_dict(self) -> dict:
        return asdict(self)
