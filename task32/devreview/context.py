"""Everything the reviewer is shown about one changed file.

- **The diff**, every line numbered with its line in the new file, each hunk headed by the
  definition it is in.
- **The code**: the whole new file when it is short, otherwise the changed definitions and the
  lines around the hunks, numbered.
- **Passages (RAG)**: the documentation and the code of the index (built from the base branch)
  that bear on the change: the query is the path, the changed definitions' names and the added
  lines; scoped to the file's task folder plus the repository docs; docs and code searched
  separately so each gets its share.
- **Who depends on it** (plain search, `git grep -w` in the PR's head, within the task folder):
  - the call sites of every changed definition;
  - every place that still uses a name the change removed or renamed. A renamed function with a
    caller left behind is a bug a model can only see if it is shown the caller.
- **What it calls**: the definitions (in the PR's head) of functions the added lines call but the
  file doesn't define, so a wrong argument list is visible.
"""

from __future__ import annotations

import builtins
import keyword
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .corpus import CODE_LANGS, GitTree, is_test, task_of
from .diff import Change, FileDiff, Symbol, Touched, enclosing, symbols, touched
from .retrieve import Hit, Retriever

FILE_CHARS = 12_000  # a file up to this size goes in whole
DIFF_CHARS = 14_000
EXCERPT_PAD = 6  # lines of context around a hunk outside any definition
QUERY_CHARS = 1500
MAX_NAMES = 5  # changed / removed definitions whose usages are looked up
MAX_USAGES = 6  # per name
MAX_DEFINITIONS = 5
DEFINITION_LINES = 10
COMMON = {"main", "run", "get", "set", "init", "new", "close", "open", "start", "stop", "load", "save", "update",
          "add", "remove", "render", "handle", "call", "apply", "test", "setup", "teardown", "String", "Error"}
NOT_CALLS = (set(keyword.kwlist) | set(dir(builtins)) | COMMON | {
    "if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "async", "new", "super",
    "require", "console", "make", "len", "append", "cap", "panic", "recover", "func", "self", "this",
    "fmt", "Sprintf", "Printf", "Errorf", "Println", "json", "JSON", "Object", "Array", "Promise", "Math",
    "String", "Number", "Boolean", "Date", "Map", "Set", "Error", "parseInt", "parseFloat", "setTimeout",
    "fetch", "querySelector", "addEventListener", "push", "join", "split", "map", "filter", "reduce", "keys",
    "values", "items", "append", "extend", "format", "strip", "startswith", "endswith", "replace", "lower",
    "upper", "encode", "decode", "read", "write", "exists", "mkdir", "execute", "commit", "fetchall", "fetchone"})
CALL_RE = re.compile(r"(?<![\w$])([A-Za-z_$][\w$]*)\s*\(")
DEF_RE = r"(?:def|class|function\*?|func(?:\s*\([^)]*\))?|type)\s+{name}\b|(?:const|let|var)\s+{name}\s*=\s*(?:async\s*)?(?:function|\()"


@dataclass(frozen=True)
class Usage:
    path: str
    line: int
    text: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.text.strip()[:160]}"


@dataclass(frozen=True)
class Definition:
    name: str
    path: str
    line: int
    text: str  # the first lines of it, numbered


@dataclass
class FileContext:
    diff: FileDiff
    touched: Touched
    numbered_diff: str
    code: str
    code_whole: bool  # the whole file, or excerpts
    passages: list[Hit] = field(default_factory=list)
    callers: dict[str, list[Usage]] = field(default_factory=dict)  # changed definition → its call sites
    dangling: dict[str, list[Usage]] = field(default_factory=dict)  # removed name → places still using it
    definitions: list[Definition] = field(default_factory=list)

    @property
    def path(self) -> str:
        return self.diff.path


def build_context(change: Change, fd: FileDiff, retriever: Retriever | None = None) -> FileContext:
    new_text = change.head.read(fd.path) or ""
    old_text = change.base.read(fd.old_path) if fd.status != "added" else None
    t = touched(fd, old_text, new_text)
    syms = symbols(new_text, fd.lang) if fd.lang else []
    code, whole = code_view(fd, new_text, syms) if fd.status != "added" else ("", True)  # the diff is the file
    ctx = FileContext(fd, t, numbered_diff(fd, syms), code, whole)
    if fd.lang:
        scope = task_of(fd.path)
        ctx.callers = {s.name: us for s in _ranked(t.changed)[:MAX_NAMES] if fd.status != "added"
                       if s.short not in COMMON and not s.short.startswith("__")
                       and (us := usages(change.head, s.short, scope, skip=(fd.path, s.start, s.end)))}
        ctx.dangling = {n: us for n in t.removed[:MAX_NAMES * 2]
                        if (us := usages(change.head, n.rsplit(".", 1)[-1], scope, skip=None))}
        ctx.definitions = called_definitions(change.head, fd, syms, scope)
    if retriever is not None:
        ctx.passages = passages(retriever, change, fd, t)
    return ctx


def _ranked(syms: list[Symbol]) -> list[Symbol]:
    """Innermost definitions first: a changed method says more than the class around it."""
    return sorted(syms, key=lambda s: s.end - s.start)


# --- what goes in the prompt -------------------------------------------------------------------

