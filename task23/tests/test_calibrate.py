from dataclasses import replace

from rag import calibrate
from rag.evalset import Question, Source
from tests.test_agent import _hit


def _scored(qid, sources, chunks):
    """chunks: (source, rerank, cosine) in rerank order; cosine rank follows the cosine scores."""
    order = sorted(range(len(chunks)), key=lambda i: -chunks[i][2])
    cos_rank = {i: r for r, i in enumerate(order, start=1)}
    hits = [replace(_hit(i + 1), source=src, rerank=rr, score=cs, cosine_rank=cos_rank[i])
            for i, (src, rr, cs) in enumerate(chunks)]
    q = Question(qid, "fact" if sources else "unanswerable", "?", "", (), tuple(Source(s, ()) for s in sources))
    return calibrate.Scored(q, hits)


def _data():
    return [
        _scored("a", ["a.pdf"], [("a.pdf", 0.9, 0.70), ("x.pdf", 0.4, 0.80), ("x.pdf", 0.01, 0.60)]),
        _scored("b", ["b.pdf"], [("x.pdf", 0.5, 0.75), ("b.pdf", 0.08, 0.74)]),
        _scored("u", [], [("x.pdf", 0.3, 0.72), ("x.pdf", 0.02, 0.71)]),
    ]


def test_rerank_sweep_counts_hits_and_emptied_contexts():
    rows = {r.cutoff: r for r in calibrate.rerank_sweep(_data(), k_after=2, thresholds=(0.0, 0.05, 0.1, 0.35))}
    assert (rows[0.0].hits, rows[0.0].relevant_kept, rows[0.0].irrelevant_kept) == (2, 2, 4)
    assert rows[0.1].hits == 1 and rows[0.1].answerable_emptied == 0
    assert rows[0.35].unanswerable_emptied == 1
    assert calibrate.suggest(list(rows.values())).cutoff == 0.05


def test_cosine_sweep_uses_cosine_order():
    rows = calibrate.cosine_sweep(_data(), k_after=2, deltas=(0.2, 0.05))
    assert rows[0].hits == 2
    assert rows[1].hits == 1  # a.pdf is 0.10 below the best cosine of its question


def test_per_question():
    d = calibrate.per_question(_data()[0])
    assert (d["rel_rerank"], d["rel_rank"], d["irr_rerank"], d["top_cos"]) == (0.9, 1, 0.4, 0.80)
    assert calibrate.per_question(_data()[2])["rel_rerank"] is None
