import json
from dataclasses import replace

from indexer.store import Store
from rag import prompt
from rag.agent import Agent
from rag.chat import ChatService
from rag.condense import Condenser
from rag.llm import LLMError, Reply
from rag.memory import MemoryUpdater, TaskMemory, apply, parse
from rag.pipeline import Config, Pipeline
from rag.retrieve import Retriever
from rag.store import ChatStore
from tests.test_chat import ANSWER, FakeRetriever, _cond
from tests.test_retrieve import FakeEmbedder
from tests.test_store import _doc, _write

SOURCES = ["Gutless.pdf", "1570978467.pdf"]


# --- edits


def test_add_gives_ids_that_are_never_reused():
    m = TaskMemory()
    changes, errors = apply(m, [{"op": "add", "field": "clarified", "text": "is vegetarian"},
                                {"op": "add", "field": "constraints", "text": "short answers"}], 1, SOURCES)
    assert errors == [] and [i.id for i in m.items()] == ["c1", "k2"]
    apply(m, [{"op": "remove", "id": "k2"}, {"op": "add", "field": "constraints", "text": "use kg"}], 2, SOURCES)
    assert [(i.id, i.text, i.turn) for i in m.constraints] == [("k3", "use kg", 2)]
    assert [c.op for c in changes] == ["add", "add"] and changes[0].field == "clarified"


def test_bad_edits_are_rejected_with_a_reason():
    m = TaskMemory()
    apply(m, [{"op": "add", "field": "terms", "text": "TDEE = total daily energy expenditure"}], 1, SOURCES)
    changes, errors = apply(m, [
        {"op": "add", "field": "facts", "text": "x"},
        {"op": "add", "field": "terms", "text": "tdee = total daily energy expenditure."},  # duplicate
        {"op": "add", "field": "terms", "text": "  "},
        {"op": "remove", "id": "c9"},
        {"op": "rewrite"},
        "nonsense",
        {"op": "set_goal"},
    ], 2, SOURCES)
    assert changes == [] and len(errors) == 7
    assert "facts" in errors[0] and "already" in errors[1] and "c9" in errors[3]
    assert len(m.terms) == 1


def test_goal_is_set_and_changed_only_when_different():
    m = TaskMemory()
    c1, _ = apply(m, [{"op": "set_goal", "text": "Lose 8 kg using Gutless"}], 1, SOURCES)
    c2, _ = apply(m, [{"op": "set_goal", "text": "lose 8 kg using gutless."}], 2, SOURCES)
    assert len(c1) == 1 and c2 == [] and m.goal_turn == 1


def test_scope_takes_known_documents_and_all_means_none():
    m = TaskMemory()
    changes, _ = apply(m, [{"op": "set_scope", "sources": ["Gutless.pdf"]}], 1, SOURCES)
    assert m.scope == ["Gutless.pdf"] and changes[0].text == "Gutless.pdf"
    _, errors = apply(m, [{"op": "set_scope", "sources": ["gutless"]}], 2, SOURCES)
    assert "unknown documents" in errors[0] and m.scope == ["Gutless.pdf"]
    changes, _ = apply(m, [{"op": "set_scope", "sources": SOURCES}], 3, SOURCES)
    assert m.scope == [] and changes[0].text == "all documents"


def test_block_and_round_trip():
    m = TaskMemory()
    assert m.empty and m.block() == ""
    apply(m, [{"op": "set_goal", "text": "Plan a TTS dataset"},
              {"op": "add", "field": "terms", "text": "'the paper' = TatarTTS"}], 1, SOURCES)
    assert m.block() == "Goal: Plan a TTS dataset\nTerms:\n- 'the paper' = TatarTTS"
    full = m.block(with_ids=True)
    assert "- [t1] 'the paper' = TatarTTS" in full and "Clarified by the user:\n- none" in full
    assert full.endswith("Scope: all documents")
    assert TaskMemory.from_dict(json.loads(json.dumps(m.to_dict()))) == m


