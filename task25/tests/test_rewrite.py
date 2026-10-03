import pytest

from rag.llm import LLMError, Reply
from rag.pipeline import Config, Pipeline
from rag.rerank import Reranker
from rag.rewrite import Rewriter, parse
from tests.test_agent import _hit
from tests.test_pipeline import FakeEncoder


class ScriptedLLM:
    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def chat(self, system, user):
        self.calls.append((system, user))
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return Reply(r, 50, 10, 0.2)


class MultiRetriever:
    """search(q) returns the hits listed for q; search_many fuses like the real one."""

    def __init__(self, by_query):
        self.by_query, self.calls = by_query, []

    def search(self, q, strategy, k):
        self.calls.append(q)
        return self.by_query.get(q, [])[:k]

    def search_many(self, queries, strategy, k):
        from rag.retrieve import Retriever
        return Retriever.search_many(self, queries, strategy, k)


def test_parse():
    assert parse('Here: {"queries": ["a", " b ", "a", "", 3]}') == ("a", "b")
    assert parse('{"queries": ["1", "2", "3", "4"]}') == ("1", "2", "3")
    for bad in ("no json", '{"q": []}', '{"queries": "a"}', '{"queries": []}'):
        with pytest.raises(LLMError):
            parse(bad)


def test_rewriter_lists_titles_caches_and_falls_back():
    llm = ScriptedLLM('{"queries": ["TatarTTS dataset construction"]}', "sorry", LLMError("down"))
    rw = Rewriter(llm, ["TatarTTS: a dataset", "GUTLESS"])
    assert "- TatarTTS: a dataset\n- GUTLESS" in rw.system
    first = rw.rewrite("that Turkic dataset?")
    assert first.queries == ("TatarTTS dataset construction",) and first.prompt_tokens == 50
    assert rw.rewrite("that Turkic dataset?") is first and len(llm.calls) == 1
    bad = rw.rewrite("q2")
    assert bad.queries == () and "no JSON" in bad.error
    assert rw.rewrite("q3").error == "down"


def _h(chunk, rank, score, text="0"):
    from dataclasses import replace
    return replace(_hit(rank, text), chunk_id=chunk, score=score)


def test_search_many_fuses_by_reciprocal_rank_and_keeps_best_cosine():
    ret = MultiRetriever({"q": [_h("a", 1, .8), _h("b", 2, .7)], "r": [_h("c", 1, .9), _h("b", 2, .75)]})
    hits = ret.search_many(["q", "r"], "struct", 2)
    assert [h.chunk_id for h in hits] == ["b", "a", "c"]  # b is found by both queries
    assert [h.rank for h in hits] == [1, 2, 3] and hits[0].score == .75


def test_rewrite_modes_search_the_question_and_its_rewrites():
    by_query = {"q": [_h("a", 1, .8, "-3"), _h("b", 2, .7, "-4")], "Apertium Tatar": [_h("c", 1, .9, "-5")]}
    ret = MultiRetriever(by_query)
    llm = ScriptedLLM('{"queries": ["Apertium Tatar", "q"]}')
    pipe = Pipeline(ret, Reranker(encoder=FakeEncoder()), Rewriter(llm, []))
    r = pipe.retrieve("q", Config("rewrite", 2, 2))
    assert r.queries == ["q", "Apertium Tatar"] and set(r.timings) == {"rewrite", "search"}
    assert [h.chunk_id for h in r.kept] == ["a", "c"]  # both rank 1 in their query, then b
    r = pipe.retrieve("q", Config("rewrite+rerank", 2, 2, threshold=0.0))
    assert len(llm.calls) == 1  # cached
    assert [h.chunk_id for h in r.kept] == ["a", "b"]


def test_rerank_scores_each_chunk_by_its_best_query():
    class ByQuery:
        def predict(self, pairs, show_progress_bar=False):
            return [5.0 if q == "Apertium Tatar" and t == "apertium" else -5.0 for q, t in pairs]

    hits = [_hit(1, "tatartts"), _hit(2, "apertium")]
    assert [h.text for h in Reranker(encoder=ByQuery()).rerank("q", hits)][0] == "tatartts"  # ties keep order
    ranked = Reranker(encoder=ByQuery()).rerank(["q", "Apertium Tatar"], hits)
    assert ranked[0].text == "apertium" and ranked[0].rerank > 0.99


def test_per_mode_default_threshold():
    assert Config("rerank").threshold == 0.05 and Config("rewrite+rerank").threshold == 0.3
    assert Config("rerank", threshold=0.5).threshold == 0.5 and Config("base").threshold == 0.0
    with pytest.raises(ValueError):
        Pipeline(MultiRetriever({})).retrieve("q", Config("rewrite"))
