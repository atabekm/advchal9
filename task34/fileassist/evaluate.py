"""`fileassist eval`: run the cases in cases.json on fresh fixture builds and check the results by code.

Each run gets its own fixture, the agent works on its goal, the staged diff is applied, and the checks
look at the report, the diff and the files. A case passes when every check does. Results go to
results/eval-<time>.json and .md (a table of models × cases), and every run's transcript to
results/eval-<time>/<model>/<case>-<n>/.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import re
import statistics
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import fixture, runs, scenarios
from .agent import MAX_STEPS, Agent, Run
from .files_client import FilesClient
from .llm import LocalLLM

CASES = runs.TASK_DIR / "cases.json"
RESULTS = runs.TASK_DIR / "results"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class Result:
    case: str
    model: str
    n: int
    passed: bool
    checks: list[Check] = field(default_factory=list)
    steps: int = 0
    seconds: float = 0.0
    stop_reason: str = ""
    path: str = ""


def load_cases(path: Path = CASES) -> list[dict]:
    return json.loads(path.read_text())["cases"]


def goal_of(case: dict) -> tuple[str, str, bool]:
    """The goal, the checklist and read-only-ness of a case: a preset scenario or a goal in words."""
    if "scenario" in case:
        sc = scenarios.by_name(case["scenario"], case.get("arg"))
        return sc.goal, sc.checklist, not sc.changes_files
    return case["goal"], "", False


# --- the checks -----------------------------------------------------------------------------------

def _any(item: str | list[str], text: str) -> bool:
    return any(x in text for x in ([item] if isinstance(item, str) else item))


def _label(item: str | list[str]) -> str:
    return item if isinstance(item, str) else " or ".join(item)


def _diff_files(diff: str) -> dict[str, list[str]]:
    """Path → the diff lines of that file."""
    out: dict[str, list[str]] = {}
    current = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            current = line.split(" b/", 1)[1]
            out[current] = []
        elif current is not None:
            out[current].append(line)
    return out


def _body(lines: list[str], sign: str) -> list[str]:
    return [x[1:] for x in lines if x.startswith(sign) and not x.startswith(sign * 3)]


def _paths(root: Path, pattern: str) -> list[Path]:
    return sorted(p for p in root.glob(pattern) if p.is_file())


def _section(text: str, heading: str) -> str | None:
    """The text under the first heading containing `heading`, up to the next heading of its level or higher."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"(#+)\s", line)
        if m and heading in line:
            level = len(m.group(1))
            end = next((j for j in range(i + 1, len(lines))
                        if (h := re.match(r"(#+)\s", lines[j])) and len(h.group(1)) <= level), len(lines))
            return "\n".join(lines[i + 1:end])
    return None


def check(case: dict, run: Run, root: Path) -> list[Check]:
    """The case's checks on a finished run whose diff has been applied to `root`."""
    c = case["checks"]
    out: list[Check] = []
    report, files = run.report, _diff_files(run.diff)
    changed = sorted(files)

    def matches(path: str, patterns: list[str]) -> bool:
        return any(fnmatch.fnmatch(path, p) for p in patterns)

    def text_of(pattern: str) -> str | None:
        found = _paths(root, pattern)
        return "\n".join(p.read_text(errors="replace") for p in found) if found else None

    for item in c.get("report_mentions", []):
        out.append(Check(f"report mentions {_label(item)}", _any(item, report)))
    for item in c.get("report_lacks", []):
        out.append(Check(f"report doesn't mention {_label(item)}", not _any(item, report)))
    if c.get("no_changes"):
        out.append(Check("no file changed", not changed, ", ".join(changed)))
    for path in c.get("diff_touches", []):
        out.append(Check(f"changes {path}", any(fnmatch.fnmatch(p, path) for p in changed)))
    if pats := c.get("diff_not_touches"):
        bad = [p for p in changed if matches(p, pats)]
        out.append(Check(f"leaves {', '.join(pats)} alone", not bad, ", ".join(bad)))
    if pats := c.get("diff_only"):
        bad = [p for p in changed if not matches(p, pats)]
        out.append(Check(f"changes only {', '.join(pats)}", bool(changed) and not bad,
                         ", ".join(bad) or ("nothing changed" if not changed else "")))
    for pattern in c.get("no_deletions", []):
        gone = [x for p, lines in files.items() if fnmatch.fnmatch(p, pattern) for x in _body(lines, "-")]
        out.append(Check(f"deletes no line of {pattern}", not gone, " | ".join(gone)[:200]))
    added = "\n".join(x for lines in files.values() for x in _body(lines, "+"))
    for item in c.get("added_lacks", []):
        out.append(Check(f"adds no {_label(item)}", not _any(item, added)))
    for pattern in c.get("file_exists", []):
        out.append(Check(f"{pattern} exists", bool(_paths(root, pattern))))
    for pattern, items in c.get("files_contain", {}).items():
        text = text_of(pattern)
        for item in items:
            out.append(Check(f"{pattern} has {_label(item)}", text is not None and _any(item, text),
                             "" if text is not None else "no such file"))
    for pattern, items in c.get("files_lack", {}).items():
        text = text_of(pattern) or ""
        for item in items:
            out.append(Check(f"{pattern} has no {_label(item)}", not _any(item, text)))
    for pattern, regex in c.get("files_match", {}).items():
        text = text_of(pattern)
        out.append(Check(f"{pattern} matches /{regex}/", text is not None and re.search(regex, text) is not None))
    for where, items in c.get("section_contains", {}).items():
        path, heading = where.split("#", 1)
        section = _section(text_of(path) or "", heading)
        for item in items:
            out.append(Check(f"{heading} has {_label(item)}", section is not None and _any(item, section)))
    for where, items in c.get("section_lacks", {}).items():
        path, heading = where.split("#", 1)
        section = _section(text_of(path) or "", heading) or ""
        for item in items:
            out.append(Check(f"{heading} has no {_label(item)}", not _any(item, section)))
    if c.get("tests_pass"):
        r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"], cwd=root,
                           capture_output=True, text=True, timeout=300)
        tail = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-200:]
        out.append(Check("the project's tests pass", r.returncode == 0, tail))
    return out