def test_parse_needs_an_ops_list():
    assert parse('{"ops": []}') == []
    for bad in ("nope", '{"ops": {}}', '["x"]'):
        try:
            parse(bad)
        except LLMError:
            continue
        raise AssertionError(bad)


class OneReply:
    def __init__(self, text=None, error=None):
        self.text, self.error, self.calls = text, error, []

    def chat(self, system, user, json=False):
        self.calls.append((system, user))
        if self.error:
            raise self.error
        return Reply(self.text, 30, 10, 0.2)


def test_updater_sends_memory_with_ids_and_the_turn():
    llm = OneReply('{"ops": [{"op": "add", "field": "clarified", "text": "is vegetarian"}]}')
    m = TaskMemory(goal="Lose fat")
    u = MemoryUpdater(llm, [("Gutless.pdf", "Gutless")]).update(m, 3, "I'm vegetarian, protein?",
                                                                "Protein for vegetarians in Gutless?", "Eat beans [1].", "answer")
    system, user = llm.calls[0]
    assert "- Gutless.pdf: Gutless" in system
    assert "Goal: Lose fat" in user and "Latest turn (turn 3)" in user and "(read as: Protein for vegetarians" in user
    assert "Assistant (answer): Eat beans [1]." in user
    assert [c.id for c in u.changes] == ["c1"] and m.clarified[0].turn == 3 and u.prompt_tokens == 30


def test_a_failed_update_changes_nothing():
    m = TaskMemory(goal="x")
    for llm in (OneReply(error=LLMError("down")), OneReply("not json")):
        u = MemoryUpdater(llm, []).update(m, 1, "hi", "", "hello", "meta")
        assert u.changes == [] and u.errors and m == TaskMemory(goal="x")


# --- scope in retrieval


def test_scope_limits_the_search_to_its_documents(tmp_path):
    store = Store(tmp_path / "i.db")
    x = _write(store, _doc())["struct"]
    _write(store, replace(_doc("b"), source="y.pdf", title="Y"))
    store.close()
    r = Retriever(tmp_path / "i.db", embedder=FakeEmbedder(x[1][0]))
    assert {h.source for h in r.search("q", "struct", k=20)} == {"x.pdf", "y.pdf"}
    only_y = r.search("q", "struct", k=20, sources=["y.pdf"])
    assert only_y and {h.source for h in only_y} == {"y.pdf"} and [h.rank for h in only_y] == list(range(1, len(only_y) + 1))
    assert r.documents() == [("x.pdf", "X"), ("y.pdf", "Y")]


# --- in the chat


class MemoryLLM:
    """Routes by prompt; the memory updater replies with the next of `updates`."""

    model = "fake"

    def __init__(self, condensed, updates):
        self.condensed, self.updates, self.calls = list(condensed), list(updates), []

    def chat(self, system, user, json=False):
        self.calls.append((system, user))
        if system.startswith("You prepare a user's chat message"):
            return Reply(_cond(*self.condensed.pop(0)), 10, 2, 0.1)
        if system.startswith("You keep the task memory"):
            return Reply(self.updates.pop(0), 30, 10, 0.1)
        if system == prompt.META_SYSTEM:
            return Reply("Your goal is to lose fat.", 5, 3, 0.1)
        return Reply(ANSWER, 20, 5, 0.2)

    def prompts(self, start):
        return [u for s, u in self.calls if s.startswith(start)]


class ScopedRetriever(FakeRetriever):
    def search(self, question, strategy, k, sources=()):
        hits = super().search(question, strategy, k)
        self.calls[-1] = (question, tuple(sources))
        return hits


def _service(llm, memory=True):
    ret = ScopedRetriever()
    agent = Agent(llm, Pipeline(ret), "cited")
    updater = MemoryUpdater(llm, [(s, s) for s in SOURCES]) if memory else None
    return ChatService(ChatStore(":memory:"), llm, agent, Condenser(llm, []), updater, Config("base", 2, 2)), ret


