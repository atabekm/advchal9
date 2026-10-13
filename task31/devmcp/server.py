"""`devmcp`: an MCP server (stdio) that shows a git repository's live state.

Tools, all read-only:

    git_branch    the current branch, its upstream, ahead/behind
    git_status    changed, staged and untracked files
    git_log       recent commits, optionally for one path
    git_diff      the diff of the working tree, or of the branch against a base
    list_files    the files under a directory (git's view: no ignored files), as a tree
    read_file     a file's lines, capped

The repository is DEVMCP_ROOT, else the one containing the working directory. Paths given to the
tools are relative to its root and may not leave it.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections import Counter
from pathlib import Path, PurePosixPath

from mcp.server.mcpserver import MCPServer

MAX_OUTPUT = 12_000  # characters per tool result: a whole diff would drown the model's context


class ToolError(Exception):
    pass


class Repo:
    def __init__(self, root: Path | str | None = None):
        start = Path(root or os.environ.get("DEVMCP_ROOT") or Path.cwd())
        self.root = Path(self.git("rev-parse", "--show-toplevel", cwd=start).strip()).resolve()

    def git(self, *args: str, cwd: Path | None = None) -> str:
        r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=cwd or self.root, capture_output=True,
                           text=True, timeout=30)
        if r.returncode != 0:
            raise ToolError(r.stderr.strip() or f"git {args[0]} failed")
        return r.stdout

    def rel(self, path: str | None) -> str:
        """A path inside the repository, relative to its root ('' for the root)."""
        if not path or path in {".", "/"}:
            return ""
        full = (self.root / path.lstrip("/")).resolve()
        if full != self.root and self.root not in full.parents:
            raise ToolError(f"{path!r} is outside the repository")
        return full.relative_to(self.root).as_posix() if full != self.root else ""

    # --- the tools ---

    def branch(self) -> str:
        name = self.git("branch", "--show-current").strip()
        if not name:
            sha = self.git("rev-parse", "--short", "HEAD").strip()
            return f"detached HEAD at {sha}"
        lines = [f"branch: {name}"]
        try:
            upstream = self.git("rev-parse", "--abbrev-ref", f"{name}@{{upstream}}").strip()
            behind, ahead = self.git("rev-list", "--left-right", "--count", f"{upstream}...HEAD").split()
            lines.append(f"upstream: {upstream} (ahead {ahead}, behind {behind})")
        except ToolError:
            lines.append("upstream: none (not pushed)")
        default = self._default_branch()
        if default and default != name:
            try:
                n = self.git("rev-list", "--count", f"{default}..HEAD").strip()
                lines.append(f"commits since {default}: {n}")
            except ToolError:
                pass
        lines.append(f"repository: {self.root}")
        return "\n".join(lines)

    def _default_branch(self) -> str | None:
        try:
            return self.git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").strip().removeprefix("origin/")
        except ToolError:
            names = self.git("branch", "--format=%(refname:short)").split()
            return next((n for n in ("main", "master") if n in names), None)

    def status(self) -> str:
        out = self.git("status", "--porcelain=v1", "--untracked-files=all")
        lines = [ln for ln in out.splitlines() if ln.strip()]
        if not lines:
            return "clean: no changes"
        counts = Counter("untracked" if ln[:2] == "??" else "staged" if ln[0] != " " else "modified" for ln in lines)
        head = ", ".join(f"{n} {k}" for k, n in counts.most_common())
        return _cap(f"{len(lines)} changed paths ({head}); XY codes as in `git status --short`:\n" + "\n".join(lines))

    def log(self, n: int = 10, path: str | None = None) -> str:
        n = max(1, min(int(n), 50))
        args = ["log", f"-n{n}", "--date=short", "--pretty=format:%h %ad %an  %s"]
        rel = self.rel(path)
        if rel:
            args += ["--", rel]
        out = self.git(*args).strip()
        if not out and rel and not (self.root / rel).exists():
            raise ToolError(f"no file or directory {rel!r} in the repository (and no history for it). `path` "
                            "filters by file or directory; the log is always of the current branch, so for the branch's "
                            "commits call git_log without `path`")
        return out or "no commits"

    def diff(self, path: str | None = None, base: str | None = None, stat: bool = False) -> str:
        """Working tree vs HEAD; with `base`, the branch's changes since it forked from base."""
        args = ["diff", "--stat" if stat else "--patch"]
        if base:
            if base.startswith("-"):
                raise ToolError(f"bad base {base!r}")
            args.append(f"{base}...HEAD")
        rel = self.rel(path)
        if rel:
            args += ["--", rel]
        out = self.git(*args).strip()
        if not out and rel and not (self.root / rel).exists():
            raise ToolError(f"no file or directory {rel!r} in the repository; `path` is a file or directory, "
                            "`base` the branch to compare with")
        if not out:
            return f"no differences{f' between {base} and HEAD' if base else ' in the working tree (vs HEAD)'}"
        return _cap(out)

    def files(self, path: str | None = None, depth: int = 2) -> str:
        rel = self.rel(path)
        depth = max(1, min(int(depth), 6))
        args = ["ls-files", "--cached", "--others", "--exclude-standard"]
        if rel:
            args += ["--", rel]
        paths = sorted({p for p in self.git(*args).splitlines() if (self.root / p).exists()})
        if not paths:
            raise ToolError(f"no files under {path!r}" if rel else "the repository has no files")
        base = PurePosixPath(rel) if rel else None
        tree: dict[str, int] = {}  # shown entry -> files under it (1 for a file)
        for p in paths:
            parts = PurePosixPath(p).relative_to(base).parts if base else PurePosixPath(p).parts
            if not parts:  # `path` is a file
                return p
            shown = "/".join(parts[:depth]) + ("/" if len(parts) > depth else "")
            tree[shown] = tree.get(shown, 0) + 1
        lines = [f"{rel or '.'}/ — {len(paths)} files (git's view: ignored files left out), depth {depth}:"]
        for entry, n in tree.items():
            lines.append(f"  {entry}  ({n} files)" if entry.endswith("/") else f"  {entry}")
        return _cap("\n".join(lines))

    def read(self, path: str, start: int = 1, lines: int = 200) -> str:
        rel = self.rel(path)
        full = self.root / rel
        if not rel or not full.is_file():
            raise ToolError(f"{path!r} is not a file")
        try:
            text = full.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise ToolError(f"{path!r} is not a text file") from None
        all_lines = text.splitlines()
        start = max(1, int(start))
        lines = max(1, min(int(lines), 400))
        chunk = all_lines[start - 1:start - 1 + lines]
        body = "\n".join(f"{start + i:5}  {ln}" for i, ln in enumerate(chunk))
        more = f"\n… {len(all_lines) - (start - 1 + len(chunk))} more lines" if start - 1 + len(chunk) < len(all_lines) else ""
        return _cap(f"{rel} (lines {start}-{start + len(chunk) - 1} of {len(all_lines)}):\n{body}{more}")


