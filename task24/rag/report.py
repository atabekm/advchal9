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


def _answered(r: dict) -> bool:
    return r.get("status", "answer") == "answer"


def _quotes_total(r: dict) -> tuple[int, int]:
    """(verified, all) quotes in the final reply, before failed ones were dropped."""
    ok = len(r.get("quotes") or [])
    return ok, ok + len(r.get("failed_quotes") or [])


def checks(r: dict) -> dict[str, bool | None]:
    """The task's per-answer checks. None where they do not apply (an "I don't know")."""
    if not _answered(r) or r["label"] == "plain":
        return {"sources": None, "quotes": None, "faithful": None}
    f = r.get("faithful")
    return {"sources": bool(r.get("sources") or r.get("cited")), "quotes": bool(r.get("quotes")),
            "faithful": None if f is None else f["verdict"] == "supported"}


def summary_rows(data: dict, questions: list[Question]) -> list[tuple[str, list[str]]]:
    qs = {q.id: q for q in questions}
    groups = _by_label(data)
    rows: list[tuple[str, list[str]]] = []

    def row(name, fn):
        rows.append((name, [fn(groups[label]) for label in data["labels"]]))

    n = len(questions)
    answerable = [q for q in questions if q.answerable]
    no_answer = [q for q in questions if not q.answerable]

    def answered(rs):
        return [r for r in rs if _answered(r)]

    def of_answered(fn):
        return lambda rs: f"{sum(bool(fn(r)) for r in answered(rs))} / {len(answered(rs))}"

    row("answers / I don't know", lambda rs: f"{len(answered(rs))} / {len(rs) - len(answered(rs))}")
    row("**sources** in the answer", of_answered(lambda r: checks(r)["sources"]))
    row("**quotes** in the answer", of_answered(lambda r: checks(r)["quotes"]))

    def verified(rs):
        ok, total = (sum(x) for x in zip(*(_quotes_total(r) for r in rs))) if rs else (0, 0)
        return "—" if not total else f"{ok} / {total}"
    row(f"quotes found in their chunk (match ≥ {data.get('min_match', 90):g})", verified)
    row("answers retried for format or quotes", lambda rs: str(sum(r.get("attempts", 1) > 1 for r in rs)))

    def faith(verdict):
        return lambda rs: "—" if not any(r.get("faithful") for r in rs) else \
            f"{sum((r.get('faithful') or {}).get('verdict') == verdict for r in answered(rs))} / {len(answered(rs))}"
    row("**meaning matches the quotes** (faithfulness judge): supported", faith("supported"))
    row("  partial", faith("partial"))
    row("  unsupported", faith("unsupported"))

    def idk(r):
        return not _answered(r)
    row(f"I don't know where expected ({len(no_answer)})", lambda rs: f"{sum(idk(r) for r in rs if not qs[r['id']].answerable)} / {len(no_answer)}")
    row("  with a clarifying question", lambda rs: f"{sum(idk(r) and bool(r.get('clarification')) for r in rs if not qs[r['id']].answerable)} / {len(no_answer)}")
    row("  of them before the LLM (relevance below the threshold)", lambda rs: str(sum(r.get("early_refusal", False) for r in rs if not qs[r['id']].answerable)))
    row(f"I don't know on an answerable question ({len(answerable)})", lambda rs: f"{sum(idk(r) for r in rs if qs[r['id']].answerable)} / {len(answerable)}")
    row("cites an expected source (answerable)", lambda rs: f"{sum(bool(r['cited_expected']) for r in rs if qs[r['id']].answerable)} / {len(answerable)}")
    row(f"expected source in the context, hit@{data['k']} (answerable)", lambda rs: f"{sum(bool(r['retrieval'] and r['retrieval']['hit']) for r in rs if qs[r['id']].answerable)} / {len(answerable)}")
    row("correctness judge (correct 1, partial ½)", lambda rs: f"{sum({'correct': 1, 'partial': .5}.get(_outcome(r, qs[r['id']]), 0) for r in rs):.1f} / {n}")
    for v in ("correct", "partial", "wrong", "refused"):
        row(f"  {v}", lambda rs, v=v: str(sum(_outcome(r, qs[r["id"]]) == v for r in rs)))
    row("hallucinations (correctness judge)", lambda rs: str(sum(r["judge"]["hallucination"] for r in rs)))
    row("keyword score (mean)", lambda rs: f"{mean(r['keywords'] for r in rs):.0%}")
    row("prompt tokens (mean)", lambda rs: f"{mean(r['prompt_tokens'] for r in rs):,.0f}")
    row("completion tokens (mean)", lambda rs: f"{mean(r['completion_tokens'] for r in rs):,.0f}")
    row("latency: answer (mean)", lambda rs: f"{mean(r.get('timings', {}).get('answer', r['seconds']) for r in rs):.1f}s")
    row("latency: total (mean)", lambda rs: f"{mean(_total(r) for r in rs):.1f}s")
    return rows


