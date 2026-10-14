import pytest

from devreview.chunk import chunk, code_chunks, decl_units, markdown_sections, python_units
from devreview.corpus import Doc, GitTree, Tree, classify, collect, extract_schemas, is_test
from devreview.index import build
from devreview.lexical import tokens
from devreview.retrieve import Retriever
from devreview.store import Store

from .fakes import FakeEmbedder, FakeReranker, commit, init_repo


@pytest.mark.parametrize("path, kind", [
    ("README.md", "markdown"),
    ("docs/conventions.md", "markdown"),
    ("docs/api/task30-gateway.openapi.yaml", "openapi"),
    ("task30/README.md", "markdown"),
    ("task30/pyproject.toml", "text"),
    ("task30/task30.txt", "text"),
    ("task30/gateway/app.py", "code"),
    ("task16/connect.go", "code"),
    ("task10/app.js", "code"),
    ("task30/tests/test_app.py", None),
    ("task12/test.js", None),
    ("task16/connect_test.go", None),
    ("task23/docs/paper.md", None),
    ("task22/eval/run.py", None),
    ("task9/vendor/lib.js", None),
    ("task9/lib.min.js", None),
    ("task30/gateway/README.md", None),
    (".github/workflows/x.yml", None),
])
def test_classify(path, kind):
    assert classify(path) == kind


def test_is_test():
    assert is_test("task31/tests/test_index.py") and is_test("a/b.spec.js") and not is_test("task31/devassist/x.py")


def test_extract_schemas_keeps_nested_parentheses():
    code = 'S = """\nCREATE TABLE IF NOT EXISTS m (\n  s TEXT REFERENCES sessions(id),\n  PRIMARY KEY (a, b)\n);\n"""'
    (out,) = extract_schemas(code)
    assert out.endswith("PRIMARY KEY (a, b)\n);")


def test_markdown_sections_follow_heading_path():
    md = "# Top\n\nintro\n\n## Run it\n\n```bash\n# not a heading\n```\n\n### On a VPS\n\ntext"
    assert [n for n, _ in markdown_sections(md)] == ["Top", "Top › Run it", "Top › Run it › On a VPS"]


PY = '''"""A module."""

import os

LIMIT = 3


# loads things
def load(path):
    return open(path).read()


@decorator
def save(path, data):
    with open(path, "w") as f:
        f.write(data)


class Store:
    """Keeps rows."""

    def __init__(self):
        self.rows = []

    def add(self, row):
        self.rows.append(row)
'''


def test_python_units_are_definitions_with_their_comments_and_decorators():
    units = python_units(PY, max_chars=2000)
    assert [(u.name, u.start, u.end) for u in units] == [
        ("(module)", 1, 7), ("load", 8, 10), ("", 11, 12), ("save", 13, 16), ("", 17, 18), ("Store", 19, 26)]


def test_a_long_class_is_cut_into_methods():
    units = python_units(PY, max_chars=100)
    names = [u.name for u in units if u.name]
    assert names[-3:] == ["Store", "Store.__init__", "Store.add"]
    store = next(u for u in units if u.name == "Store")
    assert PY.splitlines()[store.start - 1] == "class Store:"


def test_code_chunks_pack_small_units_and_keep_line_ranges():
    doc = Doc("task1/store.py", "code", "task1", PY)
    chunks = code_chunks(doc, max_chars=150)
    assert all(c.kind == "code" and c.line_start >= 1 for c in chunks)
    lines = PY.splitlines()
    for c in chunks:
        assert c.text == "\n".join(lines[c.line_start - 1:c.line_end]).strip("\n")
    assert chunks[0].label.startswith("task1/store.py:1-")
    assert any("Store" in c.section for c in chunks)
    assert chunk(doc)[0].section == "(module), load, save, Store"  # it all fits in one


def test_unparseable_python_falls_back_to_declarations():
    doc = Doc("task1/broken.py", "code", "task1", "def ok():\n    pass\n\ndef broken(:\n    pass\n")
    assert [c.section for c in code_chunks(doc)] == ["ok, broken"]


