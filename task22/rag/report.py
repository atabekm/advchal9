"""Tables from a graded run: terminal summary and the generated block of EVAL.md."""

from __future__ import annotations

import re
from pathlib import Path
from statistics import mean

from .evalset import Question

START, END = "<!-- eval:start -->", "<!-- eval:end -->"
MARK = {"correct": "✅", "partial": "🟡", "wrong": "❌", "refused": "⛔"}


def _by_label(data: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {label: [] for label in data["labels"]}
    for r in data["results"]:
        out[r["label"]].append(r)
    return out


def _outcome(r: dict, q: Question) -> str:
    """The judge's verdict, with a refusal on an unanswerable question counted as correct."""
    v = r["judge"]["verdict"]
    return "correct" if (not q.answerable and v == "refused") else v


def summary_rows(data: dict, questions: list[Question]) -> list[tuple[str, list[str]]]:
    qs = {q.id: q for q in questions}
    groups = _by_label(data)
    rows: list[tuple[str, list[str]]] = []

    def row(name, fn):
        rows.append((name, [fn(groups[label]) for label in data["labels"]]))

    def count(verdict):
        return lambda rs: str(sum(_outcome(r, qs[r["id"]]) == verdict for r in rs))

    n = len(questions)
    row("judge score (correct 1, partial ½)", lambda rs: f"{sum({'correct': 1, 'partial': .5}.get(_outcome(r, qs[r['id']]), 0) for r in rs):.1f} / {n}")
    for v in ("correct", "partial", "wrong", "refused"):
        row(f"  {v}", count(v))
    row("hallucinations (judge)", lambda rs: str(sum(r["judge"]["hallucination"] for r in rs)))
    row("keyword score (mean)", lambda rs: f"{mean(r['keywords'] for r in rs):.0%}")
    row("keywords all matched", lambda rs: f"{sum(r['keywords'] == 1 for r in rs)} / {n}")

    def rag_only(fn):
        return lambda rs: "—" if rs[0]["label"] == "plain" else fn(rs)

    answerable = [q for q in questions if q.answerable]
    row(f"retrieval hit@{data['k']} (answerable)", rag_only(
        lambda rs: f"{sum(bool(r['retrieval'] and r['retrieval']['hit']) for r in rs)} / {len(answerable)}"))
    row("cites an expected source", rag_only(
        lambda rs: f"{sum(bool(r['cited_expected']) for r in rs)} / {len(answerable)}"))
    row("prompt tokens (mean)", lambda rs: f"{mean(r['prompt_tokens'] for r in rs):,.0f}")
    row("completion tokens (mean)", lambda rs: f"{mean(r['completion_tokens'] for r in rs):,.0f}")
    row("latency (mean)", lambda rs: f"{mean(r['seconds'] for r in rs):.1f}s")
    return rows


def per_question_rows(data: dict, questions: list[Question]) -> list[list[str]]:
    index = {(r["id"], r["label"]): r for r in data["results"]}
    rows = []
    for q in questions:
        cells = [q.id, q.kind]
        for label in data["labels"]:
            r = index[(q.id, label)]
            cell = f"{MARK[_outcome(r, q)]} {r['keywords']:.0%}"
            if r["judge"]["hallucination"]:
                cell += " H"
            if r["retrieval"] is not None:
                rank = r["retrieval"]["first_rank"]
                cell += f" · r{rank}" if r["retrieval"]["hit"] else (f" · r{rank} partial" if rank else " · miss")
            cells.append(cell)
        rows.append(cells)
    return rows


def disagreements(data: dict, questions: list[Question]) -> list[str]:
    """Where the keyword check and the judge tell different stories."""
    qs = {q.id: q for q in questions}
    out = []
    for r in data["results"]:
        outcome = _outcome(r, qs[r["id"]])
        if r["keywords"] == 1 and outcome in ("wrong", "refused"):
            out.append(f"{r['id']} {r['label']}: all keywords present, judge says {outcome}: {r['judge']['reason']}")
        elif r["keywords"] == 0 and outcome == "correct":
            out.append(f"{r['id']} {r['label']}: no keywords, judge says correct: {r['judge']['reason']}")
    return out


def _table(header: list[str], rows: list[list[str]], align: str = "l") -> str:
    lines = ["| " + " | ".join(header) + " |",
             "|" + "|".join(["---"] + [("---:" if align == "r" else "---")] * (len(header) - 1)) + "|"]
    lines += ["| " + " | ".join(c.replace("|", "\\|") for c in row) + " |" for row in rows]
    return "\n".join(lines)


def markdown(data: dict, questions: list[Question]) -> str:
    labels = data["labels"]
    parts = [
        f"Run `{data['created']}`: answers from `{data['model']}`, graded by `{data.get('judge_model', '?')}`, "
        f"k = {data['k']}, temperature 0.",
        "",
        "### Totals",
        "",
        _table(["", *labels], [[name, *cells] for name, cells in summary_rows(data, questions)], "r"),
        "",
        "### Per question",
        "",
        "✅ correct · 🟡 partial · ❌ wrong · ⛔ refused, then the keyword score, `H` when the judge flagged a "
        "hallucination, and for RAG the rank of the first chunk from an expected source (`rN`) or `miss`. "
        "On the unanswerable questions (q09, q10), a refusal counts as ✅.",
        "",
        _table(["id", "kind", *labels], per_question_rows(data, questions)),
        "",
        "### Keyword check vs judge",
        "",
    ]
    dis = disagreements(data, questions)
    parts += [f"- {d}" for d in dis] if dis else ["No disagreements."]
    parts += ["", "### Answers", ""]
    index = {(r["id"], r["label"]): r for r in data["results"]}
    for q in questions:
        parts += [f"<details><summary><b>{q.id}</b> {q.question}</summary>", "", f"**Expected:** {q.expect}", ""]
        for label in labels:
            r = index[(q.id, label)]
            answer = " ".join(r["answer"].split())
            parts += [f"**{label}**: {MARK[_outcome(r, q)]} *{r['judge']['reason']}*", "", f"> {answer}", ""]
        parts += ["</details>", ""]
    return "\n".join(parts).rstrip() + "\n"


def write_markdown(path: Path, block: str) -> None:
    """Replace only the generated block; the written reading around it stays."""
    generated = f"{START}\n{block}{END}"
    if path.exists() and START in (text := path.read_text()):
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: generated, text, flags=re.S)
    else:
        text = f"# RAG vs no RAG\n\n{generated}\n"
    path.write_text(text)


def terminal(data: dict, questions: list[Question]) -> str:
    labels = data["labels"]
    rows = summary_rows(data, questions)
    w0 = max(len(name) for name, _ in rows)
    widths = [max(len(label), *(len(cells[i]) for _, cells in rows)) for i, label in enumerate(labels)]
    lines = [" " * w0 + "  " + "  ".join(label.rjust(w) for label, w in zip(labels, widths))]
    lines += [name.ljust(w0) + "  " + "  ".join(c.rjust(w) for c, w in zip(cells, widths)) for name, cells in rows]
    lines += ["", f"{'id':4} {'kind':12} " + "  ".join(f"{label:18}" for label in labels)]
    lines += [f"{r[0]:4} {r[1]:12} " + "  ".join(f"{c:18}" for c in r[2:]) for r in per_question_rows(data, questions)]
    return "\n".join(lines)