def test_memory_reaches_every_prompt_and_its_scope_the_search():
    llm = MemoryLLM(
        [("question", "Gutless fat loss rules?"), ("question", "Protein for vegetarians in Gutless?"), ("meta", "")],
        ['{"ops": [{"op": "set_goal", "text": "Lose 8 kg with Gutless"},'
         ' {"op": "set_scope", "sources": ["Gutless.pdf"]}, {"op": "add", "field": "constraints", "text": "short answers"}]}',
         '{"ops": [{"op": "add", "field": "clarified", "text": "is vegetarian"}, {"op": "remove", "id": "zz"}]}',
         '{"ops": []}'])
    svc, ret = _service(llm)
    s = svc.store.create_session()
    t1 = svc.turn(s.id, "I want to lose 8 kg with Gutless, keep it short. What are the rules?")
    t2 = svc.turn(s.id, "I'm vegetarian, how much protein?")
    t3 = svc.turn(s.id, "what was my goal again?")

    # turn 1 searched everything; the scope set after it limits turn 2
    assert ret.calls == [("Gutless fat loss rules?", ()), ("Protein for vegetarians in Gutless?", ("Gutless.pdf",))]
    assert [c.op for c in t1.update.changes] == ["set_goal", "set_scope", "add"]
    assert t2.update.errors == ["remove: no item 'zz'"] and t2.memory.clarified[0].text == "is vegetarian"
    assert t2.answer.retrieval.config.sources == ("Gutless.pdf",)

    condense_2 = llm.prompts("You prepare")[1]
    assert "Task memory" in condense_2 and "Goal: Lose 8 kg with Gutless" in condense_2
    answer_2 = [u for sys, u in llm.calls if sys == prompt.CITED_CHAT_SYSTEM][-1]
    assert answer_2.startswith("Task memory (established earlier") and "- short answers" in answer_2
    assert "Question: Protein for vegetarians in Gutless?\n\nThe user's constraints for every answer (follow them): short answers." in answer_2
    meta_3 = [u for sys, u in llm.calls if sys == prompt.META_SYSTEM][0]
    assert "- is vegetarian" in meta_3 and meta_3.endswith("(follow them): short answers.") and t3.status == "meta"

    # saved: the memory, its log, and each reply's changes
    saved = svc.memory(s.id)
    assert saved.goal == "Lose 8 kg with Gutless" and saved.scope == ["Gutless.pdf"]
    assert [c["op"] for c in svc.store.memory_log(s.id)] == ["set_goal", "set_scope", "add", "add"]
    msgs = svc.store.messages(s.id)
    assert msgs[1].data["memory_changes"][0]["text"] == "Lose 8 kg with Gutless"
    assert msgs[3].data["memory"]["clarified"][0]["id"] == "c2" and msgs[5].data["memory_changes"] == []


def test_first_answer_with_an_empty_memory_has_no_conversation_block():
    llm = MemoryLLM([("question", "Rules?")], ['{"ops": []}'])
    svc, _ = _service(llm)
    svc.turn(svc.store.create_session().id, "Rules?")
    assert [s for s, _ in llm.calls if s.startswith("You answer")] == [prompt.CITED_SYSTEM]


def test_memory_off_makes_no_update_call_and_keeps_no_scope():
    llm = MemoryLLM([("question", "Rules?"), ("question", "Protein?")], [])
    svc, ret = _service(llm, memory=False)
    s = svc.store.create_session()
    t = svc.turn(s.id, "Rules?")
    svc.turn(s.id, "Protein?")
    assert llm.prompts("You keep the task memory") == [] and t.update is None and t.memory is None
    assert [c[1] for c in ret.calls] == [(), ()]
    assert svc.store.memory(s.id) is None and "memory" not in svc.store.messages(s.id)[1].data
    assert "Task memory" not in llm.prompts("You prepare")[1]
