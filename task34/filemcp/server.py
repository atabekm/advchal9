"""`filemcp`: an MCP server (stdio) over one project directory.

Tools for the model:

    list_files     files under a directory, optionally by glob, with line counts and staged marks
    read_file      numbered lines of a file, paged (start, end)
    search         regex (or literal) search over files: path:line: text
    outline        definitions of a .py file (with signatures, docstrings) or headings of a .md file
    edit_file      replace an exact piece of text that occurs once (staged)
    insert_lines   add lines after a given line, leaving the rest as it is (staged)
    write_file     create a file, or replace one already read (staged)
    git_log        commits, optionally in a range ("v0.3.0..HEAD") or touching a path
    git_show       one commit: message, files changed, patch
    git_diff       the diff between two revisions

Tools for the client only (the agent doesn't show them to the model):

    staged_diff    the staged changes as a unified diff
    staged_files   the paths with staged changes
    apply_staged   write the staged changes to disk
    discard_staged drop them

Edits never reach the disk until the client calls apply_staged. Git tools show the repository as
committed; staged edits are not in git. The root is FILEMCP_ROOT or `--root DIR`.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from .workspace import Workspace, WorkspaceError

MAX_GIT_OUTPUT = 16_000
CLIENT_TOOLS = ("staged_diff", "staged_files", "apply_staged", "discard_staged")


def _ref(value: str, name: str) -> str:
    value = (value or "").strip()
    if value.startswith("-") or any(c in value for c in " \n\t;|&$`"):
        raise WorkspaceError(f"bad {name}: {value!r}")
    return value


def _git(root: Path, *args: str) -> str:
    try:
        r = subprocess.run(["git", "--no-pager", "-C", str(root), *args], capture_output=True, text=True,
                           timeout=30, env={**os.environ, "GIT_PAGER": "cat", "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired) as e:
        raise WorkspaceError(f"git failed: {e}") from None
    if r.returncode != 0:
        raise WorkspaceError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "git failed")
    out = r.stdout
    if len(out) > MAX_GIT_OUTPUT:
        out = out[:MAX_GIT_OUTPUT] + f"\n… cut at {MAX_GIT_OUTPUT} characters; pass a path to narrow it"
    return out.rstrip() or "(empty)"


def create_server(root: Path | str) -> MCPServer:
    ws = Workspace(root)
    mcp = MCPServer("filemcp", instructions=f"Files of the project at {ws.root}. Edits are staged in memory "
                    "until the client applies them.", log_level="WARNING")

    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except WorkspaceError as e:
            return f"error: {e}"

    def git_path(path: str) -> list[str]:
        return ["--", ws.rel(path)] if path and path.strip() not in ("", ".") else []

    @mcp.tool()
    def list_files(path: str = ".", pattern: str | None = None) -> str:
        """Files under `path` (a directory relative to the project root), one per line with its line count.
        `pattern` is a glob such as "*.py" or "docs/**/*.md". Staged files are marked [new] or [modified]."""
        return run(ws.list_files, path, pattern)

    @mcp.tool()
    def read_file(path: str, start: int = 1, end: int | None = None) -> str:
        """The lines of a file, numbered ("12| text"), from `start` to `end` (inclusive), at most 300 at once.
        Shows staged edits. The numbers are not part of the file."""
        return run(ws.read_file, path, start, end)

    @mcp.tool()
    def search(pattern: str, path: str = ".", glob: str | None = None, ignore_case: bool = False,
               literal: bool = False) -> str:
        """Lines matching a regular expression in the files under `path` (a directory or one file),
        as "file:line: text". `glob` limits the files ("*.py", "docs/*.md"); `literal` treats the pattern
        as plain text. Searches staged edits too."""
        return run(ws.search, pattern, path, glob, ignore_case, literal)

    @mcp.tool()
    def outline(path: str) -> str:
        """The structure of a file without reading it all: for Python, imports, constants, classes and
        functions with line numbers, signatures and the first line of their docstrings (or "no
        docstring"); for Markdown, the headings with line numbers."""
        return run(ws.outline, path)

    @mcp.tool()
    def edit_file(path: str, old: str, new: str, replace_all: bool = False) -> str:
        """Replace the exact text `old` with `new` in a file. `old` must occur exactly once (include a few
        surrounding lines to make it unique) unless `replace_all`. Copy `old` from read_file without the
        line numbers, indentation included. Everything in `old` is replaced; to add lines without changing
        any, use insert_lines. The change is staged; the result shows the lines removed and the region now."""
        return run(ws.edit_file, path, old, new, replace_all)

    @mcp.tool()
    def insert_lines(path: str, after: str, text: str) -> str:
        """Add new lines to a file without changing the existing ones: `text` goes right after the line
        `after`, given as its line number from read_file ("8") or its text (e.g. a table row or a heading,
        which must occur once). after="0" inserts at the top. Use it to add a table row, a list item, a
        setting or a section. The change is staged."""
        return run(ws.insert_lines, path, after, text)

    @mcp.tool()
    def write_file(path: str, content: str) -> str:
        """Create a new file with `content`, or replace a whole file you have already read. Directories are
        created as needed. Prefer edit_file for changes to existing files. The change is staged."""
        return run(ws.write_file, path, content)

    @mcp.tool()
    def git_log(revision_range: str = "", path: str = "", max_count: int = 20) -> str:
        """Commits, newest first: hash, date, author, tags, then the full message. `revision_range` is
        e.g. "v0.3.0..HEAD" (commits after the tag) or "HEAD~3..HEAD"; `path` limits it to commits
        touching a file or directory. Tags are listed in parentheses."""
        def go():
            args = ["log", f"--max-count={max(1, min(int(max_count), 100))}", "--date=short",
                    "--format=%h %ad %an%d%n%w(0,4,4)%B"]
            if revision_range:
                args.append(_ref(revision_range, "revision_range"))
            return _git(ws.root, *args, *git_path(path))
        return run(go)

    @mcp.tool()
    def git_show(ref: str = "HEAD", path: str = "") -> str:
        """One commit: hash, author, date, message, the files it changed (stat) and its patch. `path`
        limits the patch to a file or directory."""
        return run(lambda: _git(ws.root, "show", "--stat", "--patch", "--format=commit %H%nAuthor: %an%nDate: "
                                "%ad%d%n%n%w(0,4,4)%B", "--date=short", _ref(ref, "ref"), *git_path(path)))

    @mcp.tool()
    def git_diff(base: str, head: str = "HEAD", path: str = "", stat_only: bool = False) -> str:
        """The changes between two revisions, e.g. base="v0.3.0" for everything since that tag. `stat_only`
        lists files and line counts only; `path` limits it to a file or directory."""
        def go():
            args = ["diff", "--stat" if stat_only else "--patch", f"{_ref(base, 'base')}..{_ref(head, 'head')}"]
            return _git(ws.root, *args, *git_path(path))
        return run(go)

    @mcp.tool()
    def staged_diff() -> str:
        """(client) The staged changes as a unified diff with a/ b/ paths, or an empty string."""
        return ws.diff()

    @mcp.tool()
    def staged_files() -> str:
        """(client) The staged paths, one per line: "new path" or "modified path"."""
        return "\n".join(f"{'new' if old is None else 'modified'} {rel}" for rel, old, _ in ws.changes())

    @mcp.tool()
    def apply_staged() -> str:
        """(client) Write the staged changes to disk and clear them. Returns the written paths."""
        return "\n".join(ws.apply())

    @mcp.tool()
    def discard_staged() -> str:
        """(client) Drop all staged changes."""
        return f"discarded {ws.discard()} files"

    return mcp


def main() -> None:
    parser = argparse.ArgumentParser(prog="filemcp", description="An MCP server over one project directory.")
    parser.add_argument("--root", default=os.environ.get("FILEMCP_ROOT"), help="the project root (FILEMCP_ROOT)")
    args = parser.parse_args()
    if not args.root:
        print("filemcp: give --root DIR or set FILEMCP_ROOT", file=sys.stderr)
        sys.exit(2)
    try:
        server = create_server(args.root)
    except WorkspaceError as e:
        print(f"filemcp: {e}", file=sys.stderr)
        sys.exit(1)
    server.run("stdio")


if __name__ == "__main__":
    main()
