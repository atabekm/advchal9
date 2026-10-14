import pytest

from devreview.context import build_context, code_view, numbered_diff
from devreview.diff import FileDiff, enclosing, local, parse, patched, symbols, touched

from .fakes import FakeEmbedder, FakeReranker, commit, git, init_repo

DIFF = """\
diff --git a/task1/store.py b/task1/store.py
index 1111111..2222222 100644
--- a/task1/store.py
+++ b/task1/store.py
@@ -1,4 +1,5 @@ import os
 def load(path):
-    return open(path).read()
+    with open(path) as f:
+        return f.read()

@@ -10,2 +11,3 @@ def save(path, data):
     x = 1
+    y = 2
     return x
\\ No newline at end of file
diff --git a/task1/new.py b/task1/new.py
new file mode 100644
--- /dev/null
+++ b/task1/new.py
@@ -0,0 +1,2 @@
+def new():
+    pass
diff --git a/task1/old.py b/task1/old.py
deleted file mode 100644
--- a/task1/old.py
+++ /dev/null
@@ -1 +0,0 @@
-x = 1
diff --git a/task1/a.py b/task1/b.py
similarity index 90%
rename from task1/a.py
rename to task1/b.py
diff --git a/task1/logo.png b/task1/logo.png
Binary files a/task1/logo.png and b/task1/logo.png differ
"""


def test_parse_numbers_lines_on_both_sides():
    files = parse(DIFF)
    assert [(f.path, f.status) for f in files] == [
        ("task1/store.py", "modified"), ("task1/new.py", "added"), ("task1/old.py", "deleted"),
        ("task1/b.py", "renamed"), ("task1/logo.png", "modified")]
    store = files[0]
    h1, h2 = store.hunks
    assert (h1.old_start, h1.new_start, h1.header) == (1, 1, "import os")
    assert [(ln.op, ln.old, ln.new) for ln in h1.lines] == [
        (" ", 1, 1), ("-", 2, None), ("+", None, 2), ("+", None, 3), (" ", 3, 4)]
    assert [ln.new for ln in store.added] == [2, 3, 12]
    assert store.new_lines == {1, 2, 3, 4, 11, 12, 13}
    assert files[3].old_path == "task1/a.py"
    assert files[4].binary


@pytest.mark.parametrize("path, status, reason", [
    ("task1/store.py", "modified", None),
    ("task1/old.py", "deleted", "deleted"),
    ("task1/uv.lock", "modified", "lockfile"),
    ("task1/README.md", "modified", "documentation"),
    ("task1/results/run.json", "added", "data"),
    ("task1/style.css", "modified", "not code"),
    (".github/workflows/review.yml", "added", None),
    ("task1/Dockerfile", "modified", None),
    ("task1/__init__.py", "added", "empty"),
])
def test_skip_reason(path, status, reason):
    fd = parse(DIFF)[0]
    fd.path, fd.status = path, status
    if reason == "empty":
        fd.hunks = []
    assert fd.skip_reason() == reason


PY = '''import os


class Store:
    def __init__(self):
        self.rows = []

    def add(self, row):
        self.rows.append(row)


def helper():
    def inner():
        return 1
    return inner()
'''


def test_symbols_are_nested_and_enclosing_picks_the_innermost():
    syms = symbols(PY, "python")
    assert [(s.name, s.start, s.end) for s in syms] == [
        ("Store", 4, 9), ("Store.__init__", 5, 6), ("Store.add", 8, 9), ("helper", 12, 15), ("helper.inner", 13, 14)]
    assert enclosing(syms, 9).name == "Store.add"
    assert enclosing(syms, 7).name == "Store"
    assert enclosing(syms, 2) is None
    assert [s.name for s in symbols("function a() {}\nconst b = () => 1;\n", "javascript")] == ["a", "b"]


def test_touched_names_changed_removed_and_added():
    old = PY
    new = PY.replace("def add(self, row):\n        self.rows.append(row)",
                     "def append(self, row):\n        self.rows.append(row)\n        return row")
    fd = parse("diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -8,2 +8,3 @@\n"
               "-    def add(self, row):\n+    def append(self, row):\n         self.rows.append(row)\n+        return row\n")[0]
    t = touched(fd, old, new)
    assert [s.name for s in t.changed] == ["Store.append"]
    assert t.removed == ["Store.add"] and t.added == ["Store.append"]