def test_js_and_go_declarations():
    js = "import x from 'y';\n\n// helper\nexport function load(a) {\n  return a;\n}\n\nconst cache = new Map();\nclass Box {}\n"
    assert [(u.name, u.start) for u in decl_units(js.splitlines())] == [
        ("(module)", 1), ("load", 3), ("cache", 8), ("Box", 9)]
    go = "package x\n\ntype S struct{}\n\n// Run runs.\nfunc (s *S) Run() error {\n\treturn nil\n}\n\nfunc New() *S { return &S{} }\n"
    assert [(u.name, u.start) for u in decl_units(go.splitlines())] == [
        ("(module)", 1), ("S", 3), ("S.Run", 5), ("New", 10)]


def test_a_long_function_is_cut_in_parts():
    body = "\n".join(f"    x{i} = {i}" for i in range(200))
    doc = Doc("task1/long.py", "code", "task1", f"def long():\n{body}\n")
    chunks = code_chunks(doc, max_chars=500)
    assert len(chunks) > 3
    assert chunks[0].section == "long (part 1)"
    assert chunks[-1].line_end == 201


def test_bm25_tokens_keep_identifiers_whole_and_split():
    assert tokens("self.replace_file(doc)") == ["self", "replace_file", "replace", "file", "doc"]


# --- the index, end to end, on a throwaway repository with a fake embedder ---

@pytest.fixture
def repo(tmp_path):
    init_repo(tmp_path)
    (tmp_path / "docs").mkdir()
    (tmp_path / "README.md").write_text("# Repo\n\nThe readme of the whole repo.\n")
    (tmp_path / "docs" / "conventions.md").write_text("# Conventions\n\n## Git\n\nOne branch per task.\n")
    for n, body in [(1, "A gateway with a queue."), (2, "A reranker in front of ollama.")]:
        d = tmp_path / f"task{n}"
        (d / "tests").mkdir(parents=True)
        (d / "README.md").write_text(f"# Task {n}\n\n{body}\n")
        (d / "tests" / "test_x.py").write_text("def test_queue(): pass\n")
    (tmp_path / "task1" / "store.py").write_text(
        'S = """CREATE TABLE jobs (id INTEGER, queue TEXT);"""\n\n\ndef save_queue(q):\n    return q\n')
    (tmp_path / "task2" / "rerank.py").write_text("def rerank(xs):\n    return sorted(xs)\n")
    commit(tmp_path)
    return tmp_path


def test_collect_reads_a_ref_not_the_working_tree(repo):
    (repo / "task2" / "rerank.py").write_text("def changed(): pass\n")  # uncommitted
    (repo / "task2" / "new.py").write_text("def new(): pass\n")
    at_main = {d.source: d for d in collect(GitTree(repo, "main"))}
    assert set(at_main) == {"README.md", "docs/conventions.md", "task1/README.md", "task2/README.md",
                            "task1/store.py", "task1/store.py#schema", "task2/rerank.py"}
    assert "sorted" in at_main["task2/rerank.py"].text
    assert at_main["task1/store.py#schema"].kind == "schema"
    worktree = {d.source: d for d in collect(Tree(repo))}
    assert "task2/new.py" in worktree and "changed" in worktree["task2/rerank.py"].text


def test_build_is_incremental_and_search_filters(repo, tmp_path_factory):
    db = tmp_path_factory.mktemp("index") / "index.db"
    emb = FakeEmbedder()
    store = Store(db)
    first = build(store, GitTree(repo, "main"), embedder=emb)
    assert (first.added, first.changed, first.unchanged) == (7, 0, 0)
    calls = emb.calls
    again = build(store, GitTree(repo, "main"), embedder=emb)
    assert (again.added, again.unchanged, emb.calls) == (0, 7, calls)

    (repo / "task2" / "rerank.py").write_text("def rerank(xs):\n    return sorted(xs, reverse=True)\n")
    (repo / "docs" / "conventions.md").unlink()
    commit(repo)
    third = build(store, GitTree(repo, "main"), embedder=emb)
    assert (third.changed, third.removed, third.unchanged) == (1, 1, 5)
    assert store.meta()["ref"] == "main"
    store.close()

    r = Retriever(db, embedder=emb, reranker=FakeReranker())
    code = r.search("save the queue", tasks={"task1", ""}, kind="code")
    assert code and code[0].source == "task1/store.py" and code[0].line_start == 1
    assert all(h.kind == "code" and h.task == "task1" for h in code)
    docs = r.search("save the queue", tasks={"task1", ""}, kind="doc")
    assert docs and all(h.kind == "doc" for h in docs)
    assert not any(h.source.startswith("task1/store.py")
                   for h in r.search("queue", exclude={"task1/store.py"}, k=10))  # the schema doc too
    r.close()
