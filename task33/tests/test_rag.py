import numpy as np
import pytest

from support.index import build
from support.kb import KB_DIR, Doc, chunk, collect, markdown_sections
from support.lexical import BM25, tokens
from support.retrieve import IndexMissing, Retriever
from support.store import Store


def test_markdown_sections_follow_heading_path_and_skip_code_fences():
    md = "# Top\n\nintro\n\n## API\n\n```\n# not a heading\n\nAuthorization: Bearer x\n```\n\n### Keys\n\ntext"
    assert [name for name, _ in markdown_sections(md)] == ["Top", "Top › API", "Top › API › Keys"]


def test_long_tables_keep_their_header():
    rows = "\n".join(f"| `CODE_{i}` | {'meaning ' * 12} |" for i in range(30))
    doc = Doc("kb/x.md", "X", f"# X\n\n## Codes\n\n| code | meaning |\n| --- | --- |\n{rows}\n")
    chunks = chunk(doc)
    assert len(chunks) > 1
    assert all("| code | meaning |\n| --- | --- |\n| `CODE_" in c.text for c in chunks)
    assert all(c.section == "X › Codes" for c in chunks)


def test_the_real_knowledge_base():
    docs = collect(KB_DIR)
    assert len(docs) >= 12 and all(d.source.startswith("kb/") for d in docs)
    sections = {c.label for d in docs for c in chunk(d)}
    assert "kb/sign-in.md › Signing in › Account lockout" in sections
    assert "kb/two-factor.md › Two-factor authentication › Codes are rejected" in sections
    for d in docs:
        for c in chunk(d):
            assert len(c.text) < 2500, c.label


def test_error_codes_are_whole_tokens():
    assert tokens("AUTH_423_LOCKED") == ["auth_423_locked", "auth", "423", "locked"]
    assert "working" not in tokens("Why isn't authorization working?")
    bm = BM25(["| `AUTH_423_LOCKED` | Too many attempts |", "| `AUTH_403_SSO_REQUIRED` | SSO |",
               "lockout after 5 attempts"])
    assert int(np.argmax(bm.scores("error AUTH_423_LOCKED"))) == 0
    assert int(np.argmax(bm.scores("AUTH_403_SSO_REQUIRED"))) == 1


# --- the index, end to end, with a fake embedder ---

class FakeEmbedder:
    """Bag-of-words vectors over a fixed vocabulary: deterministic, no Ollama needed."""
    model = "fake"
    VOCAB = ["password", "sso", "invoice", "slack", "code", "lock", "export", "key"]

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
    def __init__(self):
        self.questions = []

    def scores(self, question, texts):
        self.questions.append(question)
        q = set(tokens(question))
        return [len(q & set(tokens(t))) / (len(q) or 1) for t in texts]


@pytest.fixture
def kb(tmp_path):
    d = tmp_path / "kb"
    d.mkdir()
    (d / "sign-in.md").write_text("# Signing in\n\n## Lockout\n\nFive wrong passwords lock the account: "
                                  "`AUTH_423_LOCKED`. Reset the password to unlock.\n")
    (d / "sso.md").write_text("# SSO\n\n## Require SSO\n\nWith SSO required the password form fails with "
                              "`AUTH_403_SSO_REQUIRED`.\n")
    (d / "billing.md").write_text("# Billing\n\nAn unpaid invoice suspends the workspace after 14 days.\n")
    return d


def test_build_is_incremental_and_search_ranks(kb, tmp_path):
    db = tmp_path / "index" / "index.db"
    with pytest.raises(IndexMissing):
        Retriever(db)
    emb = FakeEmbedder()
    store = Store(db)
    first = build(store, kb_dir=kb, embedder=emb)
    assert (first.added, first.changed, first.unchanged) == (3, 0, 0)
    calls = emb.calls
    again = build(store, kb_dir=kb, embedder=emb)
    assert (again.added, again.unchanged, emb.calls) == (0, 3, calls)
    (kb / "billing.md").write_text("# Billing\n\nInvoices are emailed.\n")
    (kb / "sso.md").unlink()
    third = build(store, kb_dir=kb, embedder=emb)
    assert (third.changed, third.removed, third.unchanged) == (1, 1, 1)
    store.close()

    rr = FakeReranker()
    r = Retriever(db, embedder=emb, reranker=rr)
    hits = r.search("can't sign in AUTH_423_LOCKED", k=2, rerank_query="can't sign in")
    assert hits[0].source == "kb/sign-in.md" and hits[0].label == "kb/sign-in.md › Signing in › Lockout"
    assert [h.rank for h in hits] == [1, 2]
    assert rr.questions == ["can't sign in"]
    r.close()
