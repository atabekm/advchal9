import json

import pytest

from rag import prompt
from rag.agent import Agent
from rag.chat import ChatService
from rag.condense import Condenser, history_block, parse
from rag.llm import LLMError, Reply
from rag.pipeline import Config, Pipeline
from rag.retrieve import Hit
from rag.store import ChatStore, Message, SessionMissing

TEXT = "Eat 1 gram of protein per pound of goal body weight every day."


def _hit(rank, text=TEXT):
    return Hit(rank, 0.9 - rank / 10, f"g:struct:{rank:04d}", "Gutless.pdf", "Gutless", "Rule 2: Protein", 10, 10, text)


ANSWER = json.dumps({"status": "answer", "answer": "1 g per pound of goal weight [1].",
                     "citations": [{"ref": 1, "quote": "1 gram of protein per pound of goal body weight"}],
                     "clarification": ""})


class RoutingLLM:
    """Answers by prompt: the condenser gets `condensed` in turn, the cited prompt ANSWER, meta a text."""

    def __init__(self, *condensed, meta="You're welcome."):
        self.condensed, self.meta, self.calls = list(condensed), meta, []

    def chat(self, system, user, json=False):
        self.calls.append((system, user))
        if system.startswith("You prepare a user's chat message"):
            c = self.condensed.pop(0)
            if isinstance(c, Exception):
                raise c
            return Reply(c if isinstance(c, str) else _cond(*c), 10, 2, 0.1)
        if system == prompt.META_SYSTEM:
            return Reply(self.meta, 5, 3, 0.1)
        return Reply(ANSWER, 20, 5, 0.2)

    def systems(self):
        return [s.split("\n", 1)[0][:30] for s, _ in self.calls]


def _cond(kind, standalone=""):
    return json.dumps({"kind": kind, "standalone": standalone})


class FakeRetriever:
    def __init__(self):
        self.calls = []

    def search(self, question, strategy, k):
        self.calls.append(question)
        return [_hit(1), _hit(2)][:k]


def _service(llm, window=6):
    ret = FakeRetriever()
    agent = Agent(llm, Pipeline(ret), "cited")
    svc = ChatService(ChatStore(":memory:"), llm, agent, Condenser(llm, ["Gutless"]), config=Config("base", 2, 2),
                      window=window)
    return svc, ret


# --- store


def test_store_keeps_sessions_and_messages_in_order(tmp_path):
    db = tmp_path / "chat" / "chat.db"
    store = ChatStore(db)
    s = store.create_session()
    store.add_message(s.id, 1, "user", "hi")
    store.add_message(s.id, 1, "assistant", "hello", {"status": "meta"})
    store.close()

    store = ChatStore(db)  # survives a restart
    assert store.session(s.id).turns == 1
    msgs = store.messages(s.id)
    assert [(m.turn, m.role, m.text) for m in msgs] == [(1, "user", "hi"), (1, "assistant", "hello")]
    assert msgs[1].data == {"status": "meta"}
    assert [m.text for m in store.messages(s.id, last=1)] == ["hello"]


def test_store_lists_recent_first_and_deletes_with_messages():
    store = ChatStore(":memory:")
    a = store.create_session("a")
    store.create_session("b")
    store.add_message(a.id, 1, "user", "later")
    assert [s.title for s in store.sessions()] == ["a", "b"]
    store.delete_session(a.id)
    with pytest.raises(SessionMissing):
        store.messages(a.id)
    with pytest.raises(SessionMissing):
        store.delete_session("nope")


# --- condense


def test_parse_accepts_question_and_meta():
    assert parse(_cond("question", " How  much protein? ")) == ("question", "How much protein?")
    assert parse(_cond("meta", "ignored")) == ("meta", "")
    for bad in ("nope", _cond("chat", "x"), _cond("question", "")):
        with pytest.raises(LLMError):
            parse(bad)


def test_history_block_drops_markers_and_cuts_long_answers():
    block = history_block([Message(1, "user", "rules?"), Message(1, "assistant", "Calories [1] and protein [2]. " + "x" * 900)])
    assert block.startswith("User: rules?\nAssistant: Calories and protein.")
    assert block.endswith("…") and len(block) < 600


