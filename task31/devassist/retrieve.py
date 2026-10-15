"""Question → the passages of the index that answer it.

1. **Scope.** A question that names tasks ("task 30", "task30/", "tasks 21 and 23", "day 27")
   searches only those task folders and the repository-level docs. Thirty READMEs share most of
   their vocabulary; the task number is the one thing that tells them apart.
2. **Candidates**: cosine top `wide` (nomic-embed-text) and BM25 top `wide` over the scope,
   merged by reciprocal rank fusion.
3. **Rerank** with the cross-encoder; the best `k` are returned, renumbered [1]..[k].
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from .embed import Embedder
from .index import DEFAULT_DB
from .lexical import BM25
from .rerank import Reranker
from .store import Store

WIDE = 20
K = 6
RRF_K = 60
_NUM = r"(\d{1,2})"
TASK_MENTION = re.compile(
    rf"\b(?:tasks?|days?|задач[аиуе]?|день|дня)[\s#-]*{_NUM}((?:\s*(?:,|and|и|or|&|-|–)\s*{_NUM})*)", re.I)
TASK_DIR_MENTION = re.compile(r"\btask(\d{1,2})\b")


class IndexMissing(RuntimeError):
    pass


@dataclass(frozen=True)
class Hit:
    rank: int
    chunk_id: str
    source: str
    task: str
    section: str
    text: str
    score: float  # cosine
    bm25: float = 0.0
    rerank: float | None = None  # cross-encoder relevance, 0..1

    @property
    def label(self) -> str:
        return f"{self.source} › {self.section}" if self.section else self.source


def tasks_in(question: str) -> set[str]:
    """{"task30", ...} for every task the question names, by number or by folder."""
    found = {f"task{int(n)}" for n in TASK_DIR_MENTION.findall(question)}
    for m in TASK_MENTION.finditer(question):
        nums = [int(m.group(1))]
        for sep, n in re.findall(r"(,|and|и|or|&|-|–)\s*(\d{1,2})", m.group(2) or ""):
            if sep in "-–" and int(n) > nums[-1]:  # "tasks 16-20"
                nums.extend(range(nums[-1] + 1, int(n) + 1))
            else:
                nums.append(int(n))
        found |= {f"task{n}" for n in nums}
    return found


class Retriever:
    def __init__(self, db: Path = DEFAULT_DB, embedder: Embedder | None = None, reranker: Reranker | None = None):
        if not db.exists():
            raise IndexMissing(f"no index at {db} — run: uv run devassist index")
        self.store = Store(db)
        self.embedder = embedder or Embedder(self.store.meta().get("model", "nomic-embed-text"))
        self.reranker = reranker or Reranker()
        self._bm25: tuple[list, BM25] | None = None

    def search(self, question: str, k: int = K, wide: int = WIDE, rerank: bool = True) -> list[Hit]:
        tasks = tasks_in(question)
        scope = tasks | {""} if tasks else set()
        rows, mat = self.store.matrix()
        if not rows:
            return []
        if self._bm25 is None or self._bm25[0] is not rows:
            self._bm25 = (rows, BM25([f"{r['source']} {r['section']}\n{r['text']}" for r in rows]))
        allowed = np.array([not scope or r["task"] in scope for r in rows])
        cos = mat @ self.embedder.query(question)
        lex = self._bm25[1].scores(question)
        fused: dict[int, float] = {}
        for scores in (cos, lex):
            ranked = [i for i in np.argsort(-scores) if allowed[i] and scores[i] > 0][:wide]
            for r, i in enumerate(ranked, start=1):
                fused[i] = fused.get(i, 0.0) + 1 / (RRF_K + r)
        order = sorted(fused, key=lambda i: -fused[i])
        hits = [Hit(0, rows[i]["chunk_id"], rows[i]["source"], rows[i]["task"], rows[i]["section"], rows[i]["text"],
                    float(cos[i]), float(lex[i])) for i in order]
        if rerank and hits:
            # The reranker reads the label too: "task30/README.md › Settings" is half the meaning.
            scores = self.reranker.scores(question, [f"{h.label}\n\n{h.text}" for h in hits])
            hits = [replace(h, rerank=s) for s, h in sorted(zip(scores, hits), key=lambda p: -p[0])]
        return [replace(h, rank=i) for i, h in enumerate(hits[:k], start=1)]

    def close(self) -> None:
        self.store.close()
