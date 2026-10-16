"""A project root seen through a staging overlay: reads, search and outlines over the files, edits
that stay in memory until the client applies them.

Every path is resolved inside the root; `..`, absolute paths elsewhere and symlinks that leave the
root are refused, and `.git/` is off limits. Nothing is ever deleted. Later reads see staged edits,
so the model works on its own changes as if they were on disk.
"""

from __future__ import annotations

import ast
import difflib
import fnmatch
import re
from pathlib import Path, PurePosixPath

SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache",
             "node_modules", ".idea", ".vscode"}
MAX_FILE_BYTES = 512_000
MAX_READ_LINES = 300
MAX_LIST = 300
MAX_MATCHES = 60
MAX_LINE = 220


class WorkspaceError(Exception):
    pass


def _numbered(lines: list[str], first: int) -> str:
    width = len(str(first + len(lines) - 1))
    return "\n".join(f"{n:>{width}}| {line}" for n, line in enumerate(lines, first))


def _clip(line: str) -> str:
    line = line.rstrip("\n")
    return line if len(line) <= MAX_LINE else line[:MAX_LINE] + " …"


def _globs(pattern: str) -> list[str]:
    """Models write several globs in one argument ("*.py|*.md", "*.py, .env.example"): split them."""
    return [p for p in re.split(r"[|,;\s]+", pattern.strip()) if p]


def _glob_match(rel: str, pattern: str) -> bool:
    """`**/*.py` style globs; a pattern without a slash matches the file name anywhere."""
    for one in _globs(pattern):
        if "/" not in one:
            if fnmatch.fnmatchcase(PurePosixPath(rel).name, one):
                return True
        elif PurePosixPath(rel).full_match(one) or fnmatch.fnmatchcase(rel, one):
            return True
    return False


_NUMBERED = re.compile(r"^\s*\d+\| ?")


