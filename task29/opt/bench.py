"""Run one variant over the frozen contexts and save every reply with its scores and timings.

Each variant starts cold: every model on the server is unloaded first, so the first request
pays the load (reported separately) and the memory figures belong to this variant alone.
A variant sampling at temperature > 0 runs `repeats` times; a greedy one (temperature 0) once.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

import requests

from . import prompts
from .evalset import Question
from .hits import TASK_DIR, Hit
from .ollama import DEFAULT_HOST, Ollama
from .score import score
from .variants import Variant

RESULTS = TASK_DIR / "results"


def greedy(v: Variant) -> bool:
    return v.options.get("temperature", 0.6 if not v.system_in_modelfile else 0) == 0


def run(v: Variant, questions: list[Question], contexts: dict[str, list[Hit]], repeats: int = 3,
        out_dir: Path = RESULTS, log=print) -> Path:
    client = Ollama(v.host)
    for host in dict.fromkeys([DEFAULT_HOST, v.host]):
        try:
            Ollama(host).unload_all()
        except requests.RequestException:
            pass  # a server that isn't running holds no memory
    reps = 1 if greedy(v) else repeats
    records, cold_load, ps = [], None, []
    started = time.monotonic()
    for rep in range(reps):
        for q in questions:
            hits = contexts[q.id]
            msgs = prompts.messages(v.template, q.question, hits, with_system=not v.system_in_modelfile)
            reply = client.chat(v.model, msgs, options=v.options, think=v.think, format=v.format)
            if cold_load is None:
                cold_load = reply.load_s
                ps = client.ps()
            s = score(q, reply.text, hits)
            records.append({"id": q.id, "kind": q.kind, "rep": rep, **s.to_dict(),
                            "raw": reply.text, "thinking_chars": len(reply.thinking),
                            "prompt_tokens": reply.prompt_tokens, "completion_tokens": reply.completion_tokens,
                            "load_s": reply.load_s, "prompt_s": reply.prompt_s, "eval_s": reply.eval_s,
                            "wall_s": reply.wall_s, "done_reason": reply.done_reason})
            mark = "✓" if s.correct else ("✗" if s.format_ok else "!")
            log(f"  {v.name} r{rep} {q.id} {mark} score {s.score:.2f}  {reply.completion_tokens:>5} tok "
                f"{reply.wall_s:6.1f}s {reply.done_reason}{'  ' + s.format_error if s.format_error else ''}")
    loaded = next((m for m in ps if m.get("name", "").startswith(v.model) or m.get("model") == v.model), {})
    result = {
        "variant": v.name, "group": v.group, "note": v.note, "model": v.model, "template": v.template,
        "think": v.think, "format": v.format_label, "options": v.options, "host": v.host,
        "ollama": client.version(), "at": datetime.now().isoformat(timespec="seconds"),
        "repeats": reps, "total_s": time.monotonic() - started, "cold_load_s": cold_load,
        "memory": {"size_mb": loaded.get("size", 0) / 2**20, "vram_mb": loaded.get("size_vram", 0) / 2**20,
                   "context_length": loaded.get("context_length")},
        "records": records,
    }
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"{v.name}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    return path


def rescore(path: Path, questions: list[Question], contexts: dict[str, list[Hit]]) -> None:
    """Score the saved replies again: a fix to the eval set or the scorer applies without rerunning the model."""
    result = json.loads(path.read_text())
    by_id = {q.id: q for q in questions if q.id in contexts}
    result["records"] = [rec for rec in result["records"] if rec["id"] in by_id]  # a dropped question goes
    for rec in result["records"]:
        rec.update(score(by_id[rec["id"]], rec["raw"], contexts[rec["id"]]).to_dict())
    path.write_text(json.dumps(result, ensure_ascii=False, indent=1))