def _cap(text: str) -> str:
    if len(text) <= MAX_OUTPUT:
        return text
    return text[:MAX_OUTPUT] + f"\n… cut: {len(text) - MAX_OUTPUT} more characters (narrow it down with `path`)"


def create_server(repo: Repo | None = None) -> MCPServer:
    repo = repo or Repo()
    mcp = MCPServer("devmcp", instructions=f"Read-only git state of the repository at {repo.root}.",
                    log_level="WARNING")

    def run(fn, *args):
        try:
            return fn(*args)
        except ToolError as e:
            return f"error: {e}"

    @mcp.tool()
    def git_branch() -> str:
        """The current git branch, its upstream with ahead/behind counts, and how many commits it has
        since the default branch."""
        return run(repo.branch)

    @mcp.tool()
    def git_status() -> str:
        """Uncommitted changes: modified, staged and untracked files (git status --short)."""
        return run(repo.status)

    @mcp.tool()
    def git_log(n: int = 10, path: str | None = None) -> str:
        """The last `n` commits of the current branch (hash, date, author, subject), optionally only
        those touching `path` (a file or directory relative to the repository root, not a branch)."""
        return run(repo.log, n, path)

    @mcp.tool()
    def git_diff(path: str | None = None, base: str | None = None, stat: bool = False) -> str:
        """A diff. Without `base`: uncommitted changes vs HEAD. With `base` (e.g. "main"): everything
        the current branch changed since it forked from base. `path` limits it to a file or
        directory; `stat` gives only the per-file summary."""
        return run(repo.diff, path, base, stat)

    @mcp.tool()
    def list_files(path: str = ".", depth: int = 2) -> str:
        """The files under `path` (relative to the repository root), as a tree `depth` levels deep;
        deeper directories are shown with their file count. Ignored files are left out."""
        return run(repo.files, path, depth)

    @mcp.tool()
    def read_file(path: str, start: int = 1, lines: int = 200) -> str:
        """Lines of a text file in the repository (numbered), from `start`, at most `lines` (≤ 400)."""
        return run(repo.read, path, start, lines)

    return mcp


def main() -> None:
    try:
        server = create_server()
    except (ToolError, OSError) as e:
        print(f"devmcp: {e}", file=sys.stderr)
        sys.exit(1)
    server.run("stdio")


if __name__ == "__main__":
    main()