class Workspace:
    def __init__(self, root: Path | str):
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise WorkspaceError(f"not a directory: {root}")
        self.staged: dict[str, str] = {}      # path -> new content
        self.read_paths: set[str] = set()     # files the model has read (write_file needs it)

    # paths

    def rel(self, path: str) -> str:
        """The path relative to the root, as posix, or WorkspaceError if it points outside."""
        raw = (path or ".").strip().strip('"').strip("'")
        p = Path(raw)
        full = (p if p.is_absolute() else self.root / p).resolve()
        if not full.is_relative_to(self.root):
            raise WorkspaceError(f"{path!r} is outside the project root")
        rel = full.relative_to(self.root).as_posix()
        if rel.split("/")[0] == ".git":
            raise WorkspaceError(".git/ is not accessible; use the git_* tools")
        return "" if rel == "." else rel

    def _disk_files(self) -> list[str]:
        out = []
        stack = [self.root]
        while stack:
            d = stack.pop()
            for entry in d.iterdir():
                if entry.is_symlink() and not entry.resolve().is_relative_to(self.root):
                    continue
                if entry.is_dir():
                    if entry.name not in SKIP_DIRS and not entry.name.endswith(".egg-info"):
                        stack.append(entry)
                elif entry.is_file():
                    out.append(entry.relative_to(self.root).as_posix())
        return out

    def files(self) -> list[str]:
        return sorted(set(self._disk_files()) | set(self.staged))

    def exists(self, rel: str) -> bool:
        return rel in self.staged or (rel != "" and (self.root / rel).is_file())

    def original(self, rel: str) -> str | None:
        """The content on disk, or None for a file that only exists staged."""
        f = self.root / rel
        if not f.is_file():
            return None
        if f.stat().st_size > MAX_FILE_BYTES:
            raise WorkspaceError(f"{rel} is too large ({f.stat().st_size} bytes)")
        try:
            return f.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise WorkspaceError(f"{rel} is a binary file") from None

    def text(self, rel: str) -> str:
        if rel in self.staged:
            return self.staged[rel]
        if not self.exists(rel):
            if rel and (self.root / rel).is_dir():
                raise WorkspaceError(f"{rel} is a directory; use list_files")
            raise WorkspaceError(f"no file {rel!r}" + self._suggest(rel))
        return self.original(rel)

    def _suggest(self, rel: str) -> str:
        name = PurePosixPath(rel).name
        near = [f for f in self.files() if PurePosixPath(f).name == name]
        near = near or difflib.get_close_matches(rel, self.files(), n=3, cutoff=0.6)
        return f"; did you mean {', '.join(near[:3])}?" if near else ""

    def _status(self, rel: str) -> str:
        if rel not in self.staged:
            return ""
        return " [new, staged]" if not (self.root / rel).is_file() else " [modified, staged]"

    # reading

    def list_files(self, path: str = ".", pattern: str | None = None) -> str:
        base = self.rel(path)
        if base and not (self.root / base).is_dir() and not any(f.startswith(base + "/") for f in self.staged):
            raise WorkspaceError(f"no directory {base!r}" + self._suggest(base))
        prefix = base + "/" if base else ""
        found = [f for f in self.files() if f.startswith(prefix)]
        if pattern:
            found = [f for f in found if _glob_match(f, pattern) or _glob_match(f[len(prefix):], pattern)]
        if not found:
            top = sorted({f[len(prefix):].split("/")[0] + ("/" if "/" in f[len(prefix):] else "")
                          for f in self.files() if f.startswith(prefix)})
            return (f"no files match {pattern!r} under {base or '.'!r}. Patterns are globs such as '*.py' or "
                    f"'docs/*.md'. It contains: {', '.join(top) or 'nothing'}")
        lines = []
        for f in found[:MAX_LIST]:
            try:
                n = len(self.text(f).splitlines())
                size = f"{n} lines"
            except WorkspaceError:
                size = "binary"
            lines.append(f"{f}  ({size}){self._status(f)}")
        more = f"\n… {len(found) - MAX_LIST} more; narrow it with path or pattern" if len(found) > MAX_LIST else ""
        return f"{len(found)} files\n" + "\n".join(lines) + more

    def read_file(self, path: str, start: int = 1, end: int | None = None) -> str:
        rel = self.rel(path)
        lines = self.text(rel).splitlines()
        self.read_paths.add(rel)
        total = len(lines)
        if total == 0:
            return f"{rel} is empty"
        start = max(1, int(start or 1))
        if start > total:
            raise WorkspaceError(f"{rel} has {total} lines; start={start} is past the end")
        end = min(total, int(end) if end else total, start + MAX_READ_LINES - 1)
        head = f"{rel}{self._status(rel)} · lines {start}-{end} of {total}"
        more = f"\n… {total - end} more lines: read_file({rel!r}, start={end + 1})" if end < total else ""
        return f"{head}\n{_numbered([_clip(x) for x in lines[start - 1:end]], start)}{more}"

    def search(self, pattern: str, path: str = ".", glob: str | None = None, ignore_case: bool = False,
               literal: bool = False) -> str:
        if not pattern:
            raise WorkspaceError("empty pattern")
        flags = re.IGNORECASE if ignore_case else 0
        note = ""
        try:
            rx = re.compile(re.escape(pattern) if literal else pattern, flags)
        except re.error as e:
            rx = re.compile(re.escape(pattern), flags)
            note = f"(not a valid regex: {e}; searched for the literal text)\n"
        base = self.rel(path)
        if base and self.exists(base):
            scope = [base]
        else:
            prefix = base + "/" if base else ""
            scope = [f for f in self.files() if f.startswith(prefix)]
        if glob:
            scope = [f for f in scope if _glob_match(f, glob)]
        hits, files_hit = [], set()
        for f in scope:
            try:
                text = self.text(f)
            except WorkspaceError:
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    hits.append(f"{f}:{n}: {_clip(line.strip())}")
                    files_hit.add(f)
        if not hits:
            return note + (f"no matches for {pattern!r} in {len(scope)} files. If you guessed a name, search for a "
                           "shorter part of it (ignore_case=true), or read the file where it should be")
        head = f"{len(hits)} matches in {len(files_hit)} files"
        more = f"\n… {len(hits) - MAX_MATCHES} more; narrow it with path or glob" if len(hits) > MAX_MATCHES else ""
        return note + head + "\n" + "\n".join(hits[:MAX_MATCHES]) + more

    def outline(self, path: str) -> str:
        rel = self.rel(path)
        text = self.text(rel)
        if rel.endswith(".py"):
            try:
                tree = ast.parse(text)
            except SyntaxError as e:
                raise WorkspaceError(f"{rel} does not parse: {e}") from None
            out = [f"{rel} · {len(text.splitlines())} lines"]
            doc = ast.get_docstring(tree)
            if doc:
                out.append(f'module docstring: "{doc.splitlines()[0]}"')
            for node in tree.body:
                out += _py_outline(node, "")
            return "\n".join(out)
        if rel.endswith((".md", ".markdown")):
            heads = []
            fence = False
            for n, line in enumerate(text.splitlines(), 1):
                if line.lstrip().startswith("```"):
                    fence = not fence
                elif not fence and re.match(r"#{1,6} ", line):
                    heads.append(f"L{n} {line.strip()}")
            return f"{rel} · {len(text.splitlines())} lines\n" + ("\n".join(heads) or "no headings")
        raise WorkspaceError(f"outline works on .py and .md files; use read_file for {rel}")

    # writing (staged)

    def edit_file(self, path: str, old: str, new: str, replace_all: bool = False) -> str:
        rel = self.rel(path)
        text = self.text(rel)
        if old == "":
            raise WorkspaceError("old is empty; to add text, include a line next to it in old and in new")
        if old == new:
            raise WorkspaceError("old and new are the same; new must be the text as it should read after the change")
        count = text.count(old)
        if count == 0 and _stripped(old) is not None:
            # `old` pasted from read_file with its "12| " prefixes
            old, new = _stripped(old), _stripped(new) if _stripped(new) is not None else new
            count = text.count(old)
            if old == new:
                raise WorkspaceError("old and new are the same once the line numbers are removed")
        if count == 0:
            old, new, count = _match_loosely(text, old, new)
        if count == 0:
            marks = [x for x in old.splitlines() if re.match(r"[+-](\s|$)", x)]
            hint = (" (lines starting with + or - look like diff markers; they are not part of the file)"
                    if marks else "")
            raise WorkspaceError(f"old text not found in {rel}{hint}" + self._closest(text, old))
        if count > 1 and not replace_all:
            lines = [text[:m.start()].count("\n") + 1 for m in re.finditer(re.escape(old), text)]
            raise WorkspaceError(f"old text occurs {count} times in {rel} (lines {', '.join(map(str, lines))}); "
                                 "include more surrounding lines to make it unique, or set replace_all")
        at = text.index(old)
        result = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        self._stage(rel, result)
        self.read_paths.add(rel)
        first = text[:at].count("\n") + 1
        last = first + new.count("\n")
        shown = result.splitlines()
        lo, hi = max(1, first - 2), min(len(shown), last + 2)
        what = f"{count} replacements" if replace_all and count > 1 else f"lines {first}-{last}"
        kept = set(new.splitlines())
        removed = [x for x in old.splitlines() if x not in kept and x.strip()]
        gone = ("\nremoved (no longer in the file):\n" + "\n".join(f"- {x}" for x in removed[:8])) if removed else ""
        return f"edited {rel} ({what}){gone}\nnow:\n{_numbered(shown[lo - 1:hi], lo)}"

    def insert_lines(self, path: str, after: str | int, text: str) -> str:
        """Insert `text` as new lines after the line `after`: its number, its text (exact, or with other
        whitespace), or a piece of text found in exactly one line. "" or 0 means the top."""
        rel = self.rel(path)
        content = self.text(rel)
        if not text.strip():
            raise WorkspaceError("text is empty")
        block = text if text.endswith("\n") else text + "\n"
        lines = content.splitlines(keepends=True)
        after = str(after)
        if after.strip() in ("", "0"):
            at = 0
        elif after.strip().isdigit():
            at = int(after.strip())
            if at > len(lines):
                raise WorkspaceError(f"after: {rel} has {len(lines)} lines")
        else:
            anchor = _stripped(after) if _stripped(after) is not None else after
            want = [x.rstrip() for x in anchor.rstrip("\n").split("\n")]
            starts = [i for i in range(len(lines) - len(want) + 1)
                      if [x.rstrip("\r\n").rstrip() for x in lines[i:i + len(want)]] == want]
            if not starts:   # forgive indentation differences in the anchor
                starts = [i for i in range(len(lines) - len(want) + 1)
                          if [x.strip() for x in lines[i:i + len(want)]] == [w.strip() for w in want]]
            if not starts and len(want) == 1:   # a piece of one line, e.g. a table row without its pipes
                starts = [i for i, x in enumerate(lines) if want[0].strip() in x]
            if not starts:
                raise WorkspaceError(f"after: no such line in {rel}; give its line number or copy it from "
                                     "read_file" + self._closest(content, anchor))
            if len(starts) > 1:
                raise WorkspaceError(f"after: the line occurs {len(starts)} times in {rel} (lines "
                                     f"{', '.join(str(s + 1) for s in starts)}); give two lines to make it unique")
            at = starts[0] + len(want)
        if at and not lines[at - 1].endswith("\n"):
            lines[at - 1] += "\n"
        result = "".join(lines[:at]) + block + "".join(lines[at:])
        self._stage(rel, result)
        self.read_paths.add(rel)
        first, last = at + 1, at + block.count("\n")
        shown = result.splitlines()
        lo, hi = max(1, first - 2), min(len(shown), last + 2)
        return f"inserted lines {first}-{last} in {rel}; now:\n{_numbered(shown[lo - 1:hi], lo)}"

    def _closest(self, text: str, old: str) -> str:
        first = next((x.strip() for x in old.splitlines() if x.strip()), "")
        lines = text.splitlines()
        best = difflib.get_close_matches(first, [x.strip() for x in lines], n=1, cutoff=0.5)
        if not best:
            return "; read the file again and copy the text exactly"
        n = next(i for i, x in enumerate(lines, 1) if x.strip() == best[0])
        lo = max(1, n - 1)
        return (f"; the closest line is {n}. Copy it exactly from the file (indentation included):\n"
                + _numbered(lines[lo - 1:n + 2], lo))

    def write_file(self, path: str, content: str) -> str:
        rel = self.rel(path)
        if not rel or rel.endswith("/"):
            raise WorkspaceError("give a file path")
        existed = self.exists(rel)
        if existed and rel not in self.read_paths:
            raise WorkspaceError(f"{rel} exists and you haven't read it; read it first, "
                                 "or change part of it with edit_file")
        if not existed and (self.root / rel).exists():
            raise WorkspaceError(f"{rel} is a directory")
        if content and not content.endswith("\n"):
            content += "\n"
        self._stage(rel, content)
        self.read_paths.add(rel)
        n = len(content.splitlines())
        return f"{'replaced' if existed else 'created'} {rel} ({n} lines, staged)"

    def _stage(self, rel: str, content: str) -> None:
        if self.original(rel) == content:
            self.staged.pop(rel, None)   # an edit undone: nothing to apply
        else:
            self.staged[rel] = content

    # the client's side

    def changes(self) -> list[tuple[str, str | None, str]]:
        return [(rel, self.original(rel), self.staged[rel]) for rel in sorted(self.staged)]

    def diff(self) -> str:
        """A unified diff of the staged changes, with git-style a/ b/ paths (`git apply` takes it)."""
        out = []
        for rel, old, new in self.changes():
            a = old.splitlines(keepends=True) if old is not None else []
            b = new.splitlines(keepends=True)
            if old is None:
                out.append(f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n")
            else:
                out.append(f"diff --git a/{rel} b/{rel}\n")
            body = difflib.unified_diff(a, b, "/dev/null" if old is None else f"a/{rel}", f"b/{rel}", n=3)
            for line in body:
                out.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
        return "".join(out)

    def apply(self) -> list[str]:
        written = []
        for rel, _old, new in self.changes():
            target = self.root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(new, encoding="utf-8")
            written.append(rel)
        self.staged.clear()
        return written

    def discard(self) -> int:
        n = len(self.staged)
        self.staged.clear()
        return n


def _indent(line: str) -> str:
    return line[:len(line) - len(line.lstrip())]


def _match_loosely(text: str, old: str, new: str) -> tuple[str, str, int]:
    """Find `old` line by line ignoring indentation and trailing spaces. If exactly one block matches,
    return the file's real text for it, and `new` re-indented by what the model left out."""
    want = [x.strip() for x in old.strip("\n").split("\n")]
    lines = text.split("\n")
    hits = [i for i in range(len(lines) - len(want) + 1) if [x.strip() for x in lines[i:i + len(want)]] == want]
    if len(hits) != 1 or not any(want):
        return old, new, 0
    real = lines[hits[0]:hits[0] + len(want)]
    first_real = next(x for x in real if x.strip())
    first_old = next(x for x in old.strip("\n").split("\n") if x.strip())
    pad = _indent(first_real)[len(_indent(first_old)):] if _indent(first_real).startswith(_indent(first_old)) else ""
    new_lines = [pad + x if x.strip() else x for x in new.strip("\n").split("\n")]
    return "\n".join(real), "\n".join(new_lines), 1


def _stripped(text: str) -> str | None:
    """`text` without read_file's "12| " prefixes, if every non-empty line has one."""
    lines = text.split("\n")
    body = [x for x in lines if x.strip()]
    if body and all(_NUMBERED.match(x) for x in body):
        return "\n".join(_NUMBERED.sub("", x, count=1) for x in lines)
    return None


def _py_outline(node: ast.AST, indent: str) -> list[str]:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        kind = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
        ret = f" -> {ast.unparse(node.returns)}" if node.returns else ""
        doc = ast.get_docstring(node)
        tail = f' — "{doc.splitlines()[0]}"' if doc else " — no docstring"
        return [f"{indent}L{node.lineno} {kind} {node.name}({ast.unparse(node.args)}){ret}{tail}"]
    if isinstance(node, ast.ClassDef):
        bases = f"({', '.join(ast.unparse(b) for b in node.bases)})" if node.bases else ""
        doc = ast.get_docstring(node)
        tail = f' — "{doc.splitlines()[0]}"' if doc else " — no docstring"
        out = [f"{indent}L{node.lineno} class {node.name}{bases}{tail}"]
        for child in node.body:
            out += _py_outline(child, indent + "  ")
        return out
    if isinstance(node, (ast.Import, ast.ImportFrom)) and not indent:
        return [f"L{node.lineno} {ast.unparse(node)}"]
    if isinstance(node, (ast.Assign, ast.AnnAssign)) and not indent:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = [ast.unparse(t) for t in targets]
        if any(n.isupper() or n.startswith("__") for n in names):
            return [f"L{node.lineno} {' = '.join(names)} = …"]
    return []
