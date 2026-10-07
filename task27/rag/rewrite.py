"""Query rewriting: the question → 1–3 search queries, written the way the documents would put it.

The rewriter sees the titles of the indexed documents, so a vague "that voice dataset for a
Turkic language" can become "TatarTTS dataset construction: text sources, speakers,
recording". A question about two things becomes one query per thing. The original question
is always searched too, so a rewrite can add candidates but never lose the ones the
question alone would find.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass

from .llm import LocalLLM, LLMError

MAX_QUERIES = 3

SYSTEM = """\
You rewrite a user's question into search queries for semantic search over a small
document collection. The search embeds each query and finds the most similar passages.

The collection contains these documents:
{titles}

Rules:
- Write 1 to {max} queries. Use 1 when the question is already specific.
- Use the words the documents would use: technical terms, names, the document's own
  vocabulary. Name the document when the question refers to it vaguely.
- When the question asks about several things or several documents, write one query for each.
- Keep the names and numbers from the question. Do not answer the question, do not add facts.
- Each query is a short standalone phrase or sentence.

Reply with one JSON object only: {{"queries": ["...", "..."]}}"""


@dataclass(frozen=True)
class Rewrite:
    queries: tuple[str, ...]  # the rewritten queries, not including the question
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    error: str = ""  # set when the LLM reply could not be used and the question is searched alone


def parse(text: str) -> tuple[str, ...]:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise LLMError(f"rewrite: no JSON in {text[:200]!r}")
    try:
        queries = json.loads(m.group(0))["queries"]
    except (ValueError, KeyError, TypeError) as e:
        raise LLMError(f"rewrite: bad JSON ({e}) in {text[:200]!r}") from e
    if not isinstance(queries, list):
        raise LLMError(f"rewrite: queries is not a list in {text[:200]!r}")
    out = tuple(dict.fromkeys(q.strip() for q in queries if isinstance(q, str) and q.strip()))
    if not out:
        raise LLMError("rewrite: no queries")
    return out[:MAX_QUERIES]


class Rewriter:
    """Caches by question, so every mode that rewrites searches with the same queries."""

    def __init__(self, llm: LocalLLM, titles: list[str]):
        self.llm = llm
        self.system = SYSTEM.format(titles="\n".join(f"- {t}" for t in titles), max=MAX_QUERIES)
        self._cache: dict[str, Rewrite] = {}
        self._lock = threading.Lock()

    def rewrite(self, question: str) -> Rewrite:
        with self._lock:
            if question in self._cache:
                return self._cache[question]
        try:
            reply = self.llm.chat(self.system, question)
        except LLMError as e:
            result = Rewrite((), error=str(e))
        else:
            try:
                queries = parse(reply.text)
            except LLMError as e:
                queries, error = (), str(e)
            else:
                error = ""
            result = Rewrite(queries, reply.prompt_tokens, reply.completion_tokens, reply.seconds, error)
        with self._lock:
            self._cache[question] = result
        return result
