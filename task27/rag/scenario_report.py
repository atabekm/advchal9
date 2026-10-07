"""The scenario run as tables (terminal and EVAL.md) and as transcripts."""

from __future__ import annotations

import re
from pathlib import Path

from .scenario import Scenario

START, END = "<!-- scenarios:start -->", "<!-- scenarios:end -->"


def _frac(n: int, d: int) -> str:
    return "—" if d == 0 else f"{n}/{d}"


def _runs(data: dict, scenario: str | None, label: str) -> list[dict]:
    return [r for r in data["runs"] if r["label"] == label and (scenario is None or r["scenario"] == scenario)]


def metrics(runs: list[dict], scenarios: dict[str, Scenario]) -> dict[str, str]:
    turns = [(scenarios[r["scenario"]].turns[t["turn"] - 1], t) for r in runs for t in r["turns"]]
    graded = [(st, t) for st, t in turns if "checks" in t]

    def count(key, source="checks"):
        vals = [t.get(source, {}).get(key) for _, t in graded]
        vals = [v for v in vals if v is not None]
        return _frac(sum(bool(v) for v in vals), len(vals))

    answers = [t for _, t in graded if t["data"].get("status") == "answer"]
    faith = [t["faithful"]["verdict"] for t in answers if t.get("faithful")]
    on = [r for r in runs if r["memory"]]
    at_turn = [t["memory_check"] for _, t in graded if t.get("memory_check")]
    final = [r["final_memory"] for r in on if r.get("final_memory")]
    goals = [m["goal"] for m in at_turn + final if m.get("goal") is not None]
    seconds = [t["data"].get("seconds", 0) for _, t in turns if t["data"].get("seconds")]
    tokens = [t["data"].get("tokens", {}).get("prompt", 0) for _, t in turns if t["data"].get("tokens")]
    errors = sum(t["data"].get("status") == "error" for _, t in turns)
    out = {
        "turns": str(len(turns)) + (f" ({errors} errors)" if errors else ""),
        "reply of the expected kind": count("status"),
        "answers with sources and quotes": count("sourced"),
        "expected document cited": count("expected_source"),
        "I don't know with a clarifying question": count("clarifies"),
        "follow-up resolved": count("resolved", "judge"),
        "constraints kept": count("constraints_kept", "judge"),
        "units / must contain": count("must_contain"),
        "on track": count("on_track", "judge"),
        "faithful (supported / partial / unsupported)":
            "—" if not faith else f"{faith.count('supported')} / {faith.count('partial')} / {faith.count('unsupported')}",
    }
    if on:
        out.update({
            "memory: items recorded at their turn": _frac(sum(m["present"] for m in at_turn), sum(m["expected"] for m in at_turn)),
            "memory: items still there at the end": _frac(sum(m["present"] for m in final), sum(m["expected"] for m in final)),
            "memory: goal matches": _frac(sum(bool(g) for g in goals), len(goals)),
            "memory: scope right after each turn": count("scope"),
            "memory: wrong items (end)": str(sum(len(m["wrong"]) for m in final)),
        })
    else:
        out.update({k: "—" for k in ("memory: items recorded at their turn", "memory: items still there at the end",
                                      "memory: goal matches", "memory: scope right after each turn",
                                      "memory: wrong items (end)")})
    out["mean seconds per turn"] = f"{sum(seconds) / len(seconds):.1f}" if seconds else "—"
    out["mean prompt tokens per turn"] = f"{sum(tokens) / len(tokens):.0f}" if tokens else "—"
    return out


def summary(data: dict, scenarios: list[Scenario]) -> tuple[list[str], list[tuple[str, list[str]]]]:
    by_id = {s.id: s for s in scenarios}
    ids = list(dict.fromkeys(r["scenario"] for r in data["runs"]))
    columns, cells = [], []
    for sid in [*ids, None] if len(ids) > 1 else ids:
        for label in data["labels"]:
            columns.append(f"{sid or 'all'} · {label}")
            cells.append(metrics(_runs(data, sid, label), by_id))
    names = list(cells[0])
    return columns, [(n, [c[n] for c in cells]) for n in names]


