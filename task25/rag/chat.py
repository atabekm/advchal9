"""One chat turn: message → condense → (retrieve → cited answer | meta reply) → memory → save.

  memory     the session's task memory (goal, clarified, constraints, terms, scope) is read first;
             it goes into every prompt of the turn, and its scope limits the search
  condense   the memory + the last HISTORY_WINDOW messages + the new message → "question" with a
             standalone question, or "meta"
  question   task 24's agent on the standalone question: rewrite → search (scope) → RRF → rerank →
             gates → JSON answer with sources and verified quotes; the memory and the recent
             conversation go in front of the passages so the answer follows them
  meta       no retrieval: a short reply from the memory and the conversation, no sources
  update     a separate LLM call reads the memory and this turn and returns edits; the valid ones
             are applied and logged
  save       the message, the reply (with everything that produced it) and the memory go to the
             store in one transaction, so a failed turn leaves nothing half-done

`memory=False` runs the same chat with the history window only: no memory in the prompts, no
scope, no updates. The scenario evaluation uses it for contrast. The CLI and the web server
both drive this class.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace

from . import prompt
from .agent import Agent, Answer
from .clarify import Clarifier
from .condense import Condensed, Condenser, history_block
from .llm import DeepSeek, Reply
from .memory import MemoryUpdater, TaskMemory, Update
from .pipeline import Config, Pipeline
from .rerank import Reranker
from .retrieve import Retriever
from .rewrite import Rewriter
from .store import ChatStore, Message

HISTORY_WINDOW = 6  # messages (3 exchanges) that go into the prompts verbatim
FLOOR = 0.1  # rerank: once the best chunk passes the threshold, keep the others down to this


@dataclass
class Turn:
    session_id: str
    turn: int
    message: str
    condensed: Condensed
    text: str  # what the user reads
    answer: Answer | None = None  # None for a meta turn
    meta_reply: Reply | None = None
    memory: TaskMemory | None = None  # after this turn; None with the memory off
    update: Update | None = None
    seconds: float = 0.0  # wall time of the whole turn
    timings: dict[str, float] = field(default_factory=dict)

    @property
    def kind(self) -> str:
        return self.condensed.kind

    @property
    def status(self) -> str:
        """"answer" | "unknown" | "meta"."""
        return "meta" if self.answer is None else self.answer.status

    def data(self) -> dict:
        """Everything about the reply, stored with it and sent to the page."""
        c = self.condensed
        out = {
            "kind": c.kind, "standalone": c.standalone, "status": self.status,
            "condense_error": c.error or None, "seconds": round(self.seconds, 2),
            "timings": {k: round(v, 2) for k, v in self.timings.items()},
        }
        tokens = [(c.prompt_tokens, c.completion_tokens)]
        a = self.answer
        if a is not None:
            r = a.retrieval
            out.update({
                "sources": [{"ref": h.rank, "source": h.source, "title": h.title, "section": h.section,
                             "pages": h.pages, "chunk_id": h.chunk_id} for h in a.cited],
                "quotes": [{"ref": q.ref, "quote": q.text, "match": q.score} for q in a.quotes],
                "dropped_quotes": [{"ref": q.ref, "quote": q.text, "match": q.score} for q in a.failed_quotes],
                "clarification": a.clarification, "attempts": a.attempts, "format_error": a.format_error or None,
                "retrieval": None if r is None else {
                    "mode": r.config.label, "threshold": r.config.threshold, "queries": r.queries,
                    "scope": list(r.config.sources),
                    "kept": [{"ref": h.rank, "source": h.source, "section": h.section, "pages": h.pages,
                              "chunk_id": h.chunk_id, "rerank": h.rerank} for h in r.kept],
                    "best": r.ranked[0].rerank if r.ranked else None,
                },
            })
            tokens.append((a.prompt_tokens, a.completion_tokens))
            if r is not None and r.rewrite is not None:
                tokens.append((r.rewrite.prompt_tokens, r.rewrite.completion_tokens))
        if self.meta_reply is not None:
            tokens.append((self.meta_reply.prompt_tokens, self.meta_reply.completion_tokens))
        if self.memory is not None:
            out["memory"] = self.memory.to_dict()
        if self.update is not None:
            out["memory_changes"] = [ch.to_dict() for ch in self.update.changes]
            out["memory_errors"] = self.update.errors
            tokens.append((self.update.prompt_tokens, self.update.completion_tokens))
        out["tokens"] = {"prompt": sum(t[0] for t in tokens), "completion": sum(t[1] for t in tokens)}
        return out


def conversation_block(history: list[Message], memory: TaskMemory | None = None) -> str:
    """The memory (when there is one) and the recent messages, for the answer and meta prompts."""
    parts = []
    if memory is not None and not memory.empty:
        parts.append(f"Task memory (established earlier in this conversation):\n{memory.block()}")
    parts.append(f"Recent conversation:\n{history_block(history)}")
    return "\n\n".join(parts)


class ChatService:
    def __init__(self, store: ChatStore, llm: DeepSeek, agent: Agent, condenser: Condenser,
                 updater: MemoryUpdater | None = None, config: Config | None = None,
                 window: int = HISTORY_WINDOW):
        """No `updater`: the memory is off."""
        self.store = store
        self.llm = llm
        self.agent = agent
        self.condenser = condenser
        self.updater = updater
        self.config = config or Config(floor=FLOOR)
        self.window = window

    @property
    def memory_on(self) -> bool:
        return self.updater is not None

    def memory(self, session_id: str) -> TaskMemory:
        return TaskMemory.from_dict(self.store.memory(session_id))

    def turn(self, session_id: str, message: str) -> Turn:
        message = message.strip()
        if not message:
            raise ValueError("empty message")
        started = time.monotonic()
        session = self.store.session(session_id)
        history = self.store.messages(session_id, last=self.window) if self.window else []
        memory = self.memory(session_id) if self.memory_on else None
        number = session.turns + 1

        condensed = self.condenser.condense(message, history, memory.block() if memory else "")
        timings = {"condense": condensed.seconds}
        conversation = conversation_block(history, memory)
        constraints = [i.text for i in memory.constraints] if memory else []
        if condensed.meta:
            reply = self.llm.chat(prompt.META_SYSTEM, prompt.meta_user(message, conversation, constraints))
            timings["meta"] = reply.seconds
            turn = Turn(session_id, number, message, condensed, reply.text.strip(), meta_reply=reply)
        else:
            config = replace(self.config, sources=tuple(memory.scope)) if memory and memory.scope else self.config
            # the raw message too: the standalone question leaves out the user's details ("I weigh 82 kg")
            has_context = bool(history) or (memory is not None and not memory.empty) or message != condensed.standalone
            context = f"{conversation}\n\nThe user's message as written: {message}" if has_context else ""
            answer = self.agent.answer(condensed.standalone, config, conversation=context, constraints=constraints)
            if answer.retrieval is not None:
                timings.update(answer.retrieval.timings)
            timings["answer"] = answer.seconds
            turn = Turn(session_id, number, message, condensed, answer.text, answer=answer)

        if memory is not None:
            turn.update = self.updater.update(memory, number, message, condensed.standalone, turn.text, turn.status)
            turn.memory = memory
            timings["memory"] = turn.update.seconds
        turn.timings = timings
        turn.seconds = time.monotonic() - started

        if number == 1:
            self.store.rename(session_id, message)
        self.store.save_turn(session_id, number, message, turn.text, turn.data(),
                             memory.to_dict() if memory is not None else None,
                             [c.to_dict() for c in turn.update.changes] if turn.update else [])
        return turn


def build(chat_db=None, index_db=None, model: str | None = None, config: Config | None = None,
          reranker_model: str | None = None, window: int = HISTORY_WINDOW, memory: bool = True) -> ChatService:
    """The service with the real index, reranker and DeepSeek."""
    from .llm import DEFAULT_MODEL
    from .rerank import DEFAULT_MODEL as DEFAULT_RERANKER
    from .retrieve import DEFAULT_DB
    from .store import DEFAULT_CHAT_DB

    llm = DeepSeek(model or DEFAULT_MODEL)
    retriever = Retriever(index_db or DEFAULT_DB)
    titles = retriever.titles()
    pipeline = Pipeline(retriever, Reranker(reranker_model or DEFAULT_RERANKER), Rewriter(llm, titles))
    agent = Agent(llm, pipeline, "cited", Clarifier(llm, titles))
    updater = MemoryUpdater(llm, retriever.documents()) if memory else None
    return ChatService(ChatStore(chat_db or DEFAULT_CHAT_DB), llm, agent, Condenser(llm, titles), updater, config, window)