def numbered_diff(fd: FileDiff, syms: list[Symbol], limit: int = DIFF_CHARS) -> str:
    """Hunks with the new file's line numbers: `  12 + added`, `     - removed`, `  13   context`."""
    out: list[str] = []
    size = 0
    for h in fd.hunks:
        first_new = next((ln.new for ln in h.lines if ln.op == "+"), h.new_start)
        where = enclosing(syms, first_new) if syms else None
        head = f"@@ -{h.old_start},{h.old_len} +{h.new_start},{h.new_len} @@" + (f" in {where.name}" if where else
                                                                                  f" {h.header}" if h.header else "")
        block = [head] + [f"{ln.new if ln.new is not None else '':>5} {ln.op} {ln.text}" for ln in h.lines]
        text = "\n".join(block)
        if size + len(text) > limit and out:
            out.append(f"... {len(fd.hunks) - len(out)} more hunks not shown (the diff is too long)")
            break
        out.append(text[:limit])
        size += len(text)
    return "\n".join(out)


def code_view(fd: FileDiff, text: str, syms: list[Symbol], limit: int = FILE_CHARS) -> tuple[str, bool]:
    """The new file numbered, whole when it fits; else the changed definitions (or the lines
    around a hunk outside any) merged into ranges, as many as fit."""
    lines = text.splitlines()
    if not lines:
        return "", True
    if len(text) <= limit:
        return _numbered(lines, 1, len(lines)), True
    ranges: list[tuple[int, int]] = []
    for ln in fd.added:
        s = enclosing(syms, ln.new)
        if s and s.end - s.start < 150:
            ranges.append((s.start, s.end))
        else:
            ranges.append((max(1, ln.new - EXCERPT_PAD), min(len(lines), ln.new + EXCERPT_PAD)))
    merged: list[list[int]] = []
    for a, b in sorted(ranges):
        if merged and a <= merged[-1][1] + 2:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    parts, size = [], 0
    for a, b in merged:
        part = _numbered(lines, a, b)
        if size + len(part) > limit and parts:
            parts.append("...")
            break
        parts.append(part)
        size += len(part)
    return "\n...\n".join(parts), False


def _numbered(lines: list[str], a: int, b: int) -> str:
    return "\n".join(f"{n:>5}  {lines[n - 1]}" for n in range(a, b + 1))


def passages(retriever: Retriever, change: Change, fd: FileDiff, t: Touched) -> list[Hit]:
    names = ", ".join(s.name for s in _ranked(t.changed)[:MAX_NAMES])
    added = "\n".join(ln.text for ln in fd.added if ln.text.strip())
    query = f"{fd.path}\n{names}\n{added}"[:QUERY_CHARS]
    task = task_of(fd.path)
    changed = {f.path for f in change.files} | {f.old_path for f in change.files}
    docs = retriever.search(query, tasks={task, ""} if task else (), kind="doc")
    code = retriever.search(query, tasks={task} if task else (), kind="code", exclude=changed)
    return docs + code


# --- plain search in the PR's head ---------------------------------------------------------------

def grep(tree: GitTree, name: str, scope: str) -> list[Usage]:
    """Lines of code files in the tree containing `name` as a whole word."""
    args = ["git", "grep", "-n", "-w", "-I", "--full-name", "-F", "-e", name, tree.sha, "--"]
    args += [scope] if scope else []
    out = subprocess.run(args, cwd=tree.root, capture_output=True, text=True)
    found = []
    for line in out.stdout.splitlines():
        _, path, num, text = line.split(":", 3)
        if PurePosixPath(path).suffix in CODE_LANGS:
            found.append(Usage(path, int(num), text))
    return found


def usages(tree: GitTree, name: str, scope: str, skip: tuple[str, int, int] | None) -> list[Usage]:
    """Where `name` is called, accessed or imported, its own definitions left out (and the lines
    of `skip`: a path and a line range, the definition itself). A bare word doesn't count: `sources`
    the method is not `sources` the local variable, or the word in a docstring."""
    n = re.escape(name)
    defn = re.compile(DEF_RE.format(name=n))
    use = re.compile(rf"\.{n}\b|\b{n}\s*[(.\[]|^\s*(?:from|import)\b.*\b{n}\b|\b{n}\s*(?:,\s*\w+\s*)*[,)]")
    out = []
    for u in grep(tree, name, scope):
        if defn.search(u.text) or skip and u.path == skip[0] and skip[1] <= u.line <= skip[2]:
            continue
        if u.text.lstrip().startswith(("#", "//", "*")) or not use.search(u.text):
            continue
        out.append(u)
    return out[:MAX_USAGES]


def called_definitions(tree: GitTree, fd: FileDiff, syms: list[Symbol], scope: str) -> list[Definition]:
    local = {s.short for s in syms}
    names: dict[str, None] = {}
    for ln in fd.added:
        for name in CALL_RE.findall(ln.text):
            if name not in NOT_CALLS and name not in local and len(name) > 2:
                names.setdefault(name)
    here = str(PurePosixPath(fd.path).parent)
    out: list[Definition] = []
    for name in names:
        defn = re.compile(DEF_RE.format(name=re.escape(name)))
        found = [u for u in grep(tree, name, scope) if defn.search(u.text) and not is_test(u.path)]
        # the same folder first: in a monorepo of self-contained tasks that is usually the import
        if found:
            u = min(found, key=lambda u: str(PurePosixPath(u.path).parent) != here)
            lines = (tree.read(u.path) or "").splitlines()
            snippet = _numbered(lines, u.line, min(len(lines), u.line + DEFINITION_LINES - 1))
            out.append(Definition(name, u.path, u.line, snippet))
        if len(out) >= MAX_DEFINITIONS:
            break
    return out