def terminal(data: dict, scenarios: list[Scenario]) -> str:
    columns, rows = summary(data, scenarios)
    w0 = max(len(n) for n, _ in rows)
    widths = [max(len(c), *(len(r[1][i]) for r in rows)) for i, c in enumerate(columns)]
    lines = [" " * w0 + "  " + "  ".join(c.rjust(w) for c, w in zip(columns, widths))]
    lines += [n.ljust(w0) + "  " + "  ".join(v.rjust(w) for v, w in zip(vals, widths)) for n, vals in rows]
    return "\n".join(lines)


def _mark(v) -> str:
    return "—" if v is None else ("✓" if v else "✗")


def _change(c: dict) -> str:
    if c["op"] == "set_goal":
        return f"goal → {c['text']}"
    if c["op"] == "set_scope":
        return f"scope → {c['text']}"
    return f"{'+' if c['op'] == 'add' else '−'} {c['field']}: {c['text']}"


def _quote_md(text: str) -> str:
    return "\n".join(f"> {line}" if line.strip() else ">" for line in text.strip().splitlines())


def transcript(run: dict, scenario: Scenario) -> str:
    out = []
    for st, t in zip(scenario.turns, run["turns"]):
        d, j, c = t["data"], t.get("judge", {}), t.get("checks", {})
        status = d.get("status")
        out.append(f"**{t['turn']}. user:** {t['text']}  ")
        if d.get("kind") == "question" and d.get("standalone"):
            out.append(f"*searched as:* {d['standalone']}" + (f" · *scope:* {', '.join(d['retrieval']['scope'])}"
                                                              if d.get("retrieval", {}) and d["retrieval"].get("scope") else ""))
        out.append("")
        out.append(f"*{status}* (expected {st.expect}) · {d.get('seconds', 0):.1f} s")
        out.append("")
        out.append(_quote_md(t["reply"] or d.get("error", "")))
        out.append("")
        if d.get("sources"):
            out.append("Sources: " + "; ".join(f"[{s['ref']}] {s['source']} · {s['section'] or '—'} · {s['pages']}"
                                              for s in d["sources"]) + "  ")
            scores = [q["match"] for q in d.get("quotes", [])]
            out.append(f"Quotes: {len(scores)} verified (lowest {min(scores):.0f})"
                       + (f", {len(d['dropped_quotes'])} dropped" if d.get("dropped_quotes") else "") + "  ")
        if d.get("memory_changes"):
            out.append("Memory: " + "; ".join(_change(ch) for ch in d["memory_changes"]) + "  ")
        verdicts = [f"kind {_mark(c.get('status'))}"]
        if "sourced" in c:
            verdicts.append(f"sources+quotes {_mark(c['sourced'])}")
        if "expected_source" in c:
            verdicts.append(f"expected doc {_mark(c['expected_source'])}")
        if "must_contain" in c:
            verdicts.append(f"units {_mark(c['must_contain'])}")
        if j:
            verdicts += [f"resolved {_mark(j.get('resolved'))}", f"constraints {_mark(j.get('constraints_kept'))}",
                         f"on track {_mark(j.get('on_track'))}"]
        if t.get("faithful"):
            verdicts.append(f"faithful: {t['faithful']['verdict']}")
        if t.get("memory_check"):
            m = t["memory_check"]
            verdicts.append(f"memory {m['present']}/{m['expected']}" + (f", goal {_mark(m['goal'])}" if m.get("goal") is not None else ""))
        out.append("Checks: " + " · ".join(verdicts) + "  ")
        notes = [x for x in [j.get("reason") if j and (j.get("on_track") is False or j.get("constraints_kept") is False
                                                       or j.get("resolved") is False) else "",
                             "violated: " + "; ".join(j["violated"]) if j and j.get("violated") else ""] if x]
        if notes:
            out.append("*Judge:* " + " ".join(notes) + "  ")
        out.append("")
    return "\n".join(out)


