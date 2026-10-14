"""The reviewer: one model call per changed file, findings checked against the diff.

For every file worth reviewing (see `FileDiff.skip_reason`), the model gets the PR's title,
description and file list, and the file's context (`context.py`): the numbered diff, the code,
the usages and definitions found by search, and the passages found by RAG. It answers JSON
constrained by a schema: a list of findings, each a `bug`, an `architecture` issue or a
`recommendation`, with the line, the code on it, and the passages it relies on.

Then, without the model:

- **the line is checked.** A finding must point at a line the diff shows. When the line number
  is off but the quoted code is on a shown line, the line is moved there; when it is off by a
  few lines, it is moved to the nearest shown line; otherwise it is cleared (the finding stays,
  about the file as a whole).
- **citations are checked.** A passage number that doesn't exist is dropped.
- **duplicates are merged**, and each file keeps at most MAX_PER_FILE findings.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field

from .context import FileContext, build_context
from .corpus import is_test
from .diff import Change, FileDiff
from .lexical import tokens
from .llm import LLMError, LocalLLM
from .retrieve import Retriever

KINDS = ("bug", "architecture", "recommendation")
SEVERITIES = ("high", "medium", "low")
MAX_FILES = 20
MAX_PER_FILE = 5
PROMPT_CHARS = 40_000  # ≈ 11k tokens of a 16k context
BODY_CHARS = 1500
PASSAGE_CHARS = 1600
NEAR = 3  # a line this close to a shown line is moved onto it

SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "severity": {"type": "string", "enum": list(SEVERITIES)},
                    "line": {"type": "integer"},
                    "code": {"type": "string"},
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "sources": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["kind", "severity", "line", "code", "title", "detail", "sources"],
            },
        },
    },
    "required": ["findings"],
}

SYSTEM = """\
You review one file of a pull request in a monorepo of small, self-contained Python, JavaScript \
and Go projects (one folder per task, each with its own README).

Report only real problems in the CHANGED lines (the ones marked + in the diff), backed by what \
you are shown. Three kinds:
- bug: the code will misbehave. Wrong logic or condition, off-by-one, a call that doesn't match \
the definition shown, a removed or renamed name that is still used elsewhere, an error swallowed \
or not handled, a resource never closed, a missing await, SQL or shell built from input, a secret \
in the code.
- architecture: the change goes against the project's structure as its documentation and code \
show it: a module depending on a layer it shouldn't, logic duplicated from an existing function, \
a design the docs contradict.
- recommendation: a concrete improvement worth making for this change (a test for risky logic, a \
simpler or safer approach). Never about style, naming, formatting, docstrings, comments or type \
hints.

