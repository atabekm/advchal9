"""Which files of the repository the reviewer can look things up in, and what each one is.

Two halves, both from git (so build output, virtualenvs and indexes never get in):

**Documentation** (task 31's selection):

    README.md, docs/**                      the repository's own docs (docs/api/*.yaml: OpenAPI)
    taskN/README.md, PLAN.md, COMPARISON.md  what each task built and why
    taskN/taskN.txt                          the brief (in Russian)
    pyproject.toml, go.mod, compose*.yaml,   dependencies, entry points, services
      Dockerfile, Modelfile, .env.example
    CREATE TABLE statements in code         the data schemas, pulled out of the source files

**Code**: every `*.py`, `*.js`, `*.go` in a task folder, except tests, vendored or minified
files, and the folders that hold data rather than code (taskN/docs, results, eval, ...).

The files are read from a `Tree`: the working tree, or a git ref (`GitTree(root, "main")`), so
the index can be built from the base branch while a PR's branch is checked out.
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
CODE_LANGS = {".py": "python", ".js": "javascript", ".mjs": "javascript", ".go": "go"}
DATA_DIRS = {"docs", "results", "eval", "out", "runs", "index", "data", "fixtures"}
VENDORED = {"vendor", "node_modules", "dist", "build", "third_party"}
MAX_CODE_BYTES = 200_000
SCHEMA_RE = re.compile(r"CREATE (?:UNIQUE )?(?:VIRTUAL )?(?:TABLE|INDEX)(?: IF NOT EXISTS)? \w+\s*(?:\(|ON |USING )")
TASK_RE = re.compile(r"^task(\d+)$")


@dataclass(frozen=True)
class Doc:
    source: str  # path from the repository root, posix
    kind: str  # markdown | openapi | text | schema | code
    task: str  # "task30", or "" for the repository-level docs
    text: str
    title: str = ""  # the task's README title, so a pyproject.toml or a schema says whose it is

    @property
    def lang(self) -> str:
        return CODE_LANGS.get(PurePosixPath(self.source).suffix, "") if self.kind == "code" else ""

    @property
    def sha256(self) -> str:
        return hashlib.sha256(f"{self.kind}\0{self.title}\0{self.text}".encode()).hexdigest()


class Tree:
    """The files of the repository in the working tree."""

    def __init__(self, root: Path):
        self.root = root
        self.ref = ""

    def files(self) -> list[str]:
        out = git(self.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
        return sorted({p for p in out.split("\0") if p and (self.root / p).is_file()})

    def read(self, path: str) -> str | None:
        """The text of `path`, or None when it is missing, binary or not UTF-8."""
        try:
            data = (self.root / path).read_bytes()
        except OSError:
            return None
        return _text(data)


class GitTree(Tree):
    """The files of the repository at a commit (a branch name, a sha, `origin/main`, ...)."""

    def __init__(self, root: Path, ref: str):
        super().__init__(root)
        self.ref = ref
        self.sha = git(root, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()

    def files(self) -> list[str]:
        out = git(self.root, "ls-tree", "-r", "-z", "--name-only", self.sha)
        return sorted(p for p in out.split("\0") if p)

    def read(self, path: str) -> str | None:
        r = subprocess.run(["git", "cat-file", "blob", f"{self.sha}:{path}"], cwd=self.root, capture_output=True)
        return _text(r.stdout) if r.returncode == 0 else None


def _text(data: bytes) -> str | None:
    if b"\0" in data[:8000]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def git(root: Path, *args: str) -> str:
    out = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if out.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {out.stderr.strip() or out.stdout.strip()}")
    return out.stdout


class GitError(RuntimeError):
    pass


def repo_root(start: Path = TASK_DIR) -> Path:
    return Path(git(start, "rev-parse", "--show-toplevel").strip())


def task_of(path: str) -> str:
    first = PurePosixPath(path).parts[0]
    return first if TASK_RE.match(first) else ""


def classify(path: str) -> str | None:
    """The kind of document `path` is ("code" for source files), or None when it isn't indexed."""
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
    if len(parts) > 1 and parts[1] in DATA_DIRS:
        return None
    if len(parts) == 2:
        if name in TASK_DOCS:
            return "markdown"
        if name == f"{task}.txt" or name in CONFIG_NAMES or re.fullmatch(r"compose[\w.-]*\.ya?ml", name):
            return "text"
    if p.suffix in CODE_LANGS and not is_test(path) and not VENDORED & set(parts) and ".min." not in name:
        return "code"
    return None


def is_test(path: str) -> bool:
    p = PurePosixPath(path)
    return ("tests" in p.parts or "test" in p.parts or p.name.startswith("test")
            or p.stem.endswith(("_test", ".test", ".spec")))


def minified(text: str) -> bool:
    lines = text.count("\n") + 1
    return len(text) / lines > 300


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


def collect(tree: Tree) -> list[Doc]:
    docs: list[Doc] = []
    for path in tree.files():
        kind = classify(path)
        if kind is None:
            continue
        text = tree.read(path)
        if not text or not text.strip():
            continue
        task = task_of(path)
        if kind == "code":
            if len(text) <= MAX_CODE_BYTES and not minified(text):
                docs.append(Doc(path, "code", task, text))
            if "CREATE TABLE" in text and (schemas := extract_schemas(text)):
                docs.append(Doc(f"{path}#schema", "schema", task, "\n\n".join(schemas)))
            continue
        docs.append(Doc(path, kind, task, text))
    titles = {d.task: _h1(d.text) for d in docs if d.source == f"{d.task}/README.md"}
    return [replace(d, title=titles.get(d.task, d.task)) for d in docs]


def _h1(markdown: str) -> str:
    m = re.search(r"^# (.+)$", markdown, re.M)
    return m.group(1).strip() if m else ""