def test_numbered_diff_names_the_definition_and_numbers_new_lines():
    fd = parse(DIFF)[0]
    text = numbered_diff(fd, symbols("def load(path):\n    with open(path) as f:\n        return f.read()\n", "python"))
    assert text.splitlines()[:4] == [
        "@@ -1,4 +1,5 @@ in load", "    1   def load(path):", "      - " + "    return open(path).read()",
        "    2 +     with open(path) as f:"]
    assert "@@ -10,2 +11,3 @@ def save(path, data):" in text


def test_code_view_whole_or_excerpts():
    fd = parse(DIFF)[0]
    text = "\n".join(f"line {i}" for i in range(1, 400))
    whole, is_whole = code_view(fd, "a\nb\n", [])
    assert is_whole and whole == "    1  a\n    2  b"
    part, is_whole = code_view(fd, text, [], limit=500)
    assert not is_whole
    assert "    2  line 2" in part and "   12  line 12" in part and "  300  line 300" not in part


# --- on a real repository ---

@pytest.fixture
def repo(tmp_path):
    init_repo(tmp_path)
    (tmp_path / "task1").mkdir()
    (tmp_path / "task2").mkdir()
    (tmp_path / "task1" / "store.py").write_text(
        "def save_rows(rows, path):\n    with open(path, 'w') as f:\n        f.write(str(rows))\n\n\n"
        "def load_rows(path):\n    return open(path).read()\n")
    (tmp_path / "task1" / "app.py").write_text(
        "from store import save_rows, load_rows\n\n\ndef main():\n    save_rows([1], 'x')\n    return load_rows('x')\n")
    (tmp_path / "task2" / "other.py").write_text("def save_rows():\n    pass\n")  # another task: out of scope
    commit(tmp_path, "base")
    return tmp_path


def test_a_renamed_function_with_a_caller_left_behind(repo):
    git(repo, "checkout", "-q", "-b", "rename")
    store = repo / "task1" / "store.py"
    store.write_text(store.read_text().replace("def save_rows(rows, path)", "def write_rows(rows, path, mode)"))
    commit(repo, "rename save_rows")
    change = local(repo, "main", "rename")
    assert change.commits == ["rename save_rows"] and change.title == "rename save_rows"
    (fd,) = change.files
    ctx = build_context(change, fd)
    assert ctx.touched.removed == ["save_rows"]
    assert [str(u) for u in ctx.dangling["save_rows"]] == [
        "task1/app.py:1: from store import save_rows, load_rows", "task1/app.py:5: save_rows([1], 'x')"]
    assert "write_rows" in ctx.code and ctx.code_whole


def test_callers_and_called_definitions(repo):
    patch = repo.parent / "change.patch"
    patch.write_text("""\
diff --git a/task1/app.py b/task1/app.py
--- a/task1/app.py
+++ b/task1/app.py
@@ -4,3 +4,4 @@ from store import save_rows, load_rows
 def main():
     save_rows([1], 'x')
-    return load_rows('x')
+    rows = load_rows('x', strict=True)
+    return rows
""")
    change = patched(repo, patch, "main")
    assert git(repo, "status", "--porcelain") == ""  # the working tree is untouched
    assert change.base.sha == git(repo, "rev-parse", "main").strip()
    (fd,) = change.files
    ctx = build_context(change, fd)
    assert [(d.name, d.path, d.line) for d in ctx.definitions] == [("load_rows", "task1/store.py", 6)]
    assert "def load_rows(path):" in ctx.definitions[0].text
    assert ctx.callers == {}  # `main` is too common a name to look up
    assert "    6 +     rows = load_rows('x', strict=True)" in ctx.numbered_diff


def test_passages_exclude_the_changed_files(repo, tmp_path_factory):
    from devreview.corpus import GitTree
    from devreview.index import build
    from devreview.retrieve import Retriever
    from devreview.store import Store

    db = tmp_path_factory.mktemp("index") / "index.db"
    store = Store(db)
    build(store, GitTree(repo, "main"), embedder=FakeEmbedder())
    store.close()
    store_py = repo / "task1" / "store.py"
    store_py.write_text(store_py.read_text() + "\n\ndef save_all(rows):\n    save_rows(rows, 'all')\n")
    commit(repo, "save_all")
    change = local(repo, "main~1", "main")
    r = Retriever(db, embedder=FakeEmbedder(), reranker=FakeReranker())
    ctx = build_context(change, change.files[0], r)
    assert ctx.passages and all(h.source != "task1/store.py" and h.task in {"task1", ""} for h in ctx.passages)
    r.close()