Rules:
- line: the number in the left column of the diff line the finding is about. code: the code on \
that line, copied exactly. sources: the numbers [n] of the passages it relies on, or [].
- severity: high = breaks something for sure; medium = likely wrong or risky; low = minor.
- Don't guess. If you are not sure something is wrong, leave it out. A correct change gets an \
empty list: {"findings": []}.
- At most 5 findings, the most important first. Title: under 12 words. Detail: 1-3 sentences: \
what goes wrong, and the fix."""


@dataclass
class Finding:
    file: str
    kind: str
    severity: str
    line: int | None
    title: str
    detail: str
    code: str = ""
    sources: list[str] = field(default_factory=list)  # passage labels
    note: str = ""  # what the checks changed: "line moved from 40", "line cleared"


@dataclass
class FileReview:
    path: str
    findings: list[Finding] = field(default_factory=list)
    looked_at: dict = field(default_factory=dict)  # a summary of the context, for the report
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    dropped: int = 0  # findings the checks removed (duplicates, over the limit)
    error: str = ""


@dataclass
class Review:
    title: str
    base: str
    head: str
    model: str
    files: list[FileReview] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (path, reason)
    seconds: float = 0.0
    number: int | None = None
    url: str = ""

    @property
    def findings(self) -> list[Finding]:
        return [f for fr in self.files for f in fr.findings]


class Reviewer:
    def __init__(self, llm: LocalLLM, retriever: Retriever | None = None, max_files: int = MAX_FILES):
        self.llm = llm
        self.retriever = retriever
        self.max_files = max_files

    def review(self, change: Change, progress: Callable[[str], None] = lambda _: None) -> Review:
        started = time.monotonic()
        out = Review(change.title, change.base.sha, change.head.sha, self.llm.model, number=change.number,
                     url=change.url)
        todo: list[FileDiff] = []
        for fd in change.files:
            reason = fd.skip_reason()
            if reason:
                out.skipped.append((fd.path, reason))
            else:
                todo.append(fd)
        # the most changed code first, tests after; past the limit a file is listed, not reviewed
        todo.sort(key=lambda fd: (is_test(fd.path), -len(fd.added)))
        for fd in todo[self.max_files:]:
            out.skipped.append((fd.path, f"over the limit of {self.max_files} files"))
        todo = sorted(todo[:self.max_files], key=lambda fd: fd.path)
        for i, fd in enumerate(todo, start=1):
            progress(f"[{i}/{len(todo)}] {fd.path}")
            out.files.append(self.review_file(change, fd))
        out.seconds = time.monotonic() - started
        return out

    def review_file(self, change: Change, fd: FileDiff) -> FileReview:
        fr = FileReview(fd.path)
        started = time.monotonic()
        ctx = build_context(change, fd, self.retriever)
        prompt, shown = user_prompt(change, ctx)
        fr.looked_at = looked_at(ctx, shown)
        try:
            reply = self.llm.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
                                  schema=SCHEMA)
        except LLMError as e:
            fr.error = str(e)
            fr.seconds = time.monotonic() - started
            return fr
        fr.prompt_tokens, fr.completion_tokens = reply.prompt_tokens, reply.completion_tokens
        raw = parse_findings(reply.text)
        if raw is None:
            fr.error = f"the model's answer is not valid JSON: {reply.text[:200]!r}"
        else:
            checked = [check(fd, ctx, shown, r) for r in raw]
            fr.findings = merge([f for f in checked if f])[:MAX_PER_FILE]
            fr.dropped = len(raw) - len(fr.findings)
        fr.seconds = time.monotonic() - started
        return fr


# --- the prompt --------------------------------------------------------------------------------

def user_prompt(change: Change, ctx: FileContext, limit: int = PROMPT_CHARS) -> tuple[str, list]:
    """The prompt for one file, and the passages in it (numbered from 1). When it is over the
    limit, code passages go first, then doc passages, then definitions, then callers."""
    passages = list(ctx.passages)
    definitions = list(ctx.definitions)
    callers = dict(ctx.callers)
    while True:
        text = _render(change, ctx, passages, definitions, callers)
        if len(text) <= limit:
            return text, passages
        if any(h.kind == "code" for h in passages):
            idx = max(i for i, h in enumerate(passages) if h.kind == "code")
            passages.pop(idx)
        elif passages:
            passages.pop()
        elif definitions:
            definitions.pop()
        elif callers:
            callers.popitem()
        else:
            return text[:limit], passages


def _render(change: Change, ctx: FileContext, passages, definitions, callers) -> str:
    fd = ctx.diff
    parts = [f"# Pull request: {change.title}"]
    body = change.body.strip()
    if body:
        parts.append(body[:BODY_CHARS] + (" ..." if len(body) > BODY_CHARS else ""))
    if len(change.commits) > 1:
        parts.append("Commits:\n" + "\n".join(f"- {c}" for c in change.commits[-15:]))
    files = []
    for f in change.files:
        mark = "   <- under review" if f.path == fd.path else ""
        renamed = f" from {f.old_path}" if f.status == "renamed" else ""
        files.append(f"- {f.path} ({f.status}{renamed}, +{len(f.added)} -{len(f.removed)}){mark}")
    parts.append("Changed files:\n" + "\n".join(files[:60]) + ("\n- ..." if len(files) > 60 else ""))

    parts.append(f"# File under review: {fd.path} ({fd.status})")
    parts.append("## Diff (left column: the line number in the new file; + added, - removed)\n" + ctx.numbered_diff)
    if ctx.code:
        what = "The whole file after the change" if ctx.code_whole else "The changed parts of the file after the change"
        parts.append(f"## {what}\n{ctx.code}")
    if ctx.dangling:
        lines = [f"- `{name}` is still used at:\n" + "\n".join(f"    {u}" for u in us) for name, us in ctx.dangling.items()]
        parts.append("## Removed or renamed by this change, but still used elsewhere (head of the PR)\n" + "\n".join(lines))
    if callers:
        lines = [f"- `{name}`:\n" + "\n".join(f"    {u}" for u in us) for name, us in callers.items()]
        parts.append("## Where the changed definitions are used (head of the PR)\n" + "\n".join(lines))
    if definitions:
        parts.append("## Definitions of what the new lines call (head of the PR)\n" + "\n\n".join(
            f"`{d.name}` in {d.path}:\n{d.text}" for d in definitions))
    if passages:
        parts.append("## Documentation and related code (main branch)\n" + "\n\n".join(
            f"[{i}] {h.label}\n{_clip(h.text)}" for i, h in enumerate(passages, start=1)))
    parts.append(f"Review the changes to `{fd.path}`. Answer with JSON: {{\"findings\": [...]}}.")
    return "\n\n".join(parts)


def _clip(text: str, limit: int = PASSAGE_CHARS) -> str:
    return text if len(text) <= limit else text[:limit].rsplit("\n", 1)[0] + "\n..."


def looked_at(ctx: FileContext, shown: list) -> dict:
    return {
        "changed": [s.name for s in ctx.touched.changed][:8],
        "removed": ctx.touched.removed[:8],
        "dangling": {k: [str(u) for u in v] for k, v in ctx.dangling.items()},
        "callers": {k: len(v) for k, v in ctx.callers.items()},
        "definitions": [f"{d.name} ({d.path}:{d.line})" for d in ctx.definitions],
        "passages": [h.label for h in shown],
        "code": "whole file" if ctx.code_whole else "excerpts",
    }


# --- the answer, checked -----------------------------------------------------------------------

def parse_findings(text: str) -> list[dict] | None:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        data = json.loads(text)
    except ValueError:
        return None
    items = data.get("findings") if isinstance(data, dict) else data
    return [x for x in items if isinstance(x, dict)] if isinstance(items, list) else None


def check(fd: FileDiff, ctx: FileContext, passages: list, raw: dict) -> Finding | None:
    title = " ".join(str(raw.get("title") or "").split())
    detail = " ".join(str(raw.get("detail") or "").split())
    if not title and not detail:
        return None
    kind = raw.get("kind") if raw.get("kind") in KINDS else "recommendation"
    severity = raw.get("severity") if raw.get("severity") in SEVERITIES else "low"
    code = str(raw.get("code") or "").strip()
    line, note = place(fd, raw.get("line"), code)
    sources = []
    for n in raw.get("sources") or []:
        if isinstance(n, int) and 1 <= n <= len(passages) and passages[n - 1].label not in sources:
            sources.append(passages[n - 1].label)
    return Finding(fd.path, kind, severity, line, title or detail[:80], detail, code, sources, note)


def place(fd: FileDiff, line, code: str) -> tuple[int | None, str]:
    """The line a finding belongs on, and a note when it isn't the one the model gave."""
    shown = fd.new_lines
    text_of = {ln.new: ln.text for h in fd.hunks for ln in h.lines if ln.new is not None}
    given = line if isinstance(line, int) and line > 0 else None
    if given in shown and (not code or _same(code, text_of[given]) or not _found(code, text_of)):
        return given, ""
    if code:
        matches = [n for n in sorted(shown) if _same(code, text_of[n])]
        if matches:
            best = min(matches, key=lambda n: abs(n - given)) if given else matches[0]
            return best, ("" if best == given else f"line moved from {given}" if given else "")
    if given:
        near = [n for n in shown if abs(n - given) <= NEAR]
        if near:
            best = min(near, key=lambda n: abs(n - given))
            return best, f"line moved from {given}"
        return None, f"line {given} is not in the diff"
    return None, ""


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def _same(code: str, line: str) -> bool:
    """The quoted code is (part of) this line, or this line is part of it (a multi-line quote)."""
    a, b = _norm(code), _norm(line)
    return bool(a and b) and (a in b or len(b) >= 8 and b in a)


def _found(code: str, text_of: dict) -> bool:
    return any(_same(code, t) for t in text_of.values())


def merge(findings: list[Finding]) -> list[Finding]:
    """One finding per (kind, line, similar title); then bugs first, by severity."""
    out: list[Finding] = []
    for f in findings:
        dup = next((g for g in out if g.kind == f.kind and (g.line == f.line and g.line is not None or
                                                             _similar(g.title, f.title))), None)
        if dup:
            if SEVERITIES.index(f.severity) < SEVERITIES.index(dup.severity):
                dup.severity = f.severity
            dup.sources += [s for s in f.sources if s not in dup.sources]
            continue
        out.append(f)
    return sorted(out, key=lambda f: (KINDS.index(f.kind), SEVERITIES.index(f.severity)))


def _similar(a: str, b: str) -> bool:
    ta, tb = set(tokens(a)), set(tokens(b))
    return bool(ta and tb) and len(ta & tb) / len(ta | tb) >= 0.6


def to_json(review: Review) -> dict:
    return asdict(review)
