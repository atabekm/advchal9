import json
import re
from pathlib import Path

import pytest

from devreview.context import build_context
from devreview.diff import local, parse
from devreview.llm import LLMError, Reply
from devreview.report import MARKER, markdown, terminal
from devreview.review import Finding, Reviewer, check, merge, parse_findings, place, user_prompt

from .fakes import commit, git, init_repo


class ScriptedLLM:
    """Answers each review call with the next scripted reply, and each verification call with the
    next scripted verdicts (by default: every finding is real). Records the prompts."""
    model = "scripted"

    def __init__(self, *replies, verdicts=()):
        self.replies = list(replies)
        self.verdicts = list(verdicts)
        self.prompts: list[str] = []
        self.verify_prompts: list[str] = []

    def chat(self, messages, schema=None):
        if schema["required"] == ["verdicts"]:
            prompt = messages[-1]["content"]
            self.verify_prompts.append(prompt)
            n = len(re.findall(r"^\d+\. \[", prompt, re.M))
            real = self.verdicts.pop(0) if self.verdicts else [True] * n
            return Reply(json.dumps({"verdicts": [{"id": i, "why": "w", "real": r} for i, r in enumerate(real, 1)]}),
                         50, 10, 0.1)
        assert schema["required"] == ["findings"]
        self.prompts.append(messages[-1]["content"])
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return Reply(json.dumps({"findings": r}) if isinstance(r, list) else r, 100, 20, 0.1)


def finding(**kw):
    base = {"kind": "bug", "severity": "high", "line": 0, "code": "", "title": "T", "detail": "D", "sources": []}
    return base | kw


@pytest.fixture
def repo(tmp_path):
    init_repo(tmp_path)
    (tmp_path / "task1").mkdir()
    (tmp_path / "task1" / "README.md").write_text("# Task 1\n\nRows are saved by store.py.\n")
    (tmp_path / "task1" / "store.py").write_text(
        "def save_rows(rows, path):\n    with open(path, 'w') as f:\n        f.write(str(rows))\n\n\n"
        "def first(rows, k):\n    return rows[:k]\n")
    (tmp_path / "task1" / "app.py").write_text(
        "from store import save_rows, first\n\n\ndef main():\n    save_rows([1], 'x')\n    return first([1, 2], 1)\n")
    commit(tmp_path, "base")
    git(tmp_path, "checkout", "-q", "-b", "pr")
    store = tmp_path / "task1" / "store.py"
    store.write_text(store.read_text().replace("def save_rows(rows, path)", "def write_rows(rows, path)")
                     .replace("rows[:k]", "rows[:k - 1]"))
    (tmp_path / "task1" / "README.md").write_text("# Task 1\n\nRows are written by store.py.\n")
    (tmp_path / "task1" / "uv.lock").write_text("lock\n")
    commit(tmp_path, "rename save_rows")
    return tmp_path


def test_review_checks_lines_and_citations_and_skips_non_code(repo):
    change = local(repo, "main", "pr")
    llm = ScriptedLLM([
        finding(line=7, code="return rows[:k - 1]", title="Off by one in first", sources=[1, 9]),
        finding(line=40, code="def write_rows(rows, path):", title="save_rows renamed, app.py still calls it"),
        finding(kind="nonsense", severity="?", line=99, title="Vague", detail="Something"),
        finding(line=7, title="off by one in first()"),  # a duplicate of the first
    ])
    review = Reviewer(llm).review(change)
    assert review.skipped == [("task1/README.md", "documentation"), ("task1/uv.lock", "lockfile")]
    (fr,) = review.files
    assert fr.path == "task1/store.py" and not fr.error
    bugs = [f for f in fr.findings if f.kind == "bug"]
    assert [(f.line, f.title) for f in bugs] == [(7, "Off by one in first"), (1, "save_rows renamed, app.py still calls it")]
    assert bugs[0].sources == []  # no passages without an index: [1] and [9] both point nowhere
    assert bugs[1].note == "line moved from 40"  # found by the quoted code
    (rec,) = [f for f in fr.findings if f.kind == "recommendation"]
    assert (rec.severity, rec.line, rec.note) == ("low", None, "line 99 is not in the diff")
    assert fr.dropped == 1

    prompt = llm.prompts[0]
    assert "- task1/store.py (modified, +2 -2)   <- under review" in prompt
    assert "`save_rows` is still used at:" in prompt and "task1/app.py:5: save_rows([1], 'x')" in prompt
    assert "    7 +     return rows[:k - 1]" in prompt


