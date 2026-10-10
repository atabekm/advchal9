"""Summaries of the saved runs: one row per variant, and per-question detail for two variants."""

from __future__ import annotations

import json
import statistics
from pathlib import Path

from .bench import RESULTS
from .variants import VARIANTS


def load_all(results: Path = RESULTS) -> list[dict]:
    order = {v.name: i for i, v in enumerate(VARIANTS)}
    runs = [json.loads(p.read_text()) for p in results.glob("*.json")]
    return sorted(runs, key=lambda r: order.get(r["variant"], 99))


def summary(run: dict) -> dict:
    recs = run["records"]
    # speed from the first pass only: on a repeat, llama-server's prompt cache skips the prefill
    first = [r for r in recs if r["rep"] == 0]
    answerable = [r for r in recs if r["kind"] not in ("unanswerable", "ambiguous")]
    refusable = [r for r in recs if r["kind"] in ("unanswerable", "ambiguous")]
    quotes = sum(r["quotes_total"] for r in answerable if r["status"] == "answer")
    mean = lambda xs: statistics.fmean(xs) if xs else 0.0
    return {
        "variant": run["variant"], "note": run["note"], "model": run["model"],
        "correct": mean([r["correct"] for r in recs]),
        "score": mean([r["score"] for r in recs]),
        "format": mean([r["format_ok"] for r in recs]),
        "facts": mean([r["facts"] for r in answerable]),
        "answered": mean([r["status"] == "answer" for r in answerable]),
        "quotes": sum(r["quotes_ok"] for r in answerable) / quotes if quotes else 0.0,
        "idk": mean([r["status"] == "unknown" for r in refusable]),
        "truncated": sum(r["done_reason"] == "length" for r in recs),
        "wall": statistics.median(r["wall_s"] for r in first),
        "wall_total": sum(r["wall_s"] for r in first),
        "out_tok": statistics.median(r["completion_tokens"] for r in recs),
        "gen_tps": mean([r["completion_tokens"] / r["eval_s"] for r in first if r["eval_s"]]),
        "prefill_tps": mean([r["prompt_tokens"] / r["prompt_s"] for r in first if r["prompt_s"]]),
        "ttft": statistics.median(r["load_s"] + r["prompt_s"] for r in first[1:] or first),
        "cold_load": run["cold_load_s"] or 0.0,
        "mem_gb": run["memory"]["size_mb"] / 1024,
        "ctx": run["memory"]["context_length"],
        "repeats": run["repeats"],
    }


def table(runs: list[dict]) -> str:
    head = ("| variant | change | correct | score | valid JSON | facts | quotes ✓ | IDK right | "
            "median s | out tok | gen tok/s | prefill tok/s | load s | memory GB | ctx |")
    rows = [head, "|" + "|".join(["---"] * (head.count("|") - 1)) + "|"]
    for run in runs:
        s = summary(run)
        rows.append(f"| {s['variant']} | {s['note']} | {s['correct']:.0%} | {s['score']:.2f} | {s['format']:.0%} | "
                    f"{s['facts']:.0%} | {s['quotes']:.0%} | {s['idk']:.0%} | {s['wall']:.1f} | {s['out_tok']:.0f} | "
                    f"{s['gen_tps']:.1f} | {s['prefill_tps']:.0f} | {s['cold_load']:.1f} | {s['mem_gb']:.1f} | {s['ctx'] or '?'} |")
    return "\n".join(rows)


def per_question(runs: list[dict]) -> str:
    """Correct (✓), wrong (✗) or invalid (!) per question; with repeats, the share correct."""
    ids = list(dict.fromkeys(r["id"] for run in runs for r in run["records"]))
    head = "| q | " + " | ".join(run["variant"] for run in runs) + " |"
    rows = [head, "|" + "|".join(["---"] * (len(runs) + 1)) + "|"]
    for qid in ids:
        cells = []
        for run in runs:
            recs = [r for r in run["records"] if r["id"] == qid]
            if not recs:
                cells.append("")
            elif len(recs) == 1:
                r = recs[0]
                cells.append("✓" if r["correct"] else ("✗" if r["format_ok"] else "!"))
            else:
                cells.append(f"{sum(r['correct'] for r in recs)}/{len(recs)}")
        rows.append(f"| {qid} | " + " | ".join(cells) + " |")
    return "\n".join(rows)
