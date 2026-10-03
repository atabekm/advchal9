import json

import pytest

from rag import scenario, scenario_report
from rag.chat import ChatService
from rag.llm import Reply
from rag.store import ChatStore
from tests.test_memory import MemoryLLM, _service

SCENARIOS = [{
    "id": "t1", "title": "Test",
    "turns": [
        {"text": "Lose 8 kg with Gutless, short answers. Rules?", "expect": "answer", "sources": ["Gutless.pdf"],
         "sets": {"goal": "lose 8 kg", "constraints": ["short answers"], "scope": ["Gutless.pdf"]}},
        {"text": "Use kg.", "expect": "meta", "sets": {"constraints": ["use kg"]}},
        {"text": "And protein?", "expect": "answer", "sources": ["Gutless.pdf"], "means": "Protein per day in Gutless",
         "must_contain": [["kg", "kilogram"]]},
    ],
}]


def _load(tmp_path, data=SCENARIOS):
    p = tmp_path / "s.json"
    p.write_text(json.dumps(data))
    return scenario.load(p)


def test_the_shipped_scenarios_load_and_are_long_enough():
    for s in scenario.load():
        assert 10 <= len(s.turns) <= 15
        assert scenario.truth(s)[-1]["goal"]


def test_load_rejects_bad_expectations(tmp_path):
    bad = json.loads(json.dumps(SCENARIOS))
    bad[0]["turns"][0]["expect"] = "maybe"
    with pytest.raises(ValueError):
        _load(tmp_path, bad)
    bad[0]["turns"][0]["expect"] = "answer"
    bad[0]["turns"][0]["sets"]["mood"] = "x"
    with pytest.raises(ValueError):
        _load(tmp_path, bad)


def test_truth_accumulates_and_scope_replaces(tmp_path):
    s = _load(tmp_path)[0]
    states = scenario.truth(s)
    assert states[0]["constraints"] == ["short answers"] and states[1]["constraints"] == ["short answers", "use kg"]
    assert states[2]["scope"] == ["Gutless.pdf"] and states[2]["goal"] == "lose 8 kg"
    assert "Constraints: short answers; use kg" in scenario.truth_block(states[2])


def test_checks_without_an_llm(tmp_path):
    t = _load(tmp_path)[0].turns[2]
    state = scenario.truth(_load(tmp_path)[0])[2]
    good = {"reply": "1 g per pound (2.2 g per kg) [1].",
            "data": {"status": "answer", "sources": [{"source": "Gutless.pdf"}], "quotes": [{"match": 100}],
                     "memory": {"scope": ["Gutless.pdf"]}}}
    assert scenario.checks(t, good, state, True) == {"status": True, "sourced": True, "expected_source": True,
                                                    "must_contain": True, "scope": True}
    bad = {"reply": "1 g per pound.", "data": {"status": "answer", "sources": [{"source": "x.pdf"}], "quotes": [],
                                              "memory": {"scope": []}}}
    assert scenario.checks(t, bad, state, True) == {"status": True, "sourced": False, "expected_source": False,
                                                   "must_contain": False, "scope": False}
    idk = {"reply": "I don't know.", "data": {"status": "unknown", "clarification": ""}}
    assert scenario.checks(t, idk, state, False) == {"status": False, "clarifies": False}


class JudgeLLM:
    model = "judge"

    def __init__(self):
        self.calls = []

    def chat(self, system, user, json=False):
        self.calls.append((system, user))
        if system == scenario.TURN_SYSTEM:
            text = '{"resolved": true, "constraints_kept": true, "violated": [], "on_track": true, "reason": "fine"}'
        elif system == scenario.MEMORY_SYSTEM:
            n = user.count("\n- ", 0, user.index("Stored memory"))
            text = '{"items": [' + ",".join(['{"expected": "x", "present": true}'] * n) + '], "goal": true, "wrong": []}'
        else:
            text = '{"verdict": "supported", "unsupported_claims": [], "reason": "ok"}'
        return Reply(text, 1, 1, 0.0)


def test_run_grade_and_report_with_memory_on_and_off(tmp_path):
    scenarios = _load(tmp_path)
    llm = MemoryLLM(
        [("question", "Gutless rules?"), ("meta", ""), ("question", "Protein per day in Gutless?")] * 2,
        ['{"ops": [{"op": "set_goal", "text": "Lose 8 kg"}, {"op": "add", "field": "constraints", "text": "short answers"},'
         ' {"op": "set_scope", "sources": ["Gutless.pdf"]}]}',
         '{"ops": [{"op": "add", "field": "constraints", "text": "use kg"}]}', '{"ops": []}'])
    on, _ = _service(llm)
    off = ChatService(ChatStore(":memory:"), llm, on.agent, on.condenser, None, on.config)
    data = scenario.run(scenarios, {"memory on": on, "memory off": off}, log=lambda *_: None)
    assert [r["label"] for r in data["runs"]] == ["memory on", "memory off"]
    assert [t["data"]["status"] for t in data["runs"][0]["turns"]] == ["answer", "meta", "answer"]

    judge = JudgeLLM()
    data = scenario.grade(data, scenarios, judge, workers=2, log=lambda *_: None)
    on_run, off_run = data["runs"]
    assert on_run["turns"][0]["memory_check"]["expected"] == 1 and on_run["turns"][1]["memory_check"]["present"] == 1
    assert on_run["final_memory"]["expected"] == 2 and "final_memory" not in off_run
    assert "memory_check" not in off_run["turns"][0] and on_run["turns"][2]["faithful"]["verdict"] == "supported"
    assert on_run["turns"][2]["checks"]["scope"] is True

    m = scenario_report.metrics([on_run], {s.id: s for s in scenarios})
    assert m["reply of the expected kind"] == "3/3" and m["memory: items still there at the end"] == "2/2"
    assert m["answers with sources and quotes"] == "2/2" and m["units / must contain"] == "0/1"
    md = scenario_report.markdown(data, scenarios)
    assert "#### Transcript with the task memory" in md and "#### Without the task memory" in md
    assert "*searched as:* Protein per day in Gutless?" in md and "Memory: goal → Lose 8 kg" in md

    path = tmp_path / "EVAL.md"
    path.write_text("# Reading\n\nkept\n")
    scenario_report.write_markdown(path, "first")
    scenario_report.write_markdown(path, "second")
    text = path.read_text()
    assert text.count(scenario_report.START) == 1 and "second" in text and "first" not in text
    assert text.startswith("# Reading\n\nkept\n")
    assert scenario_report.terminal(data, scenarios).splitlines()[0].strip().startswith("t1 · memory on")