def test_verification_drops_what_it_rejects_and_keeps_the_rest(repo):
    change = local(repo, "main", "pr")
    llm = ScriptedLLM([finding(line=7, title="Off by one"), finding(line=1, title="x is not defined", kind="bug")],
                      verdicts=[[True, False]])
    fr = Reviewer(llm).review(change).files[0]
    assert [f.title for f in fr.findings] == ["Off by one"]
    assert fr.rejected[0]["title"] == "x is not defined" and fr.rejected[0]["why"] == "w"
    assert "1. [bug, line 7] Off by one. D" in llm.verify_prompts[0]
    unverified = Reviewer(ScriptedLLM([finding(line=1, title="x is not defined")], verdicts=[[False]]), verify=False)
    assert [f.title for f in unverified.review(change).findings] == ["x is not defined"]
    nothing = ScriptedLLM([])
    Reviewer(nothing).review(change)
    assert nothing.verify_prompts == []  # no findings, no second call


def test_a_model_error_or_bad_json_is_reported_per_file(repo):
    change = local(repo, "main", "pr")
    review = Reviewer(ScriptedLLM(LLMError("ollama unreachable"))).review(change)
    assert review.files[0].error == "ollama unreachable" and not review.findings
    review = Reviewer(ScriptedLLM("not json")).review(change)
    assert review.files[0].error.startswith("the model's answer is not valid JSON")


def test_files_over_the_limit_are_listed_not_reviewed(repo):
    for i in range(3):
        (repo / "task1" / f"m{i}.py").write_text("x = 1\n" * (i + 1))
    commit(repo, "more")
    review = Reviewer(ScriptedLLM([], [], []), max_files=3).review(local(repo, "main", "pr"))
    assert [fr.path for fr in review.files] == ["task1/m1.py", "task1/m2.py", "task1/store.py"]
    assert ("task1/m0.py", "over the limit of 3 files") in review.skipped


def test_prompt_is_trimmed_code_passages_first(repo):
    from devreview.retrieve import Hit
    change = local(repo, "main", "pr")
    ctx = build_context(change, next(f for f in change.files if f.path == "task1/store.py"))
    ctx.passages = [Hit("a#0", "task1/README.md", "task1", "Task 1", "doc", 0, 0, "d" * 900, 0.5),
                    Hit("b#0", "task1/app.py", "task1", "main", "code", 4, 6, "c" * 900, 0.5)]
    full, shown = user_prompt(change, ctx)
    assert len(shown) == 2 and "[2] task1/app.py:4-6 › main" in full
    trimmed, shown = user_prompt(change, ctx, limit=len(full) - 100)
    assert [h.kind for h in shown] == ["doc"] and "[2]" not in trimmed


@pytest.mark.parametrize("text, n", [
    ('{"findings": []}', 0),
    ('```json\n{"findings": [{"title": "x"}]}\n```', 1),
    ('[{"title": "x"}, 3]', 1),
    ("nope", None),
])
def test_parse_findings(text, n):
    out = parse_findings(text)
    assert (len(out) if out is not None else None) == n


DIFF = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -10,3 +10,4 @@\n x = 1\n+y = compute(x)\n z = 2\n+w = y\n"


