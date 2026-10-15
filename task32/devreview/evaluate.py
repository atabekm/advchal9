"""The evaluation: seeded pull requests with known defects, reviewed like real ones.

Each case in `cases.json` is a few find/replace edits to real files of this repository at
`main`, plus what a reviewer should say about them:

    expect.file      the file the defect is in
    expect.kinds     the kinds of finding that count (bug or architecture: the label matters less
                     than the catch; the table shows which one the reviewer chose)
    expect.keywords  words a finding about this defect would use

The edits become a patch, the patch a commit on top of `main` (`diff.patched`), and the commit is
reviewed with the same `Reviewer` the pipeline uses. A defect counts as **found** when a finding
in that file, of one of those kinds, gives the reason: it uses one of the keywords. A finding of
the right kind on a changed line (±3) with some other reason only **located** it. Every other bug
or architecture finding is **noise**, as is any on a clean case (`expect: null`).
Recommendations are counted, not scored.
"""

from __future__ import annotations

import difflib
import json
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .corpus import TASK_DIR, GitTree
from .diff import patched
from .review import FileReview, Finding, Review, Reviewer

CASES = TASK_DIR / "cases.json"
RESULTS = TASK_DIR / "results"
NEAR = 3


@dataclass
class CaseResult:
    id: str
    defect: str | None
    found: bool | None  # the right reason; None for a clean case
    match: dict | None  # the finding that found it (or, when none did, the one that located it)
    located: bool | None = None  # a finding on the defect's lines, whatever its reason
    noise: list[dict] = field(default_factory=list)  # bugs/architecture findings that aren't the defect
    rejected: list[dict] = field(default_factory=list)  # findings the verification call turned down
    anchors: list[int] = field(default_factory=list)  # the defect's lines in the new file
    recommendations: int = 0
    seconds: float = 0.0
    prompt_tokens: int = 0
    error: str = ""


def load(path: Path = CASES, only: list[str] | None = None) -> list[dict]:
    cases = json.loads(path.read_text())
    if only:
        cases = [c for c in cases if c["id"] in only]
        if not cases:
            raise SystemExit(f"no case with id {only}")
    return cases


def make_patch(root: Path, case: dict, base: str = "main") -> str:
    tree = GitTree(root, base)
    texts: dict[str, str] = {}
    for e in case["edits"]:
        text = texts.get(e["file"]) or tree.read(e["file"])
        if text is None:
            raise ValueError(f"{case['id']}: {e['file']} not found at {base}")
        if text.count(e["find"]) != 1:
            raise ValueError(f"{case['id']}: the text to replace occurs {text.count(e['find'])} times in {e['file']}")
        texts[e["file"]] = text.replace(e["find"], e["replace"])
    out = []
    for path, new in texts.items():
        old = tree.read(path)
        diff = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                                    f"a/{path}", f"b/{path}")
        out.append(f"diff --git a/{path} b/{path}\n" + "".join(diff))
    return "".join(out)


def score(case: dict, review: Review, anchors: list[int]) -> CaseResult:
    exp = case.get("expect")
    fr_err = "; ".join(f"{fr.path}: {fr.error}" for fr in review.files if fr.error)
    res = CaseResult(case["id"], case.get("defect"), None if not exp else False, None, error=fr_err,
                     seconds=review.seconds, prompt_tokens=sum(fr.prompt_tokens for fr in review.files),
                     recommendations=sum(f.kind == "recommendation" for f in review.findings),
                     rejected=[r for fr in review.files for r in fr.rejected])
    issues = [f for f in review.findings if f.kind != "recommendation"]
    if exp:
        res.located = False
        best = next((f for f in issues if gives_reason(f, exp)), None)
        if best:
            res.found = res.located = True
        else:
            best = next((f for f in issues if on_lines(f, exp, anchors)), None)
            res.located = best is not None
        res.match = asdict(best) if best else None
        issues = [f for f in issues if f is not best]
    res.noise = [asdict(f) for f in issues]
    return res


def gives_reason(f: Finding, exp: dict) -> bool:
    text = f"{f.title} {f.detail}".lower().replace("`", "")
    return f.file == exp["file"] and f.kind in exp["kinds"] and any(k.lower() in text for k in exp["keywords"])


