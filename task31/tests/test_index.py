import subprocess
from pathlib import Path

import numpy as np
import pytest

from devassist.chunk import chunk, markdown_sections, openapi_markdown
from devassist.corpus import Doc, classify, collect, extract_schemas
from devassist.index import build
from devassist.lexical import BM25, tokens
from devassist.retrieve import Retriever, mentioned_tasks
from devassist.store import Store


@pytest.mark.parametrize("path, kind", [
    ("README.md", "markdown"),
    ("docs/conventions.md", "markdown"),
    ("docs/api/task30-gateway.openapi.yaml", "openapi"),
    ("task30/README.md", "markdown"),
    ("task23/PLAN.md", "markdown"),
    ("task21/COMPARISON.md", "markdown"),
    ("task30/task30.txt", "text"),
    ("task30/pyproject.toml", "text"),
    ("task30/compose.mac.yaml", "text"),
    ("task16/go.mod", "text"),
    ("task30/.env.example", "text"),
    ("task25/rag/store.py", "code"),
    ("task23/EVAL.md", None),           # generated reports
    ("task23/docs/paper.pdf", None),    # the RAG corpus, not documentation
    ("task27/docs/notes.md", None),
    ("task30/results/run.json", None),
    ("task30/tests/test_app.py", None),
    ("task30/.env", None),
    ("task30/gateway/README.md", None),  # only top-level task docs
    ("video/x.mp4", None),
])
def test_classify(path, kind):
    assert classify(path) == kind


def test_extract_schemas_keeps_nested_parentheses():
    code = '''SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
"""
# CREATE TABLE statements in prose are not schemas (see the docs)
'''
    out = extract_schemas(code)
    assert len(out) == 2
    assert out[0].endswith("PRIMARY KEY (a, b)\n);")
    assert out[1] == "CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);"


def test_markdown_sections_follow_heading_path_and_skip_code_fences():
    md = "# Top\n\nintro\n\n## Run it\n\n```bash\n# not a heading\n\nuv run x\n```\n\n### On a VPS\n\ntext\n\n## Files\n\nf"
    names = [name for name, _ in markdown_sections(md)]
    assert names == ["Top", "Top › Run it", "Top › Run it › On a VPS", "Top › Files"]
    run_it = dict(markdown_sections(md))["Top › Run it"]
    assert any("# not a heading" in p and "uv run x" in p for p in run_it)  # the fence is one block


def test_chunk_merges_short_sections_and_splits_long_ones():
    long = "\n\n".join(f"Paragraph {i} " + "word " * 60 for i in range(12))
    md = f"# T\n\n## A\n\n## B\n\n{long}"
    doc = Doc("task9/README.md", "markdown", "task9", md)
    chunks = chunk(doc, max_chars=800, min_chars=200)
    assert len(chunks) > 3
    assert all(len(c.text) <= 1100 for c in chunks)
    assert chunks[0].text.startswith("# T")  # the lone headings went into the first chunk of B
    assert "## B" in chunks[0].text
    assert all(c.text.strip() for c in chunks)
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))
    assert chunks[0].embed_text.startswith("task9/README.md › T › B\n\n")


def test_text_and_schema_chunks_carry_the_task_title():
    doc = Doc("task18/store/store.go", "schema", "task18", "CREATE TABLE jobs (id INTEGER);", title="Task 18 — HN")
    (c,) = chunk(doc)
    assert c.section == "Task 18 — HN · data schema (SQL)"


def test_openapi_rendered_per_operation_and_schema():
    spec = """
openapi: 3.1.0
info: {title: Gateway, description: The API.}
paths:
  /v1/chat/completions:
    post:
      summary: Chat
      security: [{bearer: []}]
      requestBody: {content: {application/json: {schema: {$ref: "#/components/schemas/Req"}}}}
      responses:
        "429": {description: rate_limit_exceeded}
        "401": {$ref: "#/components/responses/Unauthorized"}
components:
  responses:
    Unauthorized: {description: invalid_api_key}
  schemas:
    Req:
      required: [messages]
      properties:
        messages: {type: array, items: {$ref: "#/components/schemas/Message"}}
        stream: {type: boolean, default: false}
"""
    md = openapi_markdown(spec)
    assert "## POST /v1/chat/completions" in md
    assert "Request body (application/json): Req" in md
    assert "- 429: rate_limit_exceeded" in md and "- 401: invalid_api_key" in md
    assert "- `messages` (required): array of Message" in md
    assert "- `stream`: boolean; default False" in md


