import json

import pytest

from rag import prompt
from rag.agent import Agent
from rag.pipeline import Config, Pipeline
from rag.llm import LLMError, LocalLLM, Reply
from rag.retrieve import Hit


TEXT = "The corpus holds 70 hours of speech, recorded by two speakers in a studio."


def _hit(rank, text=TEXT, section="2 Data"):
    return Hit(rank, 0.9 - rank / 10, f"x:struct:{rank:04d}", "x.pdf", "X Paper", section, rank, rank, text)


def _json(status="answer", answer="", citations=(), clarification=""):
    return json.dumps({"status": status, "answer": answer, "citations": list(citations), "clarification": clarification})


GOOD = _json(answer="70 hours [2], two speakers [1].",
             citations=[{"ref": 2, "quote": "70 hours of speech"}, {"ref": 1, "quote": "two speakers"}])


class FakeLLM:
    """Replies with the given texts in turn; the last one repeats."""

    def __init__(self, *texts):
        self.texts, self.calls = list(texts) or ["ok"], []

    def chat(self, system, user, json=False):
        self.calls.append((system, user))
        return Reply(self.texts[min(len(self.calls), len(self.texts)) - 1], 10, 2, 0.1)


class FakeRetriever:
    def __init__(self, hits):
        self.hits, self.calls = hits, []

    def search(self, question, strategy, k):
        self.calls.append((question, strategy, k))
        return self.hits[:k]


def _ask(llm, n=4, k_after=3, style="cited"):
    ret = FakeRetriever([_hit(i) for i in range(1, n + 1)])
    return Agent(llm, Pipeline(ret), style).answer("How long?", Config("base", k_before=n, k_after=k_after)), ret


def test_context_block_numbers_chunks_with_metadata():
    block = prompt.context_block([_hit(1, "alpha"), _hit(2, "beta", section="")])
    assert block.startswith("[1] X Paper (x.pdf), p. 1, section: 2 Data\nalpha")
    assert "\n\n[2] X Paper (x.pdf), p. 2\nbeta" in block


def test_cited_answer_has_sources_and_quotes():
    llm = FakeLLM(GOOD)
    ans, ret = _ask(llm)
    system, user = llm.calls[0]
    assert system == prompt.CITED_SYSTEM
    assert user.startswith("Context:\n\n[1] ") and "Question: How long?" in user and "[4]" not in user
    assert ret.calls == [("How long?", "struct", 4)]
    assert ans.status == "answer" and ans.text == "70 hours [2], two speakers [1]."
    assert [h.rank for h in ans.cited] == [2, 1] and ans.cited[0].chunk_id == "x:struct:0002"
    assert [(q.ref, q.text) for q in ans.quotes] == [(2, "70 hours of speech"), (1, "two speakers")]
    assert ans.attempts == 1 and ans.format_error == ""


def test_quoted_but_unmarked_passage_is_a_source():
    llm = FakeLLM(_json(answer="70 hours.", citations=[{"ref": 3, "quote": "70 hours"}]))
    ans, _ = _ask(llm)
    assert [h.rank for h in ans.cited] == [3]


@pytest.mark.parametrize("bad, error", [
    ("not json", "not valid JSON"),
    (_json(answer="70 hours [1]."), "at least one citation"),
    (_json(answer="70 hours [1].", citations=[{"ref": 9, "quote": "70 hours"}]), "ref 9"),
    (_json(answer="70 hours [4].", citations=[{"ref": 1, "quote": "70 hours"}]), "cites [4]"),
    (_json(answer="70 hours [1], [2].", citations=[{"ref": 1, "quote": "70 hours"}]), "no citation quotes passage 2"),
    (_json(status="unknown"), "clarification"),
    (_json(status="maybe"), '"status"'),
])
def test_bad_reply_is_retried_with_the_error(bad, error):
    llm = FakeLLM(bad, GOOD)
    ans, _ = _ask(llm)
    assert len(llm.calls) == 2 and error in llm.calls[1][1] and "previous reply was rejected" in llm.calls[1][1]
    assert ans.status == "answer" and ans.attempts == 2 and error in ans.format_error
    assert ans.prompt_tokens == 20


def test_two_bad_replies_give_i_dont_know_without_sources():
    llm = FakeLLM("not json")
    ans, _ = _ask(llm)
    assert len(llm.calls) == 2
    assert ans.unknown and ans.text == prompt.IDK and ans.cited == [] and ans.quotes == []


def test_unknown_status_returns_the_clarifying_question():
    llm = FakeLLM(_json(status="unknown", clarification="Do you mean the TatarTTS paper?"))
    ans, _ = _ask(llm)
    assert ans.unknown and ans.clarification == "Do you mean the TatarTTS paper?"
    assert ans.text == f"{prompt.IDK} Do you mean the TatarTTS paper?" and ans.cited == []