@pytest.mark.parametrize("line, code, expected", [
    (11, "y = compute(x)", (11, "")),
    (11, "", (11, "")),
    (20, "w = y", (13, "line moved from 20")),
    (14, "", (13, "line moved from 14")),
    (50, "", (None, "line 50 is not in the diff")),
    (0, "compute(x)", (11, "")),
    (12, "compute(x)", (11, "line moved from 12")),  # on a shown line, but the code is elsewhere
    (12, "something else entirely", (12, "")),  # quote not found anywhere: trust the line
])
def test_place(line, code, expected):
    assert place(parse(DIFF)[0], line, code) == expected


def test_merge_keeps_one_per_line_and_the_higher_severity():
    a = Finding("a.py", "bug", "low", 3, "Index out of range", "d", sources=["x"])
    b = Finding("a.py", "bug", "high", 3, "Something else", "d", sources=["y"])
    c = Finding("a.py", "recommendation", "low", None, "Add a test", "d")
    d = Finding("a.py", "recommendation", "low", 9, "add a test", "d")
    e = Finding("a.py", "architecture", "medium", 3, "Inconsistent with the rest", "d")
    f = Finding("a.py", "architecture", "medium", 4, "Breaks isolation", "d")
    out = merge([c, e, a, b, d, f])
    assert [(f.kind, f.severity, f.title) for f in out] == [
        ("bug", "high", "Something else"), ("architecture", "medium", "Breaks isolation"),
        ("recommendation", "low", "Add a test")]
    assert out[0].sources == ["y", "x"]
    on_a_line = merge([Finding("a.py", "recommendation", "low", 5, "Update the callers", "d"),
                       Finding("a.py", "architecture", "medium", 5, "Renamed but still used", "d")])
    assert [f.kind for f in on_a_line] == ["architecture"]


def test_check_normalizes_whitespace_and_unknown_values():
    fd = parse(DIFF)[0]
    f = check(fd, None, [], {"title": "  Two\n words ", "kind": "x", "severity": "y", "line": "11"})
    assert (f.title, f.kind, f.severity, f.line) == ("Two words", "recommendation", "low", None)
    assert check(fd, None, [], {"title": "", "detail": ""}) is None


def test_markdown_comment(repo):
    change = local(repo, "main", "pr")
    review = Reviewer(ScriptedLLM([finding(line=7, title="Off <by> one", sources=[])])).review(change)
    md = markdown(review, "https://github.com/o/r")
    assert md.startswith(MARKER + "\n## Automated review")
    assert "### Potential bugs (1)" in md and "### Recommendations" not in md
    assert f"[`task1/store.py:7`](https://github.com/o/r/blob/{change.head_sha}/task1/store.py#L7)" in md
    assert "**Off &lt;by&gt; one**" in md
    assert "`task1/uv.lock` (lockfile)" in md
    assert "still used after removal: `save_rows` (2)" in md
    assert "No issues" in markdown(Reviewer(ScriptedLLM([])).review(change))
    assert "Off <by> one" in terminal(review, color=False)


def test_post_creates_then_edits(monkeypatch, repo):
    from devreview import github
    calls = []
    existing = {"id": None}

    def fake_gh(root, *args, body=None):
        calls.append((args, body))
        if "--paginate" in args:
            return json.dumps({"id": existing["id"], "body": MARKER + " old"}) if existing["id"] else ""
        return json.dumps({"html_url": "https://github.com/o/r/pull/1#issuecomment-5"})

    monkeypatch.setattr(github, "gh", fake_gh)
    github.post(Path(repo), 1, MARKER + " new")
    assert calls[-1][0][:3] == ("api", "-X", "POST") and calls[-1][1] == {"body": MARKER + " new"}
    existing["id"] = 5
    github.post(Path(repo), 1, MARKER + " newer")
    assert calls[-1][0][:4] == ("api", "-X", "PATCH", "repos/{owner}/{repo}/issues/comments/5")


def test_repo_url(repo):
    from devreview.github import repo_url
    git(repo, "remote", "add", "origin", "git@github.com:atabekm/advchal9.git")
    assert repo_url(repo) == "https://github.com/atabekm/advchal9"
