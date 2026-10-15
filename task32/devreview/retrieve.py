"""A query → the passages of the index that bear on it. From task 31, with two filters added.

1. **Scope.** The caller says which task folders to search (a changed file's task plus the
   repository docs); empty means everywhere. `kind` keeps only documentation or only code, so the
   reviewer gets some of each instead of whichever happens to score higher. `exclude` drops the
   changed files themselves: their new version is already in the prompt.
2. **Candidates**: cosine top `wide` (nomic-embed-text) and BM25 top `wide` over the scope,
   merged by reciprocal rank fusion.
3. **Rerank** with the cross-encoder; the best `k` are returned.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from .embed import Embedder
from .index import DEFAULT_DB
from .lexical import BM25
from .rerank import Reranker
from .store import Store

WIDE = 20
K = 3
RRF_K = 60
RERANK_CHARS = 1500  # the cross-encoder reads 512 tokens; a longer query only crowds out the passage


class IndexMissing(RuntimeError):
    pass


@dataclass(frozen=True)
class Hit:
    chunk_id: str
    source: str
    task: str
    section: str
    kind: str  # doc | code
    line_start: int
    line_end: int
    text: str
    score: float  # cosine
    bm25: float = 0.0
    rerank: float | None = None  # cross-encoder relevance, 0..1

    @property
    def label(self) -> str:
        where = f"{self.source}:{self.line_start}-{self.line_end}" if self.line_start else self.source
        return f"{where} › {self.section}" if self.section else where


class Retriever:
    def __init__(self, db: Path = DEFAULT_DB, embedder: Embedder | None = None, reranker: Reranker | None = None):
        if not db.exists():
            raise IndexMissing(f"no index at {db} — run: uv run devreview index")
        self.store = Store(db)
        self.embedder = embedder or Embedder(self.store.meta().get("model", "nomic-embed-text"))
        self.reranker = reranker or Reranker()
        self._bm25: tuple[list, BM25] | None = None

    def search(self, query: str, k: int = K, tasks: Collection[str] = (), kind: str | None = None,
               exclude: Collection[str] = (), wide: int = WIDE, rerank: bool = True) -> list[Hit]:
        rows, mat = self.store.matrix()
        if not rows:
            return []
        if self._bm25 is None or self._bm25[0] is not rows:
            self._bm25 = (rows, BM25([f"{r['source']} {r['section']}\n{r['text']}" for r in rows]))
        allowed = np.array([(not tasks or r["task"] in tasks) and (kind is None or r["kind"] == kind)
                            and _file(r["source"]) not in exclude for r in rows])
        cos = mat @ self.embedder.query(query)
        lex = self._bm25[1].scores(query)
        fused: dict[int, float] = {}
        for scores in (cos, lex):
            ranked = [i for i in np.argsort(-scores) if allowed[i] and scores[i] > 0][:wide]
            for r, i in enumerate(ranked, start=1):
                fused[i] = fused.get(i, 0.0) + 1 / (RRF_K + r)
        order = sorted(fused, key=lambda i: -fused[i])
        hits = [Hit(rows[i]["chunk_id"], rows[i]["source"], rows[i]["task"], rows[i]["section"], rows[i]["kind"],
                    rows[i]["line_start"], rows[i]["line_end"], rows[i]["text"], float(cos[i]), float(lex[i]))
                for i in order]
        if rerank and hits:
            # The reranker reads the label too: "task30/README.md › Settings" is half the meaning.
            scores = self.reranker.scores(query[:RERANK_CHARS], [f"{h.label}\n\n{h.text}" for h in hits])
            hits = [replace(h, rerank=s) for s, h in sorted(zip(scores, hits), key=lambda p: -p[0])]
        return hits[:k]

    def close(self) -> None:
        self.store.close()


def _file(source: str) -> str:
    return source.split("#", 1)[0]  # "task25/rag/store.py#schema" is about task25/rag/store.py
