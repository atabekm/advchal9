import pytest

from indexer.store import Store
from rag.retrieve import IndexMissing, Retriever
from tests.test_store import _doc, _write


class FakeEmbedder:
    def __init__(self, vec):
        self.vec = vec

    def query(self, text):
        return self.vec


def test_search_ranks_and_metadata(tmp_path):
    store = Store(tmp_path / "i.db")
    chunks, vecs, _, _ = _write(store, _doc())["struct"]
    store.close()
    r = Retriever(tmp_path / "i.db", embedder=FakeEmbedder(vecs[1]))
    hits = r.search("anything", "struct", k=2)
    assert [h.rank for h in hits] == [1, 2]
    assert hits[0].chunk_id == chunks[1].chunk_id and hits[0].source == "x.pdf"
    assert hits[0].score >= hits[1].score
    assert hits[0].pages.startswith("p")


def test_unknown_strategy_and_missing_index(tmp_path):
    with pytest.raises(IndexMissing):
        Retriever(tmp_path / "none.db")
    store = Store(tmp_path / "i.db")
    _write(store, _doc())
    store.close()
    with pytest.raises(ValueError):
        Retriever(tmp_path / "i.db", embedder=FakeEmbedder(None)).search("q", "semantic")
