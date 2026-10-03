"""question → (retrieve → combine) → LLM.

  plain               the question goes to the LLM as is (config None)
  base, rerank, …     the pipeline picks the chunks, which go in front of the question;
                      when a filter keeps none (gate 1), the answer is "I don't know" plus a clarifying
                      question from clarify.py; the answering LLM is not called

Two answer styles over the retrieved chunks:

  cited (default)     JSON: the answer, citations [{ref, quote}] and, when the passages do not
                      answer the question, status "unknown" with a clarifying question. Every quote is
                      matched against the chunk it cites (verify.py). A reply that breaks the format,
                      or has a quote that is not in its chunk, is retried once with the error. After
                      that, failed quotes are dropped; no quote left, or no usable reply → "I don't know".
  legacy              task 23's free text with optional [n] markers, kept for comparison
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import cited as fmt
from . import prompt
from .clarify import Clarifier
from .cited import Cited, FormatError, Quote
from .llm import DeepSeek, Reply
from .pipeline import Config, Pipeline, Retrieval
from .retrieve import Hit
from .verify import verify

ATTEMPTS = 2  # the first reply and one retry
STYLES = ("cited", "legacy")


@dataclass
class Answer:
    question: str
    retrieval: Retrieval | None  # None in plain mode
    text: str  # what the user reads: the answer, or "I don't know" and the clarifying question
    status: str = "answer"  # "answer" | "unknown"
    cited: list[Hit] = field(default_factory=list)  # the sources, in order of first citation
    quotes: list[Quote] = field(default_factory=list)  # verified, each with its match score
    failed_quotes: list[Quote] = field(default_factory=list)  # not found in their chunk, dropped
    clarification: str = ""
    style: str = "cited"  # "cited" | "legacy" | "plain"
    attempts: int = 0  # LLM calls for the answer
    format_error: str = ""  # the last format error, if the reply was retried or given up on
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0

    @property
    def label(self) -> str:
        if self.retrieval is None:
            return "plain"
        return self.retrieval.config.label if self.style == "cited" else f"legacy:{self.retrieval.config.label}"

    @property
    def early_refusal(self) -> bool:
        """Refused by the filter, before any LLM call."""
        return self.retrieval is not None and not self.retrieval.kept

    @property
    def unknown(self) -> bool:
        return self.status == "unknown"

    @property
    def hits(self) -> list[Hit]:
        return [] if self.retrieval is None else self.retrieval.kept


class Agent:
    def __init__(self, llm: DeepSeek, pipeline: Pipeline | None = None, style: str = "cited",
                 clarifier: Clarifier | None = None):
        if style not in STYLES:
            raise ValueError(f"unknown answer style {style!r}")
        self.llm = llm
        self.pipeline = pipeline
        self.style = style
        self.clarifier = clarifier

    def answer(self, question: str, config: Config | None = None, retrieval: Retrieval | None = None,
               conversation: str = "", constraints: list[str] = ()) -> Answer:
        """No config and no retrieval: plain mode. `retrieval` skips the pipeline: the evaluation
        retrieves up front, then calls the LLM in parallel. `conversation` (cited style): the chat
        so far, put in front of the passages so the answer can follow it; `constraints` are repeated
        next to the question."""
        if config is None and retrieval is None:
            reply = self.llm.chat(prompt.PLAIN_SYSTEM, prompt.plain_user(question))
            return Answer(question, None, reply.text, style="plain", attempts=1, prompt_tokens=reply.prompt_tokens,
                          completion_tokens=reply.completion_tokens, seconds=reply.seconds)
        if retrieval is None:
            if self.pipeline is None:
                raise ValueError("retrieval modes need a pipeline")
            retrieval = self.pipeline.retrieve(question, config)
        if not retrieval.kept:  # gate 1: nothing relevant enough, refuse without the answering LLM
            return self._below_threshold(question, retrieval)
        if self.style == "legacy":
            return self._legacy(question, retrieval)
        return self._cited(question, retrieval, conversation, constraints)

    def _below_threshold(self, question: str, retrieval: Retrieval) -> Answer:
        reply = self.clarifier.ask(question, retrieval.ranked) if self.clarifier and self.style == "cited" else None
        if reply is None:
            return Answer(question, retrieval, prompt.IDK, status="unknown", style=self.style)
        return Answer(question, retrieval, f"{prompt.IDK} {reply.text.strip()}", status="unknown",
                      clarification=reply.text.strip(), style=self.style, prompt_tokens=reply.prompt_tokens,
                      completion_tokens=reply.completion_tokens, seconds=reply.seconds)

    def _legacy(self, question: str, retrieval: Retrieval) -> Answer:
        reply = self.llm.chat(prompt.RAG_SYSTEM, prompt.rag_user(question, retrieval.kept))
        by_rank = {h.rank: h for h in retrieval.kept}
        cited = [by_rank[n] for n in fmt.markers(reply.text) if n in by_rank]
        status = "unknown" if prompt.NOT_FOUND.rstrip(".") in reply.text else "answer"
        return Answer(question, retrieval, reply.text, status=status, cited=cited, style="legacy", attempts=1,
                      prompt_tokens=reply.prompt_tokens, completion_tokens=reply.completion_tokens, seconds=reply.seconds)

    def _cited(self, question: str, retrieval: Retrieval, conversation: str = "", constraints: list[str] = ()) -> Answer:
        hits = retrieval.kept
        user = prompt.cited_user(question, hits, conversation, constraints)
        system = prompt.CITED_CHAT_SYSTEM if conversation else prompt.CITED_SYSTEM
        replies: list[Reply] = []
        error = ""
        result: Cited | None = None  # the last reply that parsed
        verified: list[Quote] = []
        failed: list[Quote] = []
        for attempt in range(ATTEMPTS):
            reply = self.llm.chat(system, prompt.retry_user(user, error) if error else user, json=True)
            replies.append(reply)
            try:
                parsed = fmt.parse(reply.text, hits)
            except FormatError as e:
                error = str(e)
                continue
            result = parsed
            if result.status == "unknown":
                break
            verified, failed = verify(result.quotes, hits)
            if not failed:
                break
            error = quote_error(failed)
        usage = dict(attempts=len(replies), format_error=error,
                     prompt_tokens=sum(r.prompt_tokens for r in replies),
                     completion_tokens=sum(r.completion_tokens for r in replies),
                     seconds=sum(r.seconds for r in replies))
        if result is None:  # no usable reply: never an answer without sources
            return Answer(question, retrieval, prompt.IDK, status="unknown", **usage)
        if result.status == "unknown":
            return Answer(question, retrieval, f"{prompt.IDK} {result.clarification}", status="unknown",
                          clarification=result.clarification, **usage)
        if not verified:  # nothing in the answer is backed by the chunks
            return Answer(question, retrieval, prompt.IDK, status="unknown", failed_quotes=failed, **usage)
        result.quotes = verified
        return Answer(question, retrieval, result.answer, cited=fmt.sources(result, hits), quotes=verified,
                      failed_quotes=failed, **usage)


def quote_error(failed: list[Quote]) -> str:
    """What to tell the model about quotes that are not in their passage."""
    shown = "; ".join(f'[{q.ref}] "{q.text[:80]}{"…" if len(q.text) > 80 else ""}" (best match {q.score:.0f}%)'
                      for q in failed[:3])
    return (f"these quotes are not copied word for word from the passage they cite: {shown}. "
            "Copy each quote exactly from its passage, and drop any claim you cannot quote")
