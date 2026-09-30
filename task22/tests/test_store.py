import numpy as np

from indexer.chunk_fixed import chunk_fixed
from indexer.chunk_struct import chunk_struct
from indexer.extract import Document, Element
from indexer.store import Store

SENT = "The quick brown fox jumps over the lazy dog again and again."


def _doc(sha="a"):
    els = [Element("heading", "1 Intro", 1, 1), Element("para", " ".join([SENT] * 30), 1),
           Element("heading", "2 End", 2, 1), Element("para", " ".join([SENT] * 10), 2)]
    return Document("x.pdf", "X", 2, sha, "outline", els)


def _vecs(n, dim=8, seed=0):
    v = np.random.default_rng(seed).normal(size=(n, dim)).astype(np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def _write(store, doc):
    results = {}
    for name, fn in (("fixed", chunk_fixed), ("struct", chunk_struct)):
        chunks = fn(doc)
        results[name] = (chunks, _vecs(len(chunks)), 10, 0.1)
    store.replace_document(doc, results)
    return results


def test_roundtrip_and_search(tmp_path):
    store = Store(tmp_path / "i.db")
    results = _write(store, _doc())
    chunks, vecs, _, _ = results["struct"]
    rows, mat = store.matrix("struct")
    assert [r["chunk_id"] for r in rows] == [c.chunk_id for c in chunks]
    assert np.allclose(mat, vecs)
    assert rows[0]["section"] == "1 Intro" and rows[0]["source"] == "x.pdf"
    score, row = store.search("struct", vecs[1], k=1)[0]
    assert row["chunk_id"] == chunks[1].chunk_id and abs(score - 1) < 1e-5


def test_replace_and_delete_cascade(tmp_path):
    store = Store(tmp_path / "i.db")
    _write(store, _doc("a"))
    n = len(store.chunks())
    _write(store, _doc("b"))  # re-index: no duplicates
    assert len(store.chunks()) == n
    assert store.document_sha("x.pdf") == "b"
    store.delete_document("x.pdf")
    assert store.chunks() == [] and store.embed_runs() == []