def test_condense_failure_searches_the_message_as_it_is():
    llm = RoutingLLM(LLMError("down"))
    c = Condenser(llm, []).condense("how much protein?", [])
    assert c.kind == "question" and c.standalone == "how much protein?" and "down" in c.error


# --- chat turns


def test_follow_up_is_condensed_and_the_standalone_question_is_retrieved():
    llm = RoutingLLM(("question", "What are the rules of fat loss in Gutless?"),
                     ("question", "How much protein per day does Gutless recommend?"))
    svc, ret = _service(llm)
    s = svc.store.create_session()
    t1 = svc.turn(s.id, "What are the rules of fat loss in Gutless?")
    t2 = svc.turn(s.id, "and how much protein?")

    assert ret.calls == ["What are the rules of fat loss in Gutless?", "How much protein per day does Gutless recommend?"]
    assert t2.turn == 2 and t2.status == "answer" and [h.rank for h in t2.answer.cited] == [1]
    # the second condense call saw the first exchange
    condense_user = llm.calls[2][1]
    assert "User: What are the rules" in condense_user and "Assistant: 1 g per pound" in condense_user
    # the answer prompt carries the conversation only once there is one
    assert llm.calls[1][0] == prompt.CITED_SYSTEM and "Recent conversation" not in llm.calls[1][1]
    assert llm.calls[3][0] == prompt.CITED_CHAT_SYSTEM and llm.calls[3][1].startswith("Recent conversation:\nUser:")
    assert t1.data()["sources"][0]["chunk_id"] == "g:struct:0001"


def test_meta_turn_skips_retrieval_and_has_no_sources():
    llm = RoutingLLM(("meta", ""))
    svc, ret = _service(llm)
    s = svc.store.create_session()
    t = svc.turn(s.id, "thanks!")
    assert ret.calls == [] and t.status == "meta" and t.answer is None and t.text == "You're welcome."
    assert llm.calls[-1][0] == prompt.META_SYSTEM and "New message: thanks!" in llm.calls[-1][1]
    data = t.data()
    assert data["kind"] == "meta" and "sources" not in data and data["tokens"] == {"prompt": 15, "completion": 5}


def test_turns_are_saved_and_the_first_message_names_the_session():
    llm = RoutingLLM(("question", "Protein in Gutless?"), ("meta", ""))
    svc, _ = _service(llm)
    s = svc.store.create_session()
    svc.turn(s.id, "Protein in Gutless?")
    svc.turn(s.id, "thanks")
    msgs = svc.store.messages(s.id)
    assert [(m.turn, m.role) for m in msgs] == [(1, "user"), (1, "assistant"), (2, "user"), (2, "assistant")]
    assert msgs[1].data["standalone"] == "Protein in Gutless?" and msgs[1].data["quotes"][0]["match"] == 100
    assert msgs[3].data["status"] == "meta"
    assert svc.store.session(s.id).title == "Protein in Gutless?"


def test_history_window_limits_what_the_prompts_see():
    llm = RoutingLLM(*[("question", f"q{i}") for i in range(1, 5)])
    svc, _ = _service(llm, window=2)
    s = svc.store.create_session()
    for i in range(1, 5):
        svc.turn(s.id, f"q{i}")
    last_condense = llm.calls[-2][1]
    assert "User: q3" in last_condense and "User: q2" not in last_condense


def test_a_failed_turn_saves_nothing():
    class Broken(RoutingLLM):
        def chat(self, system, user, json=False):
            if system == prompt.META_SYSTEM:
                raise LLMError("down")
            return super().chat(system, user, json)

    svc, _ = _service(Broken(("meta", "")))
    s = svc.store.create_session()
    with pytest.raises(LLMError):
        svc.turn(s.id, "thanks")
    assert svc.store.messages(s.id) == []


def test_empty_message_and_unknown_session_are_rejected():
    svc, _ = _service(RoutingLLM())
    with pytest.raises(ValueError):
        svc.turn("x", "  ")
    with pytest.raises(SessionMissing):
        svc.turn("missing", "hi")