# --- running --------------------------------------------------------------------------------------

async def run_case(case: dict, model: str, n: int, out_dir: Path, think: bool | str = False,
                   steps: int = MAX_STEPS) -> Result:
    root = fixture.build(out_dir / "workspace" / "parcel")
    goal, extra, read_only = goal_of(case)
    async with FilesClient(root) as fs:
        run = await Agent(fs, LocalLLM(model, think=think), max_steps=steps, read_only=read_only).run(goal, extra)
        if run.diff:
            await fs.apply()
    checks = check(case, run, root)
    saved = runs.save(run, root, case["id"], runs_dir=out_dir)
    return Result(case["id"], model, n, all(c.ok for c in checks), checks, run.steps, run.seconds,
                  run.stop_reason, str(saved.relative_to(runs.TASK_DIR)))


def summary(results: list[Result], models: list[str], case_ids: list[str]) -> str:
    """A Markdown table: one row per case, one column per model, "passes/runs · median calls · median s"."""
    lines = ["| case | " + " | ".join(f"`{m}`" for m in models) + " |",
             "| --- |" + " --- |" * len(models)]
    for cid in case_ids + ["**all**"]:
        cells = []
        for m in models:
            rs = [r for r in results if r.model == m and (r.case == cid or cid == "**all**")]
            if not rs:
                cells.append("—")
                continue
            passed = sum(r.passed for r in rs)
            checks = [c.ok for r in rs for c in r.checks]
            cells.append(f"{passed}/{len(rs)} · {100 * sum(checks) // max(1, len(checks))} % checks · "
                         f"{statistics.median(r.steps for r in rs):.0f} calls · "
                         f"{statistics.median(r.seconds for r in rs):.0f} s")
        lines.append(f"| {cid} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def failures(results: list[Result]) -> str:
    out = []
    for r in results:
        bad = [c for c in r.checks if not c.ok]
        if bad:
            out.append(f"- `{r.model}` {r.case} #{r.n} ({r.stop_reason}): " + "; ".join(
                c.name + (f" ({c.detail})" if c.detail else "") for c in bad))
    return "\n".join(out) or "(none)"


def main(models: list[str], case_ids: list[str] | None, repeat: int, think: bool | str,
         steps: int = MAX_STEPS) -> Path:
    cases = load_cases()
    if case_ids:
        unknown = set(case_ids) - {c["id"] for c in cases}
        if unknown:
            raise SystemExit(f"fileassist eval: no case {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["id"] in case_ids]
    stamp = runs.stamp()
    base = RESULTS / f"eval-{stamp}"
    results: list[Result] = []
    for model in models:
        for case in cases:
            for n in range(1, repeat + 1):
                out_dir = base / runs.slug(model) / f"{case['id']}-{n}"
                r = asyncio.run(run_case(case, model, n, out_dir, think, steps))
                results.append(r)
                ok = sum(c.ok for c in r.checks)
                print(f"{model:<16} {case['id']:<24} #{n} {'PASS' if r.passed else 'fail'} {ok}/{len(r.checks)} "
                      f"checks · {r.steps} calls · {r.seconds:.0f}s · {r.stop_reason}", flush=True)
    ids = [c["id"] for c in cases]
    table = summary(results, models, ids)
    data = {"stamp": stamp, "models": models, "repeat": repeat, "think": think,
            "results": [r.__dict__ | {"checks": [c.__dict__ for c in r.checks]} for r in results]}
    (RESULTS / f"eval-{stamp}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    md = (f"# Eval {stamp}\n\n{repeat} run(s) per case, think={think}. A cell: runs that passed every check, "
          f"the share of checks passed, median tool calls, median time.\n\n{table}\n\n## Failed checks\n\n"
          f"{failures(results)}\n")
    (RESULTS / f"eval-{stamp}.md").write_text(md)
    print("\n" + table)
    return RESULTS / f"eval-{stamp}.md"