@pytest.mark.parametrize("question, tasks", [
    ("what does task 30 do", {"task30"}),
    ("compare tasks 21, 23 and 25", {"task21", "task23", "task25"}),
    ("tasks 16-18", {"task16", "task17", "task18"}),
    ("what's in task30/gateway?", {"task30"}),
    ("день 27", {"task27"}),
    ("which tasks use Ollama?", set()),
])
def test_mentioned_tasks(question, tasks):
    assert mentioned_tasks(question) == tasks


def test_bm25_prefers_the_exact_term():
    bm = BM25(["the queue is bounded by MAX_QUEUE", "the model runs in ollama", "tests run with node test.js"])
    assert int(np.argmax(bm.scores("what is MAX_QUEUE"))) == 0
    assert int(np.argmax(bm.scores("how are tests run"))) == 2
    assert tokens("Tasks and tests") == ["task", "test"]


# --- the index, end to end, on a throwaway repository with a fake embedder ---

class FakeEmbedder:
    """Bag-of-words vectors over a fixed vocabulary: deterministic, no Ollama needed."""
    model = "fake"
    VOCAB = ["queue", "gateway", "branch", "test", "schema", "ollama", "readme", "rerank"]

    def __init__(self):
        self.calls = 0

    def _vec(self, text):
        v = np.array([text.lower().count(w) for w in self.VOCAB], dtype=np.float32) + 0.01
        return v / np.linalg.norm(v)

    def documents(self, texts):
        self.calls += len(texts)
        return np.vstack([self._vec(t) for t in texts])

    def query(self, text):
        return self._vec(text)


class FakeReranker:
    def scores(self, question, texts):
        q = set(tokens(question))
        return [len(q & set(tokens(t))) / (len(q) or 1) for t in texts]


def git(root: Path, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "README.md").write_text("# Repo\n\nThe readme of the whole repo, it lists every task.\n")
    (tmp_path / "docs" / "conventions.md").write_text("# Conventions\n\n## Git\n\nOne branch per task.\n")
    for n, body in [(1, "A gateway with a queue."), (2, "A reranker in front of ollama.")]:
        d = tmp_path / f"task{n}"
        (d / "docs").mkdir(parents=True)
        (d / "README.md").write_text(f"# Task {n}\n\n{body}\n\n## Test\n\nRun the test suite.\n")
        (d / "docs" / "corpus.md").write_text("# Not project docs\n\nqueue queue queue")
        (d / "EVAL.md").write_text("# Report\n\nqueue")
    (tmp_path / "task1" / "store.py").write_text('S = """CREATE TABLE jobs (id INTEGER, queue TEXT);"""')
    git(tmp_path, "init", "-q")
    git(tmp_path, "add", ".")
    return tmp_path


def test_collect_on_a_repo(repo):
    docs = {d.source: d for d in collect(repo)}
    assert set(docs) == {"README.md", "docs/conventions.md", "task1/README.md", "task2/README.md", "task1/store.py"}
    assert docs["task1/store.py"].kind == "schema"
    assert docs["task1/store.py"].title == "Task 1"


def test_build_is_incremental_and_search_is_scoped(repo, tmp_path_factory):
    db = tmp_path_factory.mktemp("index") / "index.db"
    emb = FakeEmbedder()
    store = Store(db)
    first = build(store, root=repo, embedder=emb)
    assert (first.added, first.changed, first.unchanged) == (5, 0, 0)
    calls = emb.calls

    again = build(store, root=repo, embedder=emb)
    assert (again.added, again.changed, again.unchanged, emb.calls) == (0, 0, 5, calls)

    (repo / "task2" / "README.md").write_text("# Task 2\n\nNow about branches.\n")
    (repo / "docs" / "conventions.md").unlink()
    third = build(store, root=repo, embedder=emb)
    assert (third.changed, third.removed, third.unchanged) == (1, 1, 3)
    store.close()

    r = Retriever(db, embedder=emb, reranker=FakeReranker())
    hits = r.search("what is the queue in task 1?", k=3)
    assert hits and all(h.task in {"task1", ""} for h in hits)
    assert hits[0].source.startswith("task1/")
    assert [h.rank for h in hits] == list(range(1, len(hits) + 1))
    r.close()