def test_json_in_a_fence_and_string_refs_are_accepted():
    fenced = "```json\n" + _json(answer="x [1].", citations=[{"ref": "[1]", "quote": "two speakers"}]) + "\n```"
    ans, _ = _ask(FakeLLM(fenced))
    assert ans.status == "answer" and ans.quotes[0].ref == 1 and ans.attempts == 1


def test_quote_not_in_its_chunk_is_retried_then_dropped():
    bad = _json(answer="70 hours [1], recorded in Kazan [2].",
                citations=[{"ref": 1, "quote": "70 hours of speech"}, {"ref": 2, "quote": "recorded in Kazan in 2023"}])
    llm = FakeLLM(bad)
    ans, _ = _ask(llm)
    assert len(llm.calls) == 2 and "not copied word for word" in llm.calls[1][1] and "[2]" in llm.calls[1][1]
    assert ans.status == "answer" and [q.ref for q in ans.quotes] == [1] and ans.quotes[0].score == 100
    assert [q.ref for q in ans.failed_quotes] == [2] and ans.failed_quotes[0].score < 90


def test_answer_with_no_verified_quote_is_i_dont_know():
    llm = FakeLLM(_json(answer="Recorded in Kazan [1].", citations=[{"ref": 1, "quote": "recorded in Kazan in 2023"}]))
    ans, _ = _ask(llm)
    assert ans.unknown and ans.text == prompt.IDK and ans.cited == [] and len(ans.failed_quotes) == 1


def test_fixed_quote_on_retry_is_accepted():
    bad = _json(answer="70 hours [1].", citations=[{"ref": 1, "quote": "seventy hours of audio"}])
    ans, _ = _ask(FakeLLM(bad, GOOD))
    assert ans.status == "answer" and ans.failed_quotes == [] and ans.attempts == 2 and "word for word" in ans.format_error


def test_legacy_style_reads_markers_from_free_text():
    llm = FakeLLM("70 hours [2], two speakers [1, 2]. [9] is not a chunk.")
    ans, _ = _ask(llm, style="legacy")
    assert llm.calls[0][0] == prompt.RAG_SYSTEM
    assert ans.label == "legacy:base" and [h.rank for h in ans.cited] == [2, 1] and ans.quotes == []


def test_precomputed_retrieval_skips_the_pipeline():
    llm, ret = FakeLLM(GOOD), FakeRetriever([_hit(1), _hit(2)])
    r = Pipeline(ret).retrieve("q", Config("base", 2, 2))
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


class _Resp:
    def __init__(self, status, data):
        self.status_code, self._data, self.text = status, data, str(data)

    def json(self):
        return self._data


def test_local_llm_request_and_reply(monkeypatch):
    sent = {}

    def post(url, json, timeout):
        sent.update(url=url, body=json)
        return _Resp(200, {"message": {"content": " {\"a\": 1} "}, "prompt_eval_count": 12, "eval_count": 5})

    monkeypatch.setattr("rag.llm.requests.post", post)
    reply = LocalLLM("qwen3:8b", base_url="localhost:11434").chat("sys", "user", json=True)
    assert sent["url"] == "http://localhost:11434/api/chat"
    body = sent["body"]
    assert body["model"] == "qwen3:8b" and body["think"] is False and body["stream"] is False
    assert body["format"] == "json" and body["options"]["temperature"] == 0.0
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert (reply.text, reply.prompt_tokens, reply.completion_tokens) == ('{"a": 1}', 12, 5)


def test_local_llm_errors(monkeypatch):
    monkeypatch.setattr("rag.llm.requests.post", lambda *a, **k: _Resp(404, {"error": "model 'x' not found"}))
    with pytest.raises(LLMError, match="ollama pull x"):
        LocalLLM("x").chat("s", "u")

    def refused(*a, **k):
        import requests
        raise requests.ConnectionError("refused")

    monkeypatch.setattr("rag.llm.requests.post", refused)
    with pytest.raises(LLMError, match="ollama serve"):
        LocalLLM().chat("s", "u")


def test_clarification_drops_markers_and_a_repeated_i_dont_know():
    llm = FakeLLM(_json(status="unknown", clarification="I don't know: the passages cover MOS [3] and anaphora [1, 2]. Which?"))
    ans, _ = _ask(llm)
    assert ans.clarification == "the passages cover MOS and anaphora. Which?"


def test_local_llm_passes_a_json_schema(monkeypatch):
    from rag.memory import OPS_SCHEMA
    sent = {}

    def post(url, json, timeout):
        sent.update(json)
        return _Resp(200, {"message": {"content": '{"ops": []}'}})

    monkeypatch.setattr("rag.llm.requests.post", post)
    LocalLLM().chat("s", "u", json=OPS_SCHEMA)
    assert sent["format"] is OPS_SCHEMA
    ops = OPS_SCHEMA["properties"]["ops"]["items"]["anyOf"]
    assert [o["properties"]["op"]["enum"] for o in ops] == [["set_goal"], ["add"], ["remove"], ["set_scope"]]
