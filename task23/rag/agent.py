"""question → (retrieve → combine) → LLM.

  plain               the question goes to the LLM as is (config None)
  base, rerank, …     the pipeline picks the chunks, which go in front of the question;
                      when a filter keeps none, the answer is a refusal and the LLM is not called
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import prompt
from .llm import DeepSeek
from .pipeline import Config, Pipeline, Retrieval
from .retrieve import Hit

_CITE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")


@dataclass
class Answer:
    question: str
    retrieval: Retrieval | None  # None in plain mode
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0

    @property
    def label(self) -> str:
        return "plain" if self.retrieval is None else self.retrieval.config.mode

    @property
    def early_refusal(self) -> bool:
        """Refused by the filter, before any LLM call."""
        return self.retrieval is not None and not self.retrieval.kept

    @property
    def hits(self) -> list[Hit]:
        return [] if self.retrieval is None else self.retrieval.kept

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
    def __init__(self, llm: DeepSeek, pipeline: Pipeline | None = None):
        self.llm = llm
        self.pipeline = pipeline

    def answer(self, question: str, config: Config | None = None, retrieval: Retrieval | None = None) -> Answer:
        """No config and no retrieval: plain mode. `retrieval` skips the pipeline: the evaluation
        retrieves up front, then calls the LLM in parallel."""
        if config is None and retrieval is None:
            reply = self.llm.chat(prompt.PLAIN_SYSTEM, prompt.plain_user(question))
            return Answer(question, None, reply.text, reply.prompt_tokens, reply.completion_tokens, reply.seconds)
        if retrieval is None:
            if self.pipeline is None:
                raise ValueError("retrieval modes need a pipeline")
            retrieval = self.pipeline.retrieve(question, config)
        if not retrieval.kept:  # the filter found nothing relevant enough: refuse without the LLM
            return Answer(question, retrieval, prompt.NOT_FOUND)
        reply = self.llm.chat(prompt.RAG_SYSTEM, prompt.rag_user(question, retrieval.kept))
        return Answer(question, retrieval, reply.text, reply.prompt_tokens, reply.completion_tokens, reply.seconds)
