"""Long scripted conversations: does the chat stay on track and keep citing sources?

scenarios.json holds the conversations. Every user message has its expectations:

  expect       "answer" | "unknown" | "meta": what kind of reply is right
  sources      answers: the documents a cited chunk should come from
  means        follow-ups: what the message means in context (the judge compares the standalone
               question with it)
  must_contain answers: groups of words, one of each group must appear (e.g. the unit asked for)
  sets         what this message establishes: goal, clarified, constraints, terms, scope. The
               scenario's ground truth is built from these, so the judges grade constraints and
               the recap against what the user said, not against what the memory happened to keep

Each scenario runs twice, through the same ChatService the web page uses: with the task memory
and without it (history window only). A run is plain data; grading adds the verdicts, so a
saved run can be graded again or reported without new answers.

Checks without an LLM: the reply kind, sources and quotes on every answer, the expected
document cited, must_contain, the memory's scope. With an LLM judge: the follow-up resolved,
the constraints kept, on track (and a recap that matches), faithfulness (task 24's judge), and
whether the memory holds what the user established, at the turn and at the end.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import judge
from .chat import ChatService
from .llm import DeepSeek, LLMError
from .memory import FIELDS, TaskMemory
from .retrieve import TASK_DIR

DEFAULT_SCENARIOS = TASK_DIR / "scenarios.json"
RUNS_DIR = TASK_DIR / "eval"
EXPECTS = ("answer", "unknown", "meta")


@dataclass
class ScenarioTurn:
    text: str
    expect: str
    sources: list[str] = field(default_factory=list)
    means: str = ""
    must_contain: list[list[str]] = field(default_factory=list)
    sets: dict = field(default_factory=dict)


@dataclass
class Scenario:
    id: str
    title: str
    turns: list[ScenarioTurn]


def load(path: Path = DEFAULT_SCENARIOS) -> list[Scenario]:
    out = []
    for s in json.loads(Path(path).read_text()):
        turns = [ScenarioTurn(**t) for t in s["turns"]]
        for i, t in enumerate(turns, 1):
            if t.expect not in EXPECTS:
                raise ValueError(f"{s['id']} turn {i}: expect {t.expect!r} is not one of {EXPECTS}")
            unknown = set(t.sets) - {"goal", "scope", *FIELDS}
            if unknown:
                raise ValueError(f"{s['id']} turn {i}: unknown keys in sets: {sorted(unknown)}")
        out.append(Scenario(s["id"], s["title"], turns))
    return out


def truth(scenario: Scenario) -> list[dict]:
    """What the user has established after each turn: goal, clarified, constraints, terms, scope."""
    state = {"goal": "", "clarified": [], "constraints": [], "terms": [], "scope": []}
    out = []
    for t in scenario.turns:
        for key, value in t.sets.items():
            if key in FIELDS:
                state[key] = state[key] + list(value)
            else:
                state[key] = value
        out.append(json.loads(json.dumps(state)))
    return out


def truth_block(state: dict) -> str:
    lines = [f"Goal: {state['goal'] or '(not stated)'}"]
    for key, title in (("clarified", "About the user"), ("constraints", "Constraints"), ("terms", "Terms")):
        if state[key]:
            lines.append(f"{title}: " + "; ".join(state[key]))
    lines.append("Scope: " + (", ".join(state["scope"]) or "all documents"))
    return "\n".join(lines)


# ------------------------------------------------------------------ running


def run(scenarios: list[Scenario], services: dict[str, ChatService], log=print) -> dict:
    """`services`: label ("memory on" / "memory off") → the service to run with."""
    started = time.monotonic()
    runs = []
    for s in scenarios:
        for label, svc in services.items():
            session = svc.store.create_session(s.title)
            turns = []
            log(f"{s.id} · {label}")
            for i, t in enumerate(s.turns, 1):
                try:
                    turn = svc.turn(session.id, t.text)
                except LLMError as e:
                    log(f"  {i:>2} error: {e}")
                    turns.append({"turn": i, "text": t.text, "reply": "", "data": {"status": "error", "error": str(e)}})
                    continue
                d = turn.data()
                turns.append({"turn": i, "text": t.text, "reply": turn.text, "data": d})
                log(f"  {i:>2} {d['status']:7} {turn.seconds:5.1f}s  {len(d.get('sources', []))} src  "
                    f"{(d.get('standalone') or '—')[:70]}")
            runs.append({"scenario": s.id, "label": label, "memory": svc.memory_on, "turns": turns})
    any_svc = next(iter(services.values()))
    return {
        "created": datetime.now().isoformat(timespec="seconds"),
        "model": any_svc.llm.model,
        "mode": any_svc.config.label,
        "threshold": any_svc.config.threshold,
        "floor": any_svc.config.floor,
        "window": any_svc.window,
        "labels": list(services),
        "wall_seconds": round(time.monotonic() - started, 1),
        "runs": runs,
    }


# ------------------------------------------------------------------ checks without an LLM


def checks(t: ScenarioTurn, r: dict, state: dict, memory_on: bool) -> dict:
    d = r["data"]
    status = d.get("status")
    text = r["reply"].lower()
    out = {"status": status == t.expect}
    if status == "answer":
        out["sourced"] = bool(d.get("sources")) and bool(d.get("quotes"))
        if t.sources:
            out["expected_source"] = any(x["source"] in t.sources for x in d.get("sources", []))
        if t.must_contain:
            out["must_contain"] = all(any(w.lower() in text for w in group) for group in t.must_contain)
    if status == "unknown":
        out["clarifies"] = bool(d.get("clarification"))
    if memory_on and "memory" in d:
        out["scope"] = sorted(d["memory"].get("scope", [])) == sorted(state["scope"])
    return out


# ------------------------------------------------------------------ judges

TURN_SYSTEM = """\
You grade one turn of a chat between a user and an assistant that answers from a small document
collection (it must answer only from the documents, or say it doesn't know).

You get what the user has established in the conversation so far (goal, facts about them,
constraints on how to answer, terms), the user's latest message, what that message means in
context (when given), the question the assistant actually searched with, and the assistant's
reply. Grade three things:

- resolved: does the searched question mean what the message means in context? Small wording
  differences are fine; a different topic, a lost reference ("it" resolved to the wrong thing),
  or a missing key detail is not. null when no meaning is given or nothing was searched.
- constraints_kept: does the reply follow the constraints the user set (length, units, format)?
  "Short" means a few sentences. Units: numbers the user asked about should be given in the
  requested unit (quoting the book's original unit as well is fine). A reply that says it
  doesn't know only needs to respect the format loosely. null when no constraint applies.
- on_track: does the reply serve the user's goal and answer their latest message, using what
  they established (e.g. their weight or diet when relevant)? For a recap request, on_track
  means the recap names the goal and the established facts and constraints without
  contradicting them or inventing facts about the user. It may also mention topics discussed
  in the conversation (you don't see the whole conversation, so don't count those as invented). For an "I don't know", on_track means it is a sensible refusal that stays on topic.

Reply with one JSON object only:
{"resolved": true|false|null, "constraints_kept": true|false|null, "violated": ["..."],
 "on_track": true|false, "reason": "one sentence"}"""


MEMORY_SYSTEM = """\
You check a chat assistant's task memory against what the user actually established. You get
the expected items (written by the test author) and the memory as the assistant stored it.
An expected item is present when the memory states the same fact, in any wording, in any
section. The goal matches when the memory's goal describes the same aim (more or less detail
is fine). List memory items that contradict what the user said, or that the user never said.

Reply with one JSON object only:
{"items": [{"expected": "...", "present": true|false}], "goal": true|false|null,
 "wrong": ["..."], "reason": "one sentence"}"""


def _ask_json(llm: DeepSeek, system: str, user: str) -> dict:
    last: Exception | None = None
    for _ in range(2):
        try:
            return judge._json_object(llm.chat(system, user, json=True).text)
        except LLMError as e:
            last = e
    raise last  # type: ignore[misc]


def judge_turn(llm: DeepSeek, t: ScenarioTurn, r: dict, state: dict) -> dict:
    d = r["data"]
    searched = d.get("standalone") or "(nothing: answered from the conversation, no search)"
    user = (f"Established so far:\n{truth_block(state)}\n\nLatest message: {t.text}\n"
            f"Meaning in context: {t.means or '(not given)'}\nSearched question: {searched}\n\n"
            f"Assistant reply ({d.get('status')}):\n{r['reply']}")
    v = _ask_json(llm, TURN_SYSTEM, user)
    return {"resolved": v.get("resolved") if t.means and d.get("standalone") else None,
            "constraints_kept": v.get("constraints_kept"), "violated": v.get("violated") or [],
            "on_track": bool(v.get("on_track")), "reason": str(v.get("reason", ""))}


def judge_memory(llm: DeepSeek, expected: list[str], goal: str, memory: dict) -> dict:
    stored = TaskMemory.from_dict(memory).block(with_ids=True) or "(empty)"
    items = "\n".join(f"- {x}" for x in expected) or "- (none)"
    user = f"Expected goal: {goal or '(none)'}\nExpected items:\n{items}\n\nStored memory:\n{stored}"
    v = _ask_json(llm, MEMORY_SYSTEM, user)
    got = v.get("items") or []
    present = [bool(i.get("present")) for i in got if isinstance(i, dict)]
    return {"present": sum(present), "expected": len(expected), "goal": v.get("goal") if goal else None,
            "wrong": v.get("wrong") or [], "missing": [i.get("expected") for i in got if isinstance(i, dict) and not i.get("present")],
            "reason": str(v.get("reason", ""))}


def grade(data: dict, scenarios: list[Scenario], llm: DeepSeek, workers: int = 6, log=print) -> dict:
    by_id = {s.id: s for s in scenarios}
    jobs = []
    for run_ in data["runs"]:
        s = by_id[run_["scenario"]]
        states = truth(s)
        for t, r, state in zip(s.turns, run_["turns"], states):
            jobs.append((run_, t, r, state))

    def one(job):
        run_, t, r, state = job
        r["checks"] = checks(t, r, state, run_["memory"])
        if r["data"].get("status") == "error":
            return
        r["judge"] = judge_turn(llm, t, r, state)
        d = r["data"]
        if d.get("status") == "answer" and d.get("quotes"):
            r["faithful"] = judge.faithfulness(llm, d.get("standalone") or t.text, r["reply"], d["quotes"]).to_dict()
        if run_["memory"] and "memory" in d and t.sets:
            new = [x for f in FIELDS for x in t.sets.get(f, [])]
            r["memory_check"] = judge_memory(llm, new, t.sets.get("goal", ""), d["memory"])
        j = r["judge"]
        log(f"  {run_['scenario']} {run_['label']:10} {r['turn']:>2}  "
            f"{'ok ' if r['checks']['status'] else 'BAD'} track={j['on_track']} constraints={j['constraints_kept']} "
            f"resolved={j['resolved']}" + (f" faithful={r['faithful']['verdict']}" if r.get('faithful') else ""))

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(one, jobs))

    for run_ in data["runs"]:  # the memory at the end against everything the user established
        s = by_id[run_["scenario"]]
        last = next((r for r in reversed(run_["turns"]) if "memory" in r["data"]), None)
        if run_["memory"] and last is not None:
            state = truth(s)[-1]
            items = [x for f in FIELDS for x in state[f]]
            run_["final_memory"] = judge_memory(llm, items, state["goal"], last["data"]["memory"])
    data["judge_model"] = llm.model
    return data


def save(data: dict, path: Path | None = None) -> Path:
    if path is None:
        RUNS_DIR.mkdir(exist_ok=True)
        path = RUNS_DIR / f"scenario-{data['created'].replace(':', '').replace('-', '')}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    return path


def load_run(path: Path) -> dict:
    return json.loads(Path(path).read_text())