def on_lines(f: Finding, exp: dict, anchors: list[int]) -> bool:
    return (f.file == exp["file"] and f.kind in exp["kinds"] and f.line is not None
            and any(abs(f.line - a) <= NEAR for a in anchors))


def run(root: Path, reviewer: Reviewer, cases: list[dict], base: str = "main",
        progress=lambda _: None) -> list[CaseResult]:
    out = []
    for case in cases:
        with tempfile.TemporaryDirectory() as tmp:
            patch = Path(tmp) / f"{case['id']}.patch"
            patch.write_text(make_patch(root, case, base))
            change = patched(root, patch, base, title=case["title"])
        started = time.monotonic()
        review = reviewer.review(change)
        exp = case.get("expect")
        fd = next((f for f in change.files if exp and f.path == exp["file"]), None)
        res = score(case, review, fd.anchors if fd else [])
        res.anchors = fd.anchors if fd else []
        res.seconds = time.monotonic() - started
        out.append(res)
        mark = "—" if res.found is None else "found" if res.found else "located" if res.located else "MISSED"
        progress(f"{case['id']:18} {mark:6}  noise {len(res.noise)}  rec {res.recommendations}  {res.seconds:.0f}s"
                 + (f"  error: {res.error}" if res.error else ""))
    return out


def rescore(path: Path, cases: list[dict]) -> list[CaseResult]:
    """Apply the scoring again to a saved run (after a change to the scoring, not the review)."""
    data = json.loads(path.read_text())
    by_id = {c["id"]: c for c in cases}
    out = []
    for old in data["results"]:
        findings = [Finding(**f) for f in ([old["match"]] if old["match"] else []) + old["noise"]]
        review = Review("", "", "", "", files=[FileReview("", findings=findings)])
        res = score(by_id[old["id"]], review, old.get("anchors", []))
        res.seconds, res.prompt_tokens, res.error = old["seconds"], old["prompt_tokens"], old["error"]
        res.recommendations, res.rejected = old["recommendations"], old.get("rejected", [])
        res.anchors = old.get("anchors", [])
        out.append(res)
    data["summary"], data["results"] = summary(out), [asdict(r) for r in out]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    return out


def summary(results: list[CaseResult]) -> str:
    defects = [r for r in results if r.found is not None]
    clean = [r for r in results if r.found is None]
    found = sum(bool(r.found) for r in defects)
    lines = [
        f"defects found     {found}/{len(defects)} (a finding gives the reason)",
        f"defects located   {sum(bool(r.located) for r in defects)}/{len(defects)} (a finding on the defect's lines)",
        f"noise per PR      {sum(len(r.noise) for r in results) / max(len(results), 1):.1f} "
        f"(bug/architecture findings that are not the seeded defect)",
        f"clean PRs quiet   {sum(not r.noise for r in clean)}/{len(clean)} (no bug or architecture finding)",
        f"recommendations   {sum(r.recommendations for r in results)} in {len(results)} PRs",
        f"mean time         {sum(r.seconds for r in results) / max(len(results), 1):.1f}s per PR",
    ]
    return "\n".join(lines)


def table(results: list[CaseResult]) -> str:
    rows = ["| case | seeded defect | verdict | the finding | other findings | time |", "| --- | --- | --- | --- | --- | --- |"]
    for r in results:
        verdict = "—" if r.found is None else "found" if r.found else "located" if r.located else "**missed**"
        m = r.match
        what = f"{m['severity']} {m['kind']} L{m['line'] or '?'}: {m['title']}" if m else ""
        noise = "; ".join(f"{n['severity']} {n['kind']}: {n['title']}" for n in r.noise) or "—"
        rows.append(f"| {r.id} | {r.defect or '(clean)'} | {verdict} | {what} | {noise} | {r.seconds:.0f}s |")
    return "\n".join(rows)


def save(results: list[CaseResult], meta: dict) -> Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"eval-{time.strftime('%Y%m%dT%H%M%S')}.json"
    path.write_text(json.dumps({"meta": meta, "summary": summary(results),
                                "results": [asdict(r) for r in results]}, ensure_ascii=False, indent=1) + "\n")
    return path