def _total(r: dict) -> float:
    t = r.get("timings") or {}
    return sum(t.values()) if t else r["seconds"]


FAITH = {"supported": "✓", "partial": "~", "unsupported": "✗"}


def per_question_rows(data: dict, questions: list[Question]) -> list[list[str]]:
    index = {(r["id"], r["label"]): r for r in data["results"]}
    rows = []
    for q in questions:
        cells = [q.id, q.kind]
        for label in data["labels"]:
            r = index[(q.id, label)]
            cell = MARK[_outcome(r, q)]
            if _answered(r):
                ok, total = _quotes_total(r)
                cell += f" {len(r.get('sources') or r.get('cited') or [])}S"
                cell += f" {ok}/{total}Q" if total else " 0Q"
                if r.get("faithful"):
                    cell += f" F{FAITH[r['faithful']['verdict']]}"
            else:
                cell += " IDK" + ("+?" if r.get("clarification") else "") + (" ∅" if r.get("early_refusal") else "")
            if r["judge"]["hallucination"]:
                cell += " H"
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
        f"k_before = {data.get('k_before', data['k'])} per query, k_after = {data['k']}, temperature 0.",
        "",
        "### Totals",
        "",
        _table(["", *labels], [[name, *cells] for name, cells in summary_rows(data, questions)], "r"),
        "",
        "### Per question",
        "",
        "Correctness: ✅ correct · 🟡 partial · ❌ wrong · ⛔ refused (on the unanswerable and ambiguous "
        "questions, a refusal counts as ✅). Then for an answer: `NS` sources, `a/bQ` quotes found in their "
        "chunk / quotes given, `F✓` / `F~` / `F✗` the faithfulness verdict (supported / partial / unsupported). "
        "For an \"I don't know\": `IDK`, `+?` with a clarifying question, `∅` decided before the LLM "
        "(relevance below the threshold). `H`: the correctness judge flagged a hallucination.",
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
            parts += _answer_block(label, index[(q.id, label)], q)
        parts += ["</details>", ""]
    return "\n".join(parts).rstrip() + "\n"


def _answer_block(label: str, r: dict, q: Question) -> list[str]:
    answer = " ".join(r["answer"].split())
    out = [f"**{label}**: {MARK[_outcome(r, q)]} *{r['judge']['reason']}*", "", f"> {answer}", ""]
    if r.get("sources"):
        out += ["Sources:", ""] + [f"- [{x['ref']}] `{x['source']}` · {x['section'] or '—'} · {x['pages']} · `{x['chunk_id']}`"
                                   for x in r["sources"]] + [""]
    if r.get("quotes") or r.get("failed_quotes"):
        out += ["Quotes:", ""]
        out += [f"- ✓ {x['match']:.0f} [{x['ref']}] “{' '.join(x['quote'].split())}”" for x in r.get("quotes") or []]
        out += [f"- ✗ {x['match']:.0f} [{x['ref']}] “{' '.join(x['quote'].split())}” (dropped)" for x in r.get("failed_quotes") or []]
        out += [""]
    if f := r.get("faithful"):
        claims = "; ".join(f["unsupported_claims"])
        out += [f"Faithfulness: **{f['verdict']}**. {f['reason']}" + (f" Unsupported: {claims}" if claims else ""), ""]
    if r.get("format_error"):
        out += [f"Retried ({r.get('attempts')} attempts): {r['format_error']}", ""]
    return out


def write_markdown(path: Path, block: str) -> None:
    """Replace only the generated block; the written reading around it stays."""
    generated = f"{START}\n{block}{END}"
    if path.exists() and START in (text := path.read_text()):
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: generated, text, flags=re.S)
    else:
        text = f"# Citations, sources and I don't know\n\n{generated}\n"
    path.write_text(text)


def terminal(data: dict, questions: list[Question]) -> str:
    labels = data["labels"]
    rows = [(name.replace("**", ""), cells) for name, cells in summary_rows(data, questions)]
    w0 = max(len(name) for name, _ in rows)
    widths = [max(len(label), *(len(cells[i]) for _, cells in rows)) for i, label in enumerate(labels)]
    lines = [" " * w0 + "  " + "  ".join(label.rjust(w) for label, w in zip(labels, widths))]
    lines += [name.ljust(w0) + "  " + "  ".join(c.rjust(w) for c, w in zip(cells, widths)) for name, cells in rows]
    lines += ["", f"{'id':4} {'kind':12} " + "  ".join(f"{label:18}" for label in labels)]
    lines += [f"{r[0]:4} {r[1]:12} " + "  ".join(f"{c:18}" for c in r[2:]) for r in per_question_rows(data, questions)]
    return "\n".join(lines)
