"""Task memory: what this conversation has established, kept apart from the raw history.

  goal         what the user is trying to achieve in this conversation
  clarified    what the user has told us: their situation, what a vague reference meant,
               their answer to a clarifying question
  constraints  how to answer and what to stick to: length, units, format, what to focus on
  terms        words and abbreviations the conversation has given a meaning
  scope        the documents the user limited the conversation to (empty = all); retrieval
               enforces it, it is not just a line in a prompt

Only the last few messages go into the prompts verbatim, so anything older reaches the model
through this memory. After every turn a separate LLM call reads the memory and the turn and
returns edits, not a new memory:

  {"op": "set_goal", "text": "..."}
  {"op": "add", "field": "clarified" | "constraints" | "terms", "text": "..."}
  {"op": "remove", "id": "c2"}
  {"op": "set_scope", "sources": ["Gutless.pdf"]}

The code checks each edit (known field, known id, known document, not a duplicate) and drops
the ones that fail, so an item never disappears or changes without a logged edit that names it.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field

from .llm import DeepSeek, LLMError

FIELDS = ("clarified", "constraints", "terms")
PREFIX = {"clarified": "c", "constraints": "k", "terms": "t"}
OPS = ("set_goal", "add", "remove", "set_scope")
ANSWER_CHARS = 600  # the assistant's reply in the update prompt is cut to this


@dataclass
class Item:
    id: str  # c1, k2, t3: the field's letter and a number that is never reused
    text: str
    turn: int  # the turn it was added in


@dataclass
class TaskMemory:
    goal: str = ""
    goal_turn: int = 0
    clarified: list[Item] = field(default_factory=list)
    constraints: list[Item] = field(default_factory=list)
    terms: list[Item] = field(default_factory=list)
    scope: list[str] = field(default_factory=list)  # source files; empty = every document
    next_id: int = 1

    @property
    def empty(self) -> bool:
        return not (self.goal or self.scope or any(getattr(self, f) for f in FIELDS))

    def items(self) -> list[Item]:
        return [i for f in FIELDS for i in getattr(self, f)]

    def find(self, item_id: str) -> tuple[str, Item] | None:
        for f in FIELDS:
            for i in getattr(self, f):
                if i.id == item_id:
                    return f, i
        return None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict | None) -> TaskMemory:
        if not data:
            return cls()
        m = cls(goal=data.get("goal", ""), goal_turn=data.get("goal_turn", 0), scope=list(data.get("scope", [])),
                next_id=data.get("next_id", 1))
        for f in FIELDS:
            setattr(m, f, [Item(**i) for i in data.get(f, [])])
        return m

    def block(self, with_ids: bool = False) -> str:
        """The memory as text for a prompt; "" when nothing is established yet."""
        if self.empty:
            return ""

        def line(i: Item) -> str:
            return f"- [{i.id}] {i.text}" if with_ids else f"- {i.text}"

        parts = [f"Goal: {self.goal or '(not stated yet)'}"]
        for f, title in (("clarified", "Clarified by the user"), ("constraints", "Constraints"), ("terms", "Terms")):
            items = getattr(self, f)
            if items or with_ids:
                parts.append(f"{title}:\n" + ("\n".join(line(i) for i in items) or "- none"))
        if self.scope or with_ids:
            parts.append("Scope: " + (", ".join(self.scope) if self.scope else "all documents"))
        return "\n".join(parts)


@dataclass
class Change:
    """One applied edit, as logged and shown on the page."""
    op: str  # "set_goal" | "add" | "remove" | "set_scope"
    turn: int
    field: str = ""  # "goal", a FIELDS name, or "scope"
    id: str = ""
    text: str = ""  # the new goal / the added or removed item's text / the scope as text

    def to_dict(self) -> dict:
        return asdict(self)


def _norm(text: str) -> str:
    return " ".join(text.lower().split()).rstrip(".")


def apply(memory: TaskMemory, ops: list, turn: int, sources: list[str]) -> tuple[list[Change], list[str]]:
    """Apply the valid edits in order. Returns what changed and why each rejected edit was rejected."""
    changes, errors = [], []
    for op in ops:
        if not isinstance(op, dict) or op.get("op") not in OPS:
            errors.append(f"unknown op {op!r}")
            continue
        kind = op["op"]
        if kind == "set_goal":
            text = op.get("text")
            if not isinstance(text, str) or not text.strip():
                errors.append("set_goal needs a text")
            elif _norm(text) != _norm(memory.goal):
                memory.goal, memory.goal_turn = " ".join(text.split()), turn
                changes.append(Change("set_goal", turn, "goal", text=memory.goal))
        elif kind == "add":
            f, text = op.get("field"), op.get("text")
            if f not in FIELDS:
                errors.append(f"add: field {f!r} is not one of {FIELDS}")
            elif not isinstance(text, str) or not text.strip():
                errors.append("add needs a text")
            elif any(_norm(i.text) == _norm(text) for i in getattr(memory, f)):
                errors.append(f"add: {f} already has {text!r}")
            else:
                item = Item(f"{PREFIX[f]}{memory.next_id}", " ".join(text.split()), turn)
                memory.next_id += 1
                getattr(memory, f).append(item)
                changes.append(Change("add", turn, f, item.id, item.text))
        elif kind == "remove":
            found = memory.find(str(op.get("id", "")))
            if found is None:
                errors.append(f"remove: no item {op.get('id')!r}")
            else:
                f, item = found
                getattr(memory, f).remove(item)
                changes.append(Change("remove", turn, f, item.id, item.text))
        else:  # set_scope
            scope = op.get("sources")
            if not isinstance(scope, list) or not all(isinstance(s, str) for s in scope):
                errors.append("set_scope needs a list of sources")
                continue
            unknown = [s for s in scope if s not in sources]
            if unknown:
                errors.append(f"set_scope: unknown documents {unknown}; use the source names {sources}")
                continue
            scope = [s for s in sources if s in scope]  # the index's order, no duplicates
            if set(scope) == set(sources):
                scope = []  # every document is the same as no limit
            if scope != memory.scope:
                memory.scope = scope
                changes.append(Change("set_scope", turn, "scope", text=", ".join(scope) or "all documents"))
    return changes, errors


SYSTEM = """\
You keep the task memory of a chat between a user and an assistant that answers from a small
document collection. Only the last few messages stay visible to the assistant, so this memory
is how it remembers the conversation. After each turn you read the memory and the latest turn
and decide what to change. Most turns change nothing.

