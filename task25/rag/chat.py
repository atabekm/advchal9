"""One chat turn: message → condense → (retrieve → cited answer | meta reply) → save.

  condense   the last HISTORY_WINDOW messages + the new message → "question" with a standalone
             question, or "meta"
  question   task 24's agent on the standalone question: rewrite → search → RRF → rerank →
             gates → JSON answer with sources and verified quotes; the recent conversation goes
             in front of the passages so the answer follows it
  meta       no retrieval: a short reply from the conversation itself, no sources
  save       the user message and the reply (with everything that produced it) go to the store
             together, so a failed turn leaves no half-turn behind

The CLI and the web server both drive this class.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import prompt
from .agent import Agent, Answer
from .clarify import Clarifier
from .condense import Condensed, Condenser, history_block
from .llm import DeepSeek, Reply
from .pipeline import Config, Pipeline
from .rerank import Reranker
from .retrieve import Retriever
from .rewrite import Rewriter
from .store import ChatStore, Message

HISTORY_WINDOW = 6  # messages (3 exchanges) that go into the prompts verbatim


@dataclass
class Turn:
    session_id: str
    turn: int
    message: str
    condensed: Condensed
    text: str  # what the user reads
    answer: Answer | None = None  # None for a meta turn
    meta_reply: Reply | None = None
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
        out["tokens"] = {"prompt": sum(t[0] for t in tokens), "completion": sum(t[1] for t in tokens)}
        return out


def conversation_block(history: list[Message]) -> str:
    return f"Recent conversation:\n{history_block(history)}"


class ChatService:
    def __init__(self, store: ChatStore, llm: DeepSeek, agent: Agent, condenser: Condenser,
                 config: Config | None = None, window: int = HISTORY_WINDOW):
        self.store = store
        self.llm = llm
        self.agent = agent
        self.condenser = condenser
        self.config = config or Config()
        self.window = window

    def turn(self, session_id: str, message: str) -> Turn:
        message = message.strip()
        if not message:
            raise ValueError("empty message")
        started = time.monotonic()
        session = self.store.session(session_id)
        history = self.store.messages(session_id, last=self.window) if self.window else []
        number = session.turns + 1

        condensed = self.condenser.condense(message, history)
        timings = {"condense": condensed.seconds}
        conversation = conversation_block(history)
        if condensed.meta:
            reply = self.llm.chat(prompt.META_SYSTEM, prompt.meta_user(message, conversation))
            timings["meta"] = reply.seconds
            turn = Turn(session_id, number, message, condensed, reply.text.strip(), meta_reply=reply)
        else:
            answer = self.agent.answer(condensed.standalone, self.config, conversation=conversation if history else "")
            if answer.retrieval is not None:
                timings.update(answer.retrieval.timings)
            timings["answer"] = answer.seconds
            turn = Turn(session_id, number, message, condensed, answer.text, answer=answer)
        turn.timings = timings
        turn.seconds = time.monotonic() - started

        if number == 1:
            self.store.rename(session_id, message)
        self.store.add_message(session_id, number, "user", message)
        self.store.add_message(session_id, number, "assistant", turn.text, turn.data())
        return turn


def build(chat_db=None, index_db=None, model: str | None = None, config: Config | None = None,
          reranker_model: str | None = None, window: int = HISTORY_WINDOW) -> ChatService:
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
    return ChatService(ChatStore(chat_db or DEFAULT_CHAT_DB), llm, agent, Condenser(llm, titles), config, window)
