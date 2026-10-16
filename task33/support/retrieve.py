"""Search query → the knowledge-base passages that answer it (task 31's retrieval, unscoped).

1. **Candidates**: cosine top `wide` (nomic-embed-text) and BM25 top `wide`, merged by
   reciprocal rank fusion.
2. **Rerank** with the cross-encoder against the question (`rerank_query`, by default the
   query itself); the best `k` are returned, numbered [1]..[k].

The query is built by the assistant: the customer's question plus what the ticket says (error
code, subject, app version). See `assistant.search_query`.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from .embed import Embedder
from .index import DEFAULT_DB
from .lexical import BM25
from .rerank import Reranker
from .store import Store

WIDE = 20
K = 5
RRF_K = 60


class IndexMissing(RuntimeError):
    pass


@dataclass(frozen=True)
class Hit:
    rank: int
    chunk_id: str
    source: str
    section: str
    text: str
    score: float  # cosine
    bm25: float = 0.0
    rerank: float | None = None  # cross-encoder relevance, 0..1

    @property
    def label(self) -> str:
        return f"{self.source} › {self.section}" if self.section else self.source


class Retriever:
    def __init__(self, db: Path = DEFAULT_DB, embedder: Embedder | None = None, reranker: Reranker | None = None):
        if not db.exists():
            raise IndexMissing(f"no index at {db} — run: uv run support index")
        self.store = Store(db)
        self.embedder = embedder or Embedder(self.store.meta().get("model", "nomic-embed-text"))
        self.reranker = reranker or Reranker()
        self._bm25: tuple[list, BM25] | None = None

    def search(self, query: str, k: int = K, wide: int = WIDE, rerank: bool = True,
               rerank_query: str | None = None) -> list[Hit]:
        rows, mat = self.store.matrix()
        if not rows:
            return []
        if self._bm25 is None or self._bm25[0] is not rows:
            self._bm25 = (rows, BM25([f"{r['source']} {r['section']}\n{r['text']}" for r in rows]))
        cos = mat @ self.embedder.query(query)
        lex = self._bm25[1].scores(query)
        fused: dict[int, float] = {}
        for scores in (cos, lex):
            ranked = [i for i in np.argsort(-scores) if scores[i] > 0][:wide]
            for r, i in enumerate(ranked, start=1):
                fused[i] = fused.get(i, 0.0) + 1 / (RRF_K + r)
        order = sorted(fused, key=lambda i: -fused[i])
        hits = [Hit(0, rows[i]["chunk_id"], rows[i]["source"], rows[i]["section"], rows[i]["text"],
                    float(cos[i]), float(lex[i])) for i in order]
        if rerank and hits:
            scores = self.reranker.scores(rerank_query or query, [f"{h.label}\n\n{h.text}" for h in hits])
            hits = [replace(h, rerank=s) for s, h in sorted(zip(scores, hits), key=lambda p: -p[0])]
        return [replace(h, rank=i) for i, h in enumerate(hits[:k], start=1)]

    def close(self) -> None:
        self.store.close()
