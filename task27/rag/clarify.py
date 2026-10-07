"""Gate 1 of "I don't know": no chunk passed the relevance threshold, so there is nothing to answer
from. One small LLM call turns the question and what the search found closest (the documents and
sections, even under the threshold) into a clarifying question for the user.

Gate 2 (the passages are relevant but do not state the answer) needs no extra call: the
answering model returns status "unknown" with its own clarification.
"""

from __future__ import annotations

from .cited import tidy
from .llm import LocalLLM, LLMError, Reply
from .retrieve import Hit

CLOSEST = 5

SYSTEM = """\
A user asked a question about a small document collection, and the search found nothing
relevant enough to answer it. The assistant has already said "I don't know:"; write the
text that follows it (do not repeat "I don't know").

The collection contains these documents:
{titles}

You also get the sections the search found closest to the question (they do not answer it).

Write one or two short sentences: say briefly what the collection does cover near the
question, then ask one clarifying question (rephrase, narrow down, or pick between topics).
Do not answer the question, and do not use knowledge from outside the collection.
Reply with the text only, no quotes and no preamble."""


def closest_block(hits: list[Hit]) -> str:
    lines = []
    for h in hits[:CLOSEST]:
        snippet = " ".join(h.text.split())[:200]
        lines.append(f"- {h.title}, {h.section or 'no section'}: {snippet}…")
    return "\n".join(lines) or "- nothing"


class Clarifier:
    def __init__(self, llm: LocalLLM, titles: list[str]):
        self.llm = llm
        self.system = SYSTEM.format(titles="\n".join(f"- {t}" for t in titles) or "- (none)")

    def ask(self, question: str, closest: list[Hit]) -> Reply | None:
        """The clarifying text, or None when the call fails (the answer is then a bare "I don't know")."""
        try:
            reply = self.llm.chat(self.system, f"Question: {question}\n\nClosest sections:\n{closest_block(closest)}")
        except LLMError:
            return None
        text = tidy(reply.text)
        return Reply(text, reply.prompt_tokens, reply.completion_tokens, reply.seconds) if text else None

