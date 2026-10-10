"""Retrieve once per question and save the chunks, so every variant answers from the same passages.

Retrieval is task 27's `rerank` mode without its gate: cosine top 20 over the `struct` chunks
(nomic-embed-text in Ollama), the bge cross-encoder reorders them, the top 5 go into the
prompt. There's no LLM query rewrite, so the contexts don't depend on the model being tested.
Every question reaches the answer step, the unanswerable ones too: the model itself has to say
"I don't know", which is part of what is measured.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np

from .embed import Embedder
from .evalset import Question, retrieval_check
from .hits import TASK_DIR, Hit
from .rerank import Reranker

DEFAULT_DB = TASK_DIR / "index" / "index.db"
DEFAULT_CONTEXTS = TASK_DIR / "contexts.json"
K_BEFORE = 20
K_AFTER = 5


def search(db: sqlite3.Connection, vec: np.ndarray, k: int) -> list[Hit]:
    rows = db.execute("SELECT * FROM chunks WHERE strategy = 'struct' ORDER BY source, ordinal").fetchall()
    mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    scores = mat @ vec
    return [Hit(rank=i, score=float(scores[j]), chunk_id=rows[j]["chunk_id"], source=rows[j]["source"],
                title=rows[j]["title"], section=rows[j]["section"] or "", page_start=rows[j]["page_start"],
                page_end=rows[j]["page_end"], text=rows[j]["text"])
            for i, j in enumerate(np.argsort(-scores)[:k], start=1)]


class Retriever:
    """Question → the top K_AFTER chunks: cosine top K_BEFORE, reordered by the cross-encoder."""

    def __init__(self, db_path: Path = DEFAULT_DB):
        if not db_path.exists():
            raise SystemExit(f"no index at {db_path}: cp ../task27/index/index.db index/")
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        model = dict(self.db.execute("SELECT key, value FROM meta").fetchall()).get("model", "nomic-embed-text")
        self.embedder, self.reranker = Embedder(model), Reranker()

    def __call__(self, question: str) -> list[Hit]:
        pool = search(self.db, self.embedder.query(question), K_BEFORE)
        return self.reranker.rerank(question, pool)[:K_AFTER]


def freeze(questions: list[Question], db_path: Path = DEFAULT_DB, out: Path = DEFAULT_CONTEXTS) -> list[dict]:
    retrieve = Retriever(db_path)
    frozen = []
    for q in questions:
        kept = retrieve(q.question)
        check = retrieval_check(q, kept)
        frozen.append({"id": q.id, "question": q.question, "hits": [h.to_dict() for h in kept],
                       "retrieved": None if check is None else check.hit})
    out.write_text(json.dumps(frozen, ensure_ascii=False, indent=1))
    return frozen


def load(path: Path = DEFAULT_CONTEXTS) -> dict[str, list[Hit]]:
    """The passages per question. A question whose answer wasn't retrieved is left out: no model
    can answer it from these passages, and retrieval isn't what is being compared."""
    if not path.exists():
        raise SystemExit(f"no {path.name}: run `uv run bench freeze` first")
    return {c["id"]: [Hit(**h) for h in c["hits"]] for c in json.loads(path.read_text()) if c["retrieved"] is not False}