The collection contains these documents (source file: title):
{documents}

The memory has:
- goal: what the user is trying to achieve in this conversation, in one short sentence. If
  there is no goal yet, infer one from the user's first real message ("learn the main ideas of
  Gutless", "plan a TTS dataset"). Change it only when the user states a new or more precise goal.
- clarified: what the user has told about themselves or their situation ("is vegetarian",
  "weighs about 80 kg"), what they meant by a vague reference, and their answers to the
  assistant's clarifying questions ("'the evaluation' = the TatarTTS listening test").
- constraints: how the user wants answers and what to stick to: length, units, format,
  focus, things to avoid ("short answers", "use kilograms, not pounds").
- terms: words or abbreviations the user has given a meaning or uses with a fixed meaning
  ("'the paper' = the TatarTTS paper", "'deficit' = eating below maintenance calories").
- scope: the documents the user wants answers from; [] means all documents.

Edits you can make:
  {{"op": "set_goal", "text": "..."}}
  {{"op": "add", "field": "clarified" | "constraints" | "terms", "text": "..."}}
  {{"op": "remove", "id": "<item id>"}}          when the user takes something back or it no longer holds
  {{"op": "set_scope", "sources": ["<source file>", ...]}}   when the user limits or widens the documents; [] = all

Rules:
- Record only what the user said or clearly agreed to. Never record the documents' facts or the
  assistant's answers: those are found again by search when needed.
- One short item per fact, written so it is clear without the conversation.
- Do not add what is already in the memory. If the user changes something, remove the old item
  and add the new one.
- A question on its own is not a constraint and not a clarification.

Reply with one JSON object only: {{"ops": [ ... ]}} (an empty list when nothing changes)."""


def turn_block(message: str, standalone: str, reply: str, status: str) -> str:
    reply = " ".join(reply.split())
    reply = reply[:ANSWER_CHARS] + ("…" if len(reply) > ANSWER_CHARS else "")
    lines = [f"User: {message.strip()}"]
    if standalone and standalone != message.strip():
        lines.append(f"(read as: {standalone})")
    lines.append(f"Assistant ({status}): {reply}")
    return "\n".join(lines)


def parse(text: str) -> list:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise LLMError(f"memory: no JSON in {text[:200]!r}")
    try:
        ops = json.loads(m.group(0)).get("ops")
    except (ValueError, AttributeError) as e:
        raise LLMError(f"memory: bad JSON ({e}) in {text[:200]!r}") from e
    if not isinstance(ops, list):
        raise LLMError("memory: ops is not a list")
    return ops


@dataclass
class Update:
    changes: list[Change] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # rejected edits, or why the call failed
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0


class MemoryUpdater:
    def __init__(self, llm: DeepSeek, documents: list[tuple[str, str]]):
        self.llm = llm
        self.sources = [s for s, _ in documents]
        self.system = SYSTEM.format(documents="\n".join(f"- {s}: {t}" for s, t in documents) or "- (none)")

    def update(self, memory: TaskMemory, turn: int, message: str, standalone: str, reply: str,
               status: str) -> Update:
        """Edits `memory` in place. A failed call changes nothing; the turn goes on without it."""
        user = (f"Current memory:\n{memory.block(with_ids=True) or 'Goal: (not stated yet)'}\n\n"
                f"Latest turn (turn {turn}):\n{turn_block(message, standalone, reply, status)}\n\n"
                "Reply with the JSON object.")
        try:
            r = self.llm.chat(self.system, user, json=True)
        except LLMError as e:
            return Update(errors=[str(e)])
        try:
            ops = parse(r.text)
        except LLMError as e:
            return Update(errors=[str(e)], prompt_tokens=r.prompt_tokens, completion_tokens=r.completion_tokens,
                          seconds=r.seconds)
        changes, errors = apply(memory, ops, turn, self.sources)
        return Update(changes, errors, r.prompt_tokens, r.completion_tokens, r.seconds)
