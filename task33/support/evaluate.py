"""`uv run support eval`: run cases.json through the assistant and check every answer.

Per case:
- **retrieval**: a passage from an expected source is among those the model was given
  (prefix match on "path › section");
- **answer**: every `must` group has one alternative in the customer's answer (case-insensitive),
  and no `forbid` term appears;
- **cited**: the answer cites at least one passage.

`--ablation` runs every case that has a ticket or user a second time without them: the same
question, the knowledge base only. That is what the customer context is worth.

The full record of each run goes to results/eval-<time>.json.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from .assistant import Answer, Assistant, answer_json
from .kb import TASK_DIR

CASES = TASK_DIR / "cases.json"
RESULTS = TASK_DIR / "results"


@dataclass
class Check:
    id: str
    with_context: bool
    retrieval: bool | None
    answer: bool
    missing: list[str]
    answer_obj: Answer

    @property
    def cited(self) -> bool:
        return bool(self.answer_obj.cited)

    @property
    def passed(self) -> bool:
        return self.retrieval is not False and self.answer


def check(case: dict, a: Answer, with_context: bool = True) -> Check:
    text = a.text.lower()
    missing = [" | ".join(group) for group in case.get("must", [])
               if not any(alt.lower() in text for alt in group)]
    missing += [f"forbidden: {f}" for f in case.get("forbid", []) if f.lower() in text]
    sources = case.get("sources", [])
    retrieval = any(h.label.startswith(s) for h in a.hits for s in sources) if sources else None
    return Check(case["id"], with_context, retrieval, not missing, missing, a)


async def evaluate(assistant: Assistant, cases: list[dict], ablation: bool = False, progress=print) -> list[Check]:
    out = []
    runs = [(c, True) for c in cases]
    if ablation:
        runs += [(c, False) for c in cases if c.get("ticket") or c.get("user")]
    for case, with_context in runs:
        ticket, user = (case.get("ticket"), case.get("user")) if with_context else (None, None)
        a = await assistant.ask(case["question"], ticket, user)
        c = check(case, a, with_context)
        out.append(c)
        tag = "" if with_context else " (no context)"
        mark = "PASS" if c.passed else "FAIL"
        retr = {True: "hit", False: "MISS", None: "-"}[c.retrieval]
        progress(f"{mark}  {case['id'] + tag:24} {a.seconds:5.1f}s  retrieval {retr:4}  "
                 f"cited {a.cited or '-'}  {'; '.join(c.missing)}")
    return out


def summary(checks: list[Check]) -> str:
    def block(cs: list[Check], title: str) -> list[str]:
        n = len(cs)
        with_src = [c for c in cs if c.retrieval is not None]
        return [
            title,
            f"  passed          {sum(c.passed for c in cs)}/{n}",
            f"  retrieval hit   {sum(bool(c.retrieval) for c in with_src)}/{len(with_src)}",
            f"  answer checks   {sum(c.answer for c in cs)}/{n}",
            f"  cites a passage {sum(c.cited for c in cs)}/{n}",
            f"  mean time       {sum(c.answer_obj.seconds for c in cs) / max(n, 1):.1f}s",
        ]
    main = [c for c in checks if c.with_context]
    lines = block(main, f"all cases ({len(main)})")
    ablated = [c for c in checks if not c.with_context]
    if ablated:
        ids = {c.id for c in ablated}
        lines += block([c for c in main if c.id in ids], f"\ncases with customer context ({len(ids)}), with it")
        lines += block(ablated, f"the same cases, without it")
    return "\n".join(lines)


def save(checks: list[Check], model: str) -> Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"eval-{time.strftime('%Y%m%dT%H%M%S')}.json"
    path.write_text(json.dumps({
        "model": model,
        "summary": summary(checks).splitlines(),
        "cases": [{"id": c.id, "with_context": c.with_context, "passed": c.passed, "retrieval": c.retrieval,
                   "answer_ok": c.answer, "missing": c.missing, **answer_json(c.answer_obj)} for c in checks],
    }, ensure_ascii=False, indent=2))
    return path


def load(path: Path = CASES, only: list[str] | None = None) -> list[dict]:
    cases = json.loads(path.read_text())
    return [c for c in cases if not only or c["id"] in only]
