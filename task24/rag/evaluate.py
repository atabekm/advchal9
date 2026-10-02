"""Run the control questions in every mode, score them, and write the run to JSON.

A run is plain data (no objects), so `rag eval --rejudge FILE` can grade saved
answers again, and the report can be rebuilt without calling the LLM.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from . import evalset, judge
from .agent import Agent
from .clarify import Clarifier
from .evalset import Question
from .llm import DeepSeek
from .pipeline import Config, Pipeline, Retrieval
from .retrieve import TASK_DIR

RUNS_DIR = TASK_DIR / "eval"


def run(questions: list[Question], pipeline: Pipeline, llm: DeepSeek, modes: list[str], k_before: int, k_after: int,
        workers: int = 6, log=print) -> dict:
    """`modes`: "plain" and/or pipeline modes, in report column order."""
    # Rewrites in parallel (the rewriter caches them, so every rewrite mode uses the same queries),
    # then retrieval on this thread: the SQLite connection must not cross threads.
    if pipeline.rewriter and any(Config.parse(m).rewrites for m in modes if m != "plain"):
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(pipeline.rewriter.rewrite, [q.question for q in questions]))
    retrievals: dict[tuple[str, str], Retrieval] = {
        (q.id, m): pipeline.retrieve(q.question, Config.parse(m, k_before=k_before, k_after=k_after))
        for q in questions for m in modes if m != "plain"
    }
    agent = Agent(llm, clarifier=Clarifier(llm, pipeline.retriever.titles()))
    jobs = [(q, m) for m in modes for q in questions]

    def one(job):
        q, mode = job
        ans = agent.answer(q.question, retrieval=retrievals.get((q.id, mode)))
        log(f"  {q.id} {ans.label:11} {ans.seconds:5.1f}s")
        return q, ans

    started = time.monotonic()
    with ThreadPoolExecutor(workers) as pool:
        done = list(pool.map(one, jobs))

    results = []
    for q, ans in done:
        rag = ans.retrieval is not None
        rc = evalset.retrieval_check(q, ans.hits) if rag else None
        pc = evalset.retrieval_check(q, ans.retrieval.pool) if rag else None
        kw, matched = evalset.keyword_score(q, ans.text)
        results.append({
            "id": q.id, "label": ans.label, "answer": ans.text,
            "keywords": kw, "keywords_matched": matched,
            "retrieval": None if rc is None else {"hit": rc.hit, "recall": rc.recall, "first_rank": rc.first_rank},
            "pool": None if pc is None else {"hit": pc.hit, "first_rank": pc.first_rank, "size": len(ans.retrieval.pool)},
            "cited": [h.rank for h in ans.cited],
            "cited_expected": evalset.cited_expected(q, ans.cited) if rag else None,
            "context": [{"rank": h.rank, "cosine_rank": h.cosine_rank or h.rank, "score": round(h.score, 4),
                         "rerank": None if h.rerank is None else round(h.rerank, 4),
                         "source": h.source, "pages": h.pages, "section": h.section} for h in ans.hits],
            "timings": {**({k: round(v, 3) for k, v in ans.retrieval.timings.items()} if rag else {}),
                        "answer": round(ans.seconds, 2)},
            "queries": ans.retrieval.queries[1:] if rag else [],
            "rewrite_tokens": [ans.retrieval.rewrite.prompt_tokens, ans.retrieval.rewrite.completion_tokens]
                              if rag and ans.retrieval.rewrite else None,
            "early_refusal": ans.early_refusal,
            "prompt_tokens": ans.prompt_tokens, "completion_tokens": ans.completion_tokens,
            "seconds": round(ans.seconds, 2),
        })
    return {
        "created": datetime.now().isoformat(timespec="seconds"),
        "model": llm.model, "k": k_after, "k_before": k_before, "labels": [m if m == "plain" else Config.parse(m).label for m in modes],
        "wall_seconds": round(time.monotonic() - started, 1),
        "results": results,
    }


def grade(data: dict, questions: list[Question], llm: DeepSeek, workers: int = 6, log=print) -> dict:
    by_id = {q.id: q for q in questions}

    def one(r):
        v = judge.judge(llm, by_id[r["id"]], r["answer"])
        log(f"  {r['id']} {r['label']:11} {v.verdict}{' +halluc' if v.hallucination else ''}")
        return v

    with ThreadPoolExecutor(workers) as pool:
        verdicts = list(pool.map(one, data["results"]))
    for r, v in zip(data["results"], verdicts):
        r["judge"] = v.to_dict()
    data["judge_model"] = llm.model
    return data


def save(data: dict, path: Path | None = None) -> Path:
    if path is None:
        RUNS_DIR.mkdir(exist_ok=True)
        path = RUNS_DIR / f"run-{data['created'].replace(':', '').replace('-', '')}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    return path


def load(path: Path) -> dict:
    return json.loads(path.read_text())
