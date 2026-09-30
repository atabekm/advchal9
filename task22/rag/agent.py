"""question → (retrieve → combine) → LLM, in one of two modes.

  plain  the question goes to the LLM as is
  rag    the top-k chunks are retrieved and put in front of the question
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import prompt
from .llm import DeepSeek
from .retrieve import DEFAULT_K, DEFAULT_STRATEGY, Hit, Retriever

MODES = ("rag", "plain")
_CITE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")


@dataclass
class Answer:
    question: str
    mode: str  # "plain" | "rag"
    strategy: str | None  # retrieval strategy, None in plain mode
    text: str
    hits: list[Hit] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0

    @property
    def label(self) -> str:
        return self.mode if self.mode == "plain" else f"rag/{self.strategy}"

    @property
    def cited(self) -> list[Hit]:
        """The retrieved chunks the answer cites, in citation order."""
        by_rank = {h.rank: h for h in self.hits}
        seen: dict[int, Hit] = {}
        for group in _CITE.findall(self.text):
            for n in group.split(","):
                n = int(n)
                if n in by_rank and n not in seen:
                    seen[n] = by_rank[n]
        return list(seen.values())


class Agent:
    def __init__(self, llm: DeepSeek, retriever: Retriever | None = None):
        self.llm = llm
        self.retriever = retriever

    def answer(self, question: str, mode: str = "rag", strategy: str = DEFAULT_STRATEGY, k: int = DEFAULT_K) -> Answer:
        if mode == "plain":
            reply = self.llm.chat(prompt.PLAIN_SYSTEM, prompt.plain_user(question))
            return Answer(question, "plain", None, reply.text, [], reply.prompt_tokens, reply.completion_tokens, reply.seconds)
        if mode != "rag":
            raise ValueError(f"unknown mode {mode!r}, expected one of {MODES}")
        if self.retriever is None:
            raise ValueError("rag mode needs a retriever")
        hits = self.retriever.search(question, strategy, k)
        reply = self.llm.chat(prompt.RAG_SYSTEM, prompt.rag_user(question, hits))
        return Answer(question, "rag", strategy, reply.text, hits, reply.prompt_tokens, reply.completion_tokens, reply.seconds)
