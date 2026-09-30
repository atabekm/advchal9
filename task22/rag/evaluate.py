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
from .evalset import Question
from .llm import DeepSeek
from .retrieve import TASK_DIR, Hit, Retriever

RUNS_DIR = TASK_DIR / "eval"


def labels(strategies: list[str]) -> list[str]:
    return ["plain", *(f"rag/{s}" for s in strategies)]


def run(questions: list[Question], retriever: Retriever, llm: DeepSeek, strategies: list[str], k: int,
        workers: int = 6, log=print) -> dict:
    # Retrieval first, on this thread: the SQLite connection must not cross threads.
    hits: dict[tuple[str, str], list[Hit]] = {
        (q.id, s): retriever.search(q.question, s, k) for q in questions for s in strategies
    }
    agent = Agent(llm)
    jobs = [(q, "plain", None) for q in questions] + [(q, "rag", s) for q in questions for s in strategies]

    def one(job):
        q, mode, strategy = job
        ans = agent.answer(q.question, mode, strategy, k, hits=hits.get((q.id, strategy)))
        log(f"  {q.id} {ans.label:11} {ans.seconds:5.1f}s")
        return q, ans

    started = time.monotonic()
    with ThreadPoolExecutor(workers) as pool:
        done = list(pool.map(one, jobs))

    results = []
    for q, ans in done:
        rc = evalset.retrieval_check(q, ans.hits) if ans.mode == "rag" else None
        kw, matched = evalset.keyword_score(q, ans.text)
        results.append({
            "id": q.id, "label": ans.label, "answer": ans.text,
            "keywords": kw, "keywords_matched": matched,
            "retrieval": None if rc is None else {"hit": rc.hit, "recall": rc.recall, "first_rank": rc.first_rank},
            "cited": [h.rank for h in ans.cited],
            "cited_expected": evalset.cited_expected(q, ans.cited) if ans.mode == "rag" else None,
            "context": [{"rank": h.rank, "score": round(h.score, 4), "source": h.source, "pages": h.pages,
                         "section": h.section} for h in ans.hits],
            "prompt_tokens": ans.prompt_tokens, "completion_tokens": ans.completion_tokens,
            "seconds": round(ans.seconds, 2),
        })
    return {
        "created": datetime.now().isoformat(timespec="seconds"),
        "model": llm.model, "k": k, "strategies": strategies, "labels": labels(strategies),
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
