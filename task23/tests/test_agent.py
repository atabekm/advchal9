import pytest

from rag import prompt
from rag.agent import Agent
from rag.pipeline import Config, Pipeline
from rag.llm import LLMError, Reply, api_key
from rag.retrieve import Hit


def _hit(rank, text="chunk text", section="2 Data"):
    return Hit(rank, 0.9 - rank / 10, f"x:struct:{rank:04d}", "x.pdf", "X Paper", section, rank, rank, text)


class FakeLLM:
    def __init__(self, text="ok"):
        self.text, self.calls = text, []

    def chat(self, system, user):
        self.calls.append((system, user))
        return Reply(self.text, 10, 2, 0.1)


class FakeRetriever:
    def __init__(self, hits):
        self.hits, self.calls = hits, []

    def search(self, question, strategy, k):
        self.calls.append((question, strategy, k))
        return self.hits[:k]


def test_context_block_numbers_chunks_with_metadata():
    block = prompt.context_block([_hit(1, "alpha"), _hit(2, "beta", section="")])
    assert block.startswith("[1] X Paper (x.pdf), p. 1, section: 2 Data\nalpha")
    assert "\n\n[2] X Paper (x.pdf), p. 2\nbeta" in block


def test_rag_mode_sends_context_then_question():
    llm, ret = FakeLLM("70 hours [2], two speakers [1, 2]. [9] is not a chunk."), FakeRetriever([_hit(i) for i in range(1, 5)])
    ans = Agent(llm, Pipeline(ret)).answer("How long?", Config("base", k_before=4, k_after=3))
    system, user = llm.calls[0]
    assert system == prompt.RAG_SYSTEM
    assert user.startswith("Context:\n\n[1] ") and user.endswith("Question: How long?")
    assert "[4]" not in user
    assert ret.calls == [("How long?", "struct", 4)]
    assert ans.label == "base" and len(ans.hits) == 3
    assert [h.rank for h in ans.cited] == [2, 1]


def test_precomputed_retrieval_skips_the_pipeline():
    llm, ret = FakeLLM(), FakeRetriever([_hit(1), _hit(2)])
    r = Pipeline(ret).retrieve("q", Config("base", 2, 1))
    ans = Agent(llm).answer("q", retrieval=r)
    assert len(ret.calls) == 1 and ans.hits == r.kept


def test_plain_mode_skips_retrieval():
    llm, ret = FakeLLM(), FakeRetriever([_hit(1)])
    ans = Agent(llm, Pipeline(ret)).answer("How long?")
    assert llm.calls == [(prompt.PLAIN_SYSTEM, "How long?")] and ret.calls == []
    assert ans.label == "plain" and ans.hits == [] and ans.cited == []


def test_rag_mode_needs_a_pipeline():
    with pytest.raises(ValueError):
        Agent(FakeLLM()).answer("q", Config("base"))


def test_api_key_from_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    env = tmp_path / ".env"
    env.write_text("# comment\nDEEPSEEK_API_KEY='sk-test'\n")
    assert api_key(env) == "sk-test"
    with pytest.raises(LLMError):
        api_key(tmp_path / "missing")
