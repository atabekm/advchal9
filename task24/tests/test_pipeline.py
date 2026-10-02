from dataclasses import replace

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


def test_rerank_threshold_drops_low_scores_and_may_keep_nothing():
    ret = FakeRetriever(_pool(-1, 4, -6, 0))  # sigmoid: .27 .98 .002 .5
    r = Pipeline(ret, Reranker(encoder=FakeEncoder())).retrieve("q", Config("rerank", 4, 3, threshold=0.3))
    assert [h.text for h in r.kept] == ["4", "0"] and len(r.ranked) == 4
    r = Pipeline(ret, Reranker(encoder=FakeEncoder())).retrieve("q", Config("rerank", 4, 3, threshold=0.99))
    assert r.kept == []


def test_cos_filter_keeps_chunks_near_the_best_cosine_score():
    hits = [replace(h, score=s) for h, s in zip(_pool(1, 2, 3, 4), (0.80, 0.77, 0.72, 0.70))]
    r = Pipeline(FakeRetriever(hits)).retrieve("q", Config("cos-filter", 4, 3, cos_delta=0.05))
    assert [h.score for h in r.kept] == [0.80, 0.77]  # 0.72 is too far; 0.70 is outside the top 3 anyway


def test_empty_context_refuses_without_the_llm():
    from rag import prompt
    from rag.agent import Agent
    from tests.test_agent import FakeLLM
    llm = FakeLLM()
    pipe = Pipeline(FakeRetriever(_pool(-5, -6)), Reranker(encoder=FakeEncoder()))
    ans = Agent(llm, pipe).answer("q", Config("rerank", 2, 2, threshold=0.5))
    assert ans.text == prompt.IDK and ans.unknown and ans.early_refusal and llm.calls == []
    assert not Agent(llm, pipe).answer("q", Config("base", 2, 2)).early_refusal



def test_below_threshold_asks_a_clarifying_question():
    from rag import prompt
    from rag.agent import Agent
    from rag.clarify import Clarifier
    from tests.test_agent import FakeLLM
    llm = FakeLLM("The collection covers TatarTTS and Gutless. Do you mean the calorie rules?")
    pipe = Pipeline(FakeRetriever(_pool(-5, -6)), Reranker(encoder=FakeEncoder()))
    ans = Agent(llm, pipe, clarifier=Clarifier(llm, ["TatarTTS", "Gutless"])).answer("creatine?", Config("rerank", 2, 2, threshold=0.5))
    system, user = llm.calls[0]
    assert len(llm.calls) == 1 and "- TatarTTS\n- Gutless" in system
    assert user.startswith("Question: creatine?") and "X Paper, 2 Data: -5" in user
    assert ans.early_refusal and ans.unknown and ans.clarification.startswith("The collection covers")
    assert ans.text == f"{prompt.IDK} {ans.clarification}" and ans.cited == []


def test_failed_clarifier_call_gives_a_bare_i_dont_know():
    from rag import prompt
    from rag.agent import Agent
    from rag.clarify import Clarifier
    from rag.llm import LLMError

    class Down:
        def chat(self, *a, **kw):
            raise LLMError("down")

    pipe = Pipeline(FakeRetriever(_pool(-5)), Reranker(encoder=FakeEncoder()))
    ans = Agent(Down(), pipe, clarifier=Clarifier(Down(), [])).answer("q", Config("rerank", 1, 1, threshold=0.5))
    assert ans.text == prompt.IDK and ans.clarification == ""

def test_mode_specs_and_labels():
    assert Config.parse("rerank@0.3").threshold == 0.3 and Config.parse("rerank@0.3").label == "rerank@0.3"
    assert Config.parse("rerank").label == "rerank" and Config.parse("rerank@0.05").label == "rerank"
    assert Config.parse("rewrite", k_after=3).k_after == 3
    with pytest.raises(ValueError):
        Config.parse("rerank@x")
