"""Question → the top-k chunks of the task 21 index by cosine similarity, with their metadata."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from indexer import embed as embed_mod
from indexer.embed import Embedder
from indexer.store import Store

TASK_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = TASK_DIR / "index" / "index.db"
STRATEGIES = ("struct", "fixed")
DEFAULT_STRATEGY = "struct"
DEFAULT_K = 5


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


class IndexMissing(RuntimeError):
    pass


class Retriever:
    """Holds the store and the embedder so a chat session embeds against one open index."""

    def __init__(self, db: Path = DEFAULT_DB, embedder: Embedder | None = None):
        if not db.exists():
            raise IndexMissing(f"no index at {db} — run: uv run indexer index")
        self.store = Store(db)
        self.embedder = embedder or Embedder(self.store.meta().get("model", embed_mod.MODEL))

    def search(self, question: str, strategy: str = DEFAULT_STRATEGY, k: int = DEFAULT_K) -> list[Hit]:
        if strategy not in STRATEGIES:
            raise ValueError(f"unknown strategy {strategy!r}, expected one of {STRATEGIES}")
        vec = self.embedder.query(question)
        return [
            Hit(rank=i, score=score, chunk_id=row["chunk_id"], source=row["source"], title=row["title"],
                section=row["section"] or "", page_start=row["page_start"], page_end=row["page_end"], text=row["text"])
            for i, (score, row) in enumerate(self.store.search(strategy, vec, k), start=1)
        ]

    def close(self) -> None:
        self.store.close()
