"""`uv run devassist eval`: run questions.json through /help and check every answer.

Per question:
- **retrieval**: a passage from an expected source is among those the model was given
  (prefix match on "path › section"; questions answered by tools have no expected source);
- **answer**: every `must` group has one alternative in the answer (case-insensitive), and no
  `forbid` term appears. `{branch}` and `{head_subject}` are filled in from git first;
- **tools**: every expected tool was used, either called by the model or (list_files) run for
  a path the question names.

The full record of each run goes to results/eval-<time>.json.
"""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .assistant import Answer, Assistant, answer_json
from .corpus import TASK_DIR, repo_root

QUESTIONS = TASK_DIR / "questions.json"
RESULTS = TASK_DIR / "results"


@dataclass
class Check:
    id: str
    retrieval: bool | None
    answer: bool
    tools: bool
    missing: list[str]
    answer_obj: Answer

    @property
    def passed(self) -> bool:
        return self.retrieval is not False and self.answer and self.tools


def placeholders(root: Path) -> dict[str, str]:
    def git(*args):
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True).stdout.strip()
    return {"branch": git("branch", "--show-current"), "head_subject": git("log", "-1", "--pretty=%s")}


def check(q: dict, a: Answer, values: dict[str, str]) -> Check:
    text = a.text.lower()
    missing = []
    for group in q.get("must", []):
        alts = [alt.format(**values).lower() for alt in group]
        if not any(alt in text for alt in alts):
            missing.append(" | ".join(alts))
    forbidden = [f for f in q.get("forbid", []) if f.lower() in text]
    missing += [f"forbidden: {f}" for f in forbidden]
    sources = q.get("sources", [])
    retrieval = any(h.label.startswith(s) for h in a.hits for s in sources) if sources else None
    used = {name for name, _, _ in a.tool_calls} | ({"list_files"} if a.listed else set())
    tools_ok = set(q.get("tools", [])) <= used
    if not tools_ok:
        missing.append(f"tools: expected {sorted(q['tools'])}, used {sorted(used)}")
    return Check(q["id"], retrieval, not any(not m.startswith("tools:") for m in missing), tools_ok, missing, a)


async def evaluate(assistant: Assistant, questions: list[dict], progress=print) -> list[Check]:
    values = placeholders(repo_root())
    out = []
    for q in questions:
        a = await assistant.help(q["question"])
        c = check(q, a, values)
        out.append(c)
        mark = "PASS" if c.passed else "FAIL"
        progress(f"{mark}  {q['id']:18} {a.seconds:5.1f}s  {'; '.join(c.missing)}")
    return out


def summary(checks: list[Check]) -> str:
    n = len(checks)
    with_src = [c for c in checks if c.retrieval is not None]
    lines = [
        f"passed          {sum(c.passed for c in checks)}/{n}",
        f"retrieval hit   {sum(bool(c.retrieval) for c in with_src)}/{len(with_src)} (expected source among the passages)",
        f"answer checks   {sum(c.answer for c in checks)}/{n}",
        f"tool use        {sum(c.tools for c in checks)}/{n}",
        f"mean time       {sum(c.answer_obj.seconds for c in checks) / max(n, 1):.1f}s",
    ]
    return "\n".join(lines)


def save(checks: list[Check], model: str) -> Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"eval-{time.strftime('%Y%m%dT%H%M%S')}.json"
    path.write_text(json.dumps({
        "model": model,
        "summary": summary(checks).splitlines(),
        "questions": [{"id": c.id, "passed": c.passed, "retrieval": c.retrieval, "answer_ok": c.answer,
                       "tools_ok": c.tools, "missing": c.missing, **answer_json(c.answer_obj)} for c in checks],
    }, ensure_ascii=False, indent=2))
    return path


def load(path: Path = QUESTIONS, only: list[str] | None = None) -> list[dict]:
    qs = json.loads(path.read_text())
    return [q for q in qs if not only or q["id"] in only]