def off_table(on: dict, off: dict, scenario: Scenario) -> str:
    """Memory off, turn by turn next to memory on; the reply when the verdicts differ."""
    rows = ["| turn | message | memory on: kind · constraints · on track | memory off: kind · constraints · on track |",
            "|---:|---|---|---|"]
    diffs = []
    for st, a, b in zip(scenario.turns, on["turns"], off["turns"]):
        def cell(t):
            j = t.get("judge", {})
            return f"{t['data'].get('status')} · {_mark(j.get('constraints_kept'))} · {_mark(j.get('on_track'))}"
        rows.append(f"| {a['turn']} | {st.text[:70]}{'…' if len(st.text) > 70 else ''} | {cell(a)} | {cell(b)} |")
        ja, jb = a.get("judge", {}), b.get("judge", {})
        if (a["data"].get("status"), ja.get("constraints_kept"), ja.get("on_track")) != \
                (b["data"].get("status"), jb.get("constraints_kept"), jb.get("on_track")):
            reason = jb.get("reason", "")
            diffs.append(f"**{b['turn']}. memory off** ({b['data'].get('status')}"
                         + (f"; searched as: {b['data']['standalone']}" if b['data'].get('standalone') else "") + ")\n\n"
                         + _quote_md(b["reply"] or "") + ("\n\n*Judge:* " + reason if reason else "") + "\n")
    return "\n".join(rows) + ("\n\nWhere the two differ, the reply without memory:\n\n" + "\n".join(diffs) if diffs else "")


def markdown(data: dict, scenarios: list[Scenario]) -> str:
    by_id = {s.id: s for s in scenarios}
    columns, rows = summary(data, scenarios)
    parts = [
        f"Run {data['created']} · answers {data['model']} · judge {data.get('judge_model', '—')} · "
        f"{data['mode']} (threshold {data['threshold']:g}, floor {data['floor'] if data['floor'] is not None else '—'}) · "
        f"history window {data['window']} messages · {data['wall_seconds']:.0f} s\n",
        "| | " + " | ".join(columns) + " |",
        "|---|" + "---:|" * len(columns),
        *[f"| {n} | " + " | ".join(v) + " |" for n, v in rows],
        "",
    ]
    for sid in dict.fromkeys(r["scenario"] for r in data["runs"]):
        s = by_id[sid]
        runs = {r["label"]: r for r in data["runs"] if r["scenario"] == sid}
        on = next((r for r in runs.values() if r["memory"]), None)
        off = next((r for r in runs.values() if not r["memory"]), None)
        parts.append(f"### {sid}: {s.title}\n")
        if on is not None:
            parts.append("#### Transcript with the task memory\n")
            parts.append(transcript(on, s))
            if on.get("final_memory"):
                m = on["final_memory"]
                last = next(t for t in reversed(on["turns"]) if "memory" in t["data"])
                from .memory import TaskMemory
                parts.append("Memory at the end:\n\n```\n" + TaskMemory.from_dict(last["data"]["memory"]).block(with_ids=True)
                             + "\n```\n")
                parts.append(f"Against everything the user established: {m['present']}/{m['expected']} items, goal "
                             f"{_mark(m['goal'])}" + (f"; missing: {'; '.join(m['missing'])}" if m["missing"] else "")
                             + (f"; wrong: {'; '.join(m['wrong'])}" if m["wrong"] else "") + "\n")
        if on is not None and off is not None:
            parts.append("#### Without the task memory\n")
            parts.append(off_table(on, off, s) + "\n")
        elif off is not None:
            parts.append(transcript(off, s))
    return "\n".join(parts)


def write_markdown(path: Path, block: str, title: str = "# Task 27 — scenarios") -> None:
    """Replace only the generated block; the written reading around it stays."""
    generated = f"{START}\n{block}\n{END}"
    text = path.read_text() if path.exists() else ""
    if START in text:
        text = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: generated, text, flags=re.S)
    elif text:
        text = f"{text.rstrip()}\n\n{generated}\n"
    else:
        text = f"{title}\n\n{generated}\n"
    path.write_text(text)
