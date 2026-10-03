"""Run the control questions in every mode, score them, and write the run to JSON.

A mode is a retrieval mode ("rewrite+rerank"), optionally with the answer style in front:
"legacy:rewrite+rerank" answers with task 23's free-text prompt from the same retrieval.

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
from .verify import MIN_SCORE
from .retrieve import TASK_DIR

RUNS_DIR = TASK_DIR / "eval"
LEGACY = "legacy:"


def split_mode(spec: str) -> tuple[str, str]:
    """"legacy:rerank@0.3" → ("legacy", "rerank@0.3"); "rerank" → ("cited", "rerank")."""
    return ("legacy", spec[len(LEGACY):]) if spec.startswith(LEGACY) else ("cited", spec)


def mode_label(spec: str) -> str:
    style, mode = split_mode(spec)
    label = mode if mode == "plain" else Config.parse(mode).label
    return f"{LEGACY}{label}" if style == "legacy" else label


def run(questions: list[Question], pipeline: Pipeline, llm: DeepSeek, modes: list[str], k_before: int, k_after: int,
        workers: int = 6, log=print) -> dict:
    """`modes`: "plain" and/or pipeline modes, each optionally "legacy:…", in report column order.
    Both answer styles over the same retrieval mode share one retrieval, so they see the same chunks."""
    retrieval_modes = list(dict.fromkeys(split_mode(m)[1] for m in modes if split_mode(m)[1] != "plain"))
    # Rewrites in parallel (the rewriter caches them, so every rewrite mode uses the same queries),
    # then retrieval on this thread: the SQLite connection must not cross threads.
    if pipeline.rewriter and any(Config.parse(m).rewrites for m in retrieval_modes):
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(pipeline.rewriter.rewrite, [q.question for q in questions]))
    retrievals: dict[tuple[str, str], Retrieval] = {
        (q.id, m): pipeline.retrieve(q.question, Config.parse(m, k_before=k_before, k_after=k_after))
        for q in questions for m in retrieval_modes
    }
    clarifier = Clarifier(llm, pipeline.retriever.titles())
    agents = {style: Agent(llm, style=style, clarifier=clarifier) for style in ("cited", "legacy")}
    jobs = [(q, m) for m in modes for q in questions]

    def one(job):
        q, spec = job
        style, mode = split_mode(spec)
        ans = agents[style].answer(q.question, retrieval=retrievals.get((q.id, mode)))
        log(f"  {q.id} {ans.label:22} {ans.status:7} {ans.seconds:5.1f}s")
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
            "style": ans.style, "status": ans.status, "clarification": ans.clarification,
            "sources": [{"ref": h.rank, "source": h.source, "section": h.section, "pages": h.pages,
                         "chunk_id": h.chunk_id} for h in ans.cited],
            "quotes": [{"ref": x.ref, "quote": x.text, "match": x.score} for x in ans.quotes],
            "failed_quotes": [{"ref": x.ref, "quote": x.text, "match": x.score} for x in ans.failed_quotes],
            "attempts": ans.attempts, "format_error": ans.format_error or None,
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
        "model": llm.model, "k": k_after, "k_before": k_before, "min_match": MIN_SCORE,
        "labels": [mode_label(m) for m in modes],
        "wall_seconds": round(time.monotonic() - started, 1),
        "results": results,
    }


def grade(data: dict, questions: list[Question], llm: DeepSeek, workers: int = 6, log=print) -> dict:
    by_id = {q.id: q for q in questions}

    def one(r):
        v = judge.judge(llm, by_id[r["id"]], r["answer"])
        f = None
        if r.get("status") == "answer" and r.get("quotes"):  # the answer means what its quotes say
            f = judge.faithfulness(llm, by_id[r["id"]].question, r["answer"], r["quotes"])
        log(f"  {r['id']} {r['label']:22} {v.verdict}{' +halluc' if v.hallucination else ''}"
            + (f"  faithful: {f.verdict}" if f else ""))
        return v, f

    with ThreadPoolExecutor(workers) as pool:
        verdicts = list(pool.map(one, data["results"]))
    for r, (v, f) in zip(data["results"], verdicts):
        r["judge"] = v.to_dict()
        r["faithful"] = f.to_dict() if f else None
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
