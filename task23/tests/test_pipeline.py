import pytest

from rag.pipeline import Config, Pipeline
from rag.rerank import Reranker
from tests.test_agent import FakeRetriever, _hit


class FakeEncoder:
    """Logit = the number written in the chunk text, so the test decides the order."""

    def __init__(self):
        self.calls = []

    def predict(self, pairs, show_progress_bar=False):
        self.calls.append(pairs)
        return [float(text) for _, text in pairs]


def _pool(*logits):
    return [_hit(i, str(x)) for i, x in enumerate(logits, start=1)]


def test_rerank_orders_by_sigmoid_score_and_keeps_cosine_rank():
    enc = FakeEncoder()
    hits = Reranker(encoder=enc).rerank("q", _pool(-2, 3, 0))
    assert [h.rank for h in hits] == [1, 2, 3]
    assert [h.cosine_rank for h in hits] == [2, 3, 1]
    assert hits[1].rerank == pytest.approx(0.5) and 0.95 < hits[0].rerank < 1 and hits[2].rerank < 0.15
    assert enc.calls[0][0] == ("q", "-2")
    assert Reranker(encoder=enc).rerank("q", []) == []


def test_base_keeps_cosine_head_of_the_pool():
    ret = FakeRetriever(_pool(1, 2, 3, 4))
    r = Pipeline(ret, Reranker(encoder=FakeEncoder())).retrieve("q", Config("base", 4, 2))
    assert ret.calls == [("q", "struct", 4)]
    assert [h.text for h in r.kept] == ["1", "2"] and len(r.pool) == 4
    assert "rerank" not in r.timings and all(h.rerank is None for h in r.kept)


def test_rerank_mode_promotes_from_deep_in_the_pool():
    r = Pipeline(FakeRetriever(_pool(0, -1, -3, 5)), Reranker(encoder=FakeEncoder())).retrieve("q", Config("rerank", 4, 2))
    assert [(h.rank, h.cosine_rank, h.text) for h in r.kept] == [(1, 4, "5"), (2, 1, "0")]
    assert [h.text for h in r.ranked] == ["5", "0", "-1", "-3"]
    assert set(r.timings) == {"search", "rerank"}


def test_config_validation():
    with pytest.raises(ValueError):
        Config("hybrid")
    with pytest.raises(ValueError):
        Config("base", k_before=3, k_after=5)
    with pytest.raises(ValueError):
        Pipeline(FakeRetriever(_pool(1))).retrieve("q", Config("rerank", 1, 1))
