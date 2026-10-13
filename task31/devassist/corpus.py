"""Which files of the repository are its documentation, and what each one is.

The file list comes from git (tracked files plus untracked ones that aren't ignored), so build
output, virtualenvs and indexes never get in. From it we keep:

    README.md, docs/**                      the repository's own docs (docs/api/*.yaml: OpenAPI)
    taskN/README.md, PLAN.md, COMPARISON.md  what each task built and why
    taskN/taskN.txt                          the brief (in Russian)
    pyproject.toml, go.mod, compose*.yaml,   dependencies, entry points, services
      Dockerfile, Modelfile, .env.example
    CREATE TABLE statements in code         the data schemas, pulled out of the source files

and leave out taskN/docs/ (the RAG corpora of tasks 21-29, about other subjects), EVAL.md
(generated run reports) and test files.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath

TASK_DIR = Path(__file__).resolve().parent.parent

TASK_DOCS = {"README.md", "PLAN.md", "COMPARISON.md"}
CONFIG_NAMES = {"pyproject.toml", "go.mod", "Dockerfile", "Modelfile", ".env.example"}
CODE_SUFFIXES = {".py", ".go", ".js"}
SCHEMA_RE = re.compile(r"CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX)(?: IF NOT EXISTS)? \w+\s*(?:\(|ON |USING )")
TASK_RE = re.compile(r"^task(\d+)$")


@dataclass(frozen=True)
class Doc:
    source: str  # path from the repository root, posix
    kind: str  # markdown | openapi | text | schema
    task: str  # "task30", or "" for the repository-level docs
    text: str
    title: str = ""  # the task's README title, so a pyproject.toml or a schema says whose it is

    @property
    def sha256(self) -> str:
        return hashlib.sha256(f"{self.kind}\0{self.title}\0{self.text}".encode()).hexdigest()


def repo_root(start: Path = TASK_DIR) -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=start, capture_output=True, text=True,
                         check=True)
    return Path(out.stdout.strip())


def git_files(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root,
                         capture_output=True, text=True, check=True)
    return sorted({p for p in out.stdout.split("\0") if p and (root / p).is_file()})


def task_of(path: str) -> str:
    first = PurePosixPath(path).parts[0]
    return first if TASK_RE.match(first) else ""


def classify(path: str) -> str | None:
    """The kind of document `path` is, or None when it isn't documentation."""
    p = PurePosixPath(path)
    parts, name = p.parts, p.name
    task = task_of(path)
    if not task:
        if path == "README.md":
            return "markdown"
        if parts[0] == "docs":
            if p.suffix == ".md":
                return "markdown"
            if p.suffix in {".yaml", ".yml"} and "openapi" in name:
                return "openapi"
        return None
    # inside a task folder
    if len(parts) > 1 and parts[1] in {"docs", "results", "eval", "out", "runs", "index"}:
        return None
    if len(parts) == 2:
        if name in TASK_DOCS:
            return "markdown"
        if name == f"{task}.txt" or name in CONFIG_NAMES or re.fullmatch(r"compose[\w.-]*\.ya?ml", name):
            return "text"
    if p.suffix in CODE_SUFFIXES and not _is_test(p):
        return "code"  # a candidate for schema extraction only
    return None


def _is_test(p: PurePosixPath) -> bool:
    return "tests" in p.parts or p.name.startswith("test") or p.stem.endswith("_test")


def extract_schemas(text: str) -> list[str]:
    """Every CREATE TABLE / CREATE INDEX statement in a source file, through its closing
    parenthesis (column lists nest: `REFERENCES sessions(id)`) or its semicolon."""
    out = []
    for m in SCHEMA_RE.finditer(text):
        depth, end = 0, None
        for i in range(m.start(), len(text)):
            c = text[i]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
            elif c == ";" and depth == 0 or c in "\"'`" and depth == 0 and i > m.start():
                end = i
                break
        if end:
            out.append(text[m.start():end].strip().rstrip(";") + ";")
    return out


def collect(root: Path) -> list[Doc]:
    docs: list[Doc] = []
    for path in git_files(root):
        kind = classify(path)
        if kind is None:
            continue
        try:
            text = (root / path).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if kind == "code":
            if "CREATE TABLE" not in text:
                continue
            schemas = extract_schemas(text)
            if not schemas:
                continue
            kind, text = "schema", "\n\n".join(schemas)
        if text.strip():
            docs.append(Doc(path, kind, task_of(path), text))
    titles = {d.task: _h1(d.text) for d in docs if d.source == f"{d.task}/README.md"}
    return [replace(d, title=titles.get(d.task, d.task)) for d in docs]


def _h1(markdown: str) -> str:
    m = re.search(r"^# (.+)$", markdown, re.M)
    return m.group(1).strip() if m else ""
