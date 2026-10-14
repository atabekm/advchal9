"""What a pull request changes: the commits, the files, the hunks, and the definitions touched.

A `Change` is two commits, `base` and `head`, and the unified diff between the merge base and the
head (what GitHub shows on the PR). It can come from

- two local refs: `local(root, "main", "HEAD")`;
- a GitHub pull request: `pull_request(root, 12)`, through `gh` (fetches the PR's head);
- a patch file applied on top of a ref: `patched(root, "case.patch", "main")`. The patch becomes
  a real commit object (a temporary index, `git apply --cached`, `git commit-tree`), so it is
  reviewed exactly like a branch, and the working tree is never touched. The evaluation uses it.

`parse` reads a unified diff; `symbols` lists the definitions of a source file with their line
ranges, so a changed line can be named ("in `Store.replace_file`"), and a definition that
exists before the change and not after it is known to be removed or renamed.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from .chunk import decl_units
from .corpus import CODE_LANGS, DATA_DIRS, GitTree, git, task_of

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$")
SKIP_NAMES = {"uv.lock", "go.sum", "package-lock.json", "yarn.lock", "poetry.lock", "Cargo.lock"}
REVIEW_SUFFIXES = set(CODE_LANGS) | {".ts", ".sh", ".yml", ".yaml", ".toml", ".sql"}
REVIEW_NAMES = {"Dockerfile", "Makefile", "Modelfile"}


@dataclass
class Line:
    op: str  # " " context, "+" added, "-" removed
    old: int | None
    new: int | None
    text: str


@dataclass
class Hunk:
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    header: str
    lines: list[Line] = field(default_factory=list)

    @property
    def new_end(self) -> int:
        return self.new_start + max(self.new_len, 1) - 1


@dataclass
class FileDiff:
    path: str  # the new path ("" never: for a deleted file, its old path)
    old_path: str
    status: str  # added | modified | deleted | renamed
    binary: bool = False
    hunks: list[Hunk] = field(default_factory=list)

    @property
    def added(self) -> list[Line]:
        return [ln for h in self.hunks for ln in h.lines if ln.op == "+"]

    @property
    def removed(self) -> list[Line]:
        return [ln for h in self.hunks for ln in h.lines if ln.op == "-"]

    @property
    def new_lines(self) -> set[int]:
        """Lines of the new file that the diff shows (added or context): where a finding may point."""
        return {ln.new for h in self.hunks for ln in h.lines if ln.new is not None}

    @property
    def lang(self) -> str:
        return CODE_LANGS.get(PurePosixPath(self.path).suffix, "")

    def skip_reason(self) -> str | None:
        """Why this file is not reviewed, or None when it is."""
        p = PurePosixPath(self.path)
        if self.binary:
            return "binary"
        if p.name in SKIP_NAMES:
            return "lockfile"
        if task_of(self.path) and len(p.parts) > 2 and p.parts[1] in DATA_DIRS:
            return "data"
        if p.suffix not in REVIEW_SUFFIXES and p.name not in REVIEW_NAMES:
            return "documentation" if p.suffix in {".md", ".txt", ".rst"} else "not code"
        if self.status == "deleted":
            return "deleted"
        if not self.added:
            return "only deletions"
        return None


@dataclass
class Change:
    """A pull request, or anything shaped like one."""
    root: Path
    base: GitTree  # the merge base: what the PR starts from
    head: GitTree
    files: list[FileDiff]
    title: str = ""
    body: str = ""
    number: int | None = None
    url: str = ""
    commits: list[str] = field(default_factory=list)  # subjects, oldest first

    @property
    def head_sha(self) -> str:
        return self.head.sha


def parse(diff: str) -> list[FileDiff]:
    files: list[FileDiff] = []
    cur: FileDiff | None = None
    hunk: Hunk | None = None
    old_no = new_no = 0
    for raw in diff.splitlines():
        if raw.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", raw)
            old, new = (m.group(1), m.group(2)) if m else ("", "")
            cur = FileDiff(new, old, "modified")
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        if hunk is None or not raw[:1] in " +-\\":
            if raw.startswith("new file mode"):
                cur.status = "added"
            elif raw.startswith("deleted file mode"):
                cur.status = "deleted"
                cur.path = cur.old_path
            elif raw.startswith("rename from "):
                cur.old_path, cur.status = raw[12:], "renamed"
            elif raw.startswith("rename to "):
                cur.path = raw[10:]
            elif raw.startswith("Binary files") or raw.startswith("GIT binary patch"):
                cur.binary = True
            elif m := HUNK_RE.match(raw):
                a, b, c, d = m.group(1), m.group(2), m.group(3), m.group(4)
                hunk = Hunk(int(a), int(b) if b is not None else 1, int(c), int(d) if d is not None else 1,
                            m.group(5).strip())
                cur.hunks.append(hunk)
                old_no, new_no = hunk.old_start, hunk.new_start
            continue
        op, text = raw[:1], raw[1:]
        if op == "\\":  # "\ No newline at end of file"
            continue
        if op == "+":
            hunk.lines.append(Line("+", None, new_no, text))
            new_no += 1
        elif op == "-":
            hunk.lines.append(Line("-", old_no, None, text))
            old_no += 1
        else:
            hunk.lines.append(Line(" ", old_no, new_no, text))
            old_no += 1
            new_no += 1
    return files


# --- where a change comes from -------------------------------------------------------------------

def diff_between(root: Path, base: str, head: str) -> list[FileDiff]:
    return parse(git(root, "diff", "-M", "--no-color", "--no-ext-diff", base, head))


def local(root: Path, base: str = "main", head: str = "HEAD") -> Change:
    head_tree = GitTree(root, head)
    merge_base = git(root, "merge-base", base, head_tree.sha).strip()
    subjects = git(root, "log", "--reverse", "--format=%s", f"{merge_base}..{head_tree.sha}").splitlines()
    return Change(root, GitTree(root, merge_base), head_tree, diff_between(root, merge_base, head_tree.sha),
                  title=subjects[-1] if len(subjects) == 1 else f"{head} against {base}", commits=subjects)


def pull_request(root: Path, number: int) -> Change:
    """A GitHub PR of this repository, with `gh`. Its head is fetched, the checkout isn't touched."""
    out = subprocess.run(["gh", "pr", "view", str(number), "--json",
                          "number,title,body,url,baseRefName,baseRefOid,headRefOid,commits"],
                         cwd=root, capture_output=True, text=True)
    if out.returncode != 0:
        raise GhError(f"gh pr view {number}: {out.stderr.strip()}")
    pr = json.loads(out.stdout)
    for sha, ref in ((pr["headRefOid"], f"pull/{number}/head"), (pr["baseRefOid"], pr["baseRefName"])):
        if subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=root, capture_output=True).returncode:
            git(root, "fetch", "--quiet", "origin", ref)
    merge_base = git(root, "merge-base", pr["baseRefOid"], pr["headRefOid"]).strip()
    return Change(root, GitTree(root, merge_base), GitTree(root, pr["headRefOid"]),
                  diff_between(root, merge_base, pr["headRefOid"]), title=pr["title"], body=pr.get("body") or "",
                  number=pr["number"], url=pr["url"],
                  commits=[c.get("messageHeadline", "") for c in pr.get("commits", [])])


def patched(root: Path, patch: Path, base: str = "main", title: str = "") -> Change:
    """`patch` applied on top of `base` as a commit that no branch points at."""
    base_sha = GitTree(root, base).sha
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index"),
               "GIT_AUTHOR_NAME": "devreview", "GIT_AUTHOR_EMAIL": "devreview@localhost",
               "GIT_COMMITTER_NAME": "devreview", "GIT_COMMITTER_EMAIL": "devreview@localhost"}
        run = lambda *a, **kw: subprocess.run(["git", *a], cwd=root, env=env, capture_output=True, text=True, **kw)
        for args in (("read-tree", base_sha), ("apply", "--cached", "--recount", str(patch.resolve()))):
            r = run(*args)
            if r.returncode:
                raise PatchError(f"git {args[0]} {patch.name}: {r.stderr.strip()}")
        tree = run("write-tree").stdout.strip()
        head = run("commit-tree", tree, "-p", base_sha, "-m", title or patch.stem).stdout.strip()
    return Change(root, GitTree(root, base_sha), GitTree(root, head), diff_between(root, base_sha, head),
                  title=title or patch.stem, commits=[title or patch.stem])


class GhError(RuntimeError):
    pass


class PatchError(RuntimeError):
    pass


# --- definitions -------------------------------------------------------------------------------

@dataclass(frozen=True)
class Symbol:
    name: str  # "Store.replace_file"
    start: int
    end: int

    @property
    def short(self) -> str:
        return self.name.rsplit(".", 1)[-1]


def symbols(text: str, lang: str) -> list[Symbol]:
    """Every function and class of a source file, nested ones with their qualified names. Python
    through `ast`; JavaScript, Go (and Python that doesn't parse) by top-level declarations."""
    if lang == "python":
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            pass
        else:
            out: list[Symbol] = []

            def walk(nodes, prefix):
                for n in nodes:
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        start = min([n.lineno] + [d.lineno for d in n.decorator_list])
                        out.append(Symbol(prefix + n.name, start, n.end_lineno or n.lineno))
                        walk(n.body, f"{prefix}{n.name}.")
            walk(tree.body, "")
            return out
    return [Symbol(u.name, u.start, u.end) for u in decl_units(text.splitlines()) if u.name and u.name != "(module)"]


def enclosing(syms: list[Symbol], line: int) -> Symbol | None:
    """The innermost definition containing `line`."""
    inside = [s for s in syms if s.start <= line <= s.end]
    return min(inside, key=lambda s: s.end - s.start) if inside else None


@dataclass
class Touched:
    changed: list[Symbol]  # definitions in the new file with added lines in them
    removed: list[str]  # names defined before and not after (removed or renamed)
    added: list[str]  # names defined after and not before


def touched(fd: FileDiff, old_text: str | None, new_text: str | None) -> Touched:
    if not fd.lang:
        return Touched([], [], [])
    new_syms = symbols(new_text or "", fd.lang)
    old_syms = symbols(old_text or "", fd.lang)
    changed: dict[str, Symbol] = {}
    for ln in fd.added:
        s = enclosing(new_syms, ln.new)
        if s:
            changed.setdefault(s.name, s)
    old_names, new_names = {s.name for s in old_syms}, {s.name for s in new_syms}
    return Touched(list(changed.values()), sorted(old_names - new_names), sorted(new_names - old_names))
