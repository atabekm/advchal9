"""LLM-as-judge, two of them.

judge          grades one answer against the question's written expectation. It sees the question,
               the expectation and the answer, never the mode, the context or the other answers.
faithfulness   checks that the answer says what its quotes say. It sees the question, the answer
               and the quotes only (not the expectation, not the documents), so a claim counts as
               supported only when a quote states it.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

from .evalset import Question
from .llm import LocalLLM, LLMError

VERDICTS = ("correct", "partial", "wrong", "refused")

SYSTEM = """\
You grade answers to questions about a small document collection. You get the question,
the reference expectation (what a correct answer must contain, written from the documents),
and the answer to grade. Judge only against the expectation; do not use your own knowledge
to decide what is true.

Verdicts:
- correct: contains the key facts of the expectation and nothing that contradicts it
- partial: some key facts present, others missing, or minor inaccuracies
- wrong: key facts missing or contradicted, or it answers a different question
- refused: it declines, or says it does not know / the documents do not say

hallucination = true when the answer states specific facts (numbers, names, claims) that
contradict the expectation or are presented as fact about the documents without support
in the expectation. Hedged general knowledge that does not contradict it is not a hallucination.

When the expectation says the documents do NOT contain the answer, or that the question is
ambiguous, a refusal ("I don't know", with or without a clarifying question) is the right
behaviour: grade it "correct". A specific invented answer (e.g. a number) is then "wrong" with
hallucination = true.

Reply with one JSON object only:
{"verdict": "correct|partial|wrong|refused", "hallucination": true|false, "reason": "one sentence"}"""


@dataclass
class Verdict:
    verdict: str
    hallucination: bool
    reason: str

    @property
    def score(self) -> float:
        return {"correct": 1.0, "partial": 0.5}.get(self.verdict, 0.0)

    def to_dict(self) -> dict:
        return asdict(self)


def user_prompt(q: Question, answer: str) -> str:
    scope = "" if q.answerable else ("\n(The question is ambiguous.)" if q.kind == "ambiguous"
                                     else "\n(The documents do not contain the answer to this question.)")
    return f"Question: {q.question}\n\nExpectation: {q.expect}{scope}\n\nAnswer to grade:\n{answer}"


def parse(text: str) -> Verdict:
    data = _json_object(text)
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        raise LLMError(f"judge returned unknown verdict {verdict!r}")
    return Verdict(verdict, bool(data.get("hallucination", False)), str(data.get("reason", "")).strip())


FAITH_VERDICTS = ("supported", "partial", "unsupported")

FAITH_SYSTEM = """\
You check whether an answer is backed by its quotes. You get a question, an answer with
[n] markers, and the quotes it cites, each tagged with the passage number n it came from.

Go through the claims in the answer (facts, numbers, names, conclusions). A claim is
supported when a quote states it or it follows directly from the quotes; rewording is
fine. Use only the quotes: not your own knowledge, not what the documents probably say.
Framing sentences that make no factual claim need no support.

Verdicts:
- supported: every factual claim is backed by the quotes
- partial: the main claims are backed, but some detail is not (list it)
- unsupported: a main claim is not backed, or the answer contradicts a quote

Reply with one JSON object only:
{"verdict": "supported|partial|unsupported", "unsupported_claims": ["..."], "reason": "one sentence"}"""


@dataclass
class Faithfulness:
    verdict: str
    unsupported_claims: list[str]
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def faith_prompt(question: str, answer: str, quotes: list[dict]) -> str:
    lines = "\n".join(f'[{x["ref"]}] "{x["quote"]}"' for x in quotes)
    return f"Question: {question}\n\nAnswer:\n{answer}\n\nQuotes:\n{lines}"


def parse_faith(text: str) -> Faithfulness:
    data = _json_object(text)
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict not in FAITH_VERDICTS:
        raise LLMError(f"faithfulness judge returned unknown verdict {verdict!r}")
    claims = data.get("unsupported_claims") or []
    return Faithfulness(verdict, [str(c) for c in claims] if isinstance(claims, list) else [str(claims)],
                        str(data.get("reason", "")).strip())


def faithfulness(llm: LocalLLM, question: str, answer: str, quotes: list[dict]) -> Faithfulness:
    last: Exception | None = None
    for _ in range(2):
        try:
            return parse_faith(llm.chat(FAITH_SYSTEM, faith_prompt(question, answer, quotes)).text)
        except LLMError as e:
            last = e
    raise last  # type: ignore[misc]


def _json_object(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise LLMError(f"judge reply has no JSON: {text[:200]!r}")
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise LLMError(f"judge reply is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise LLMError("judge reply is not a JSON object")
    return data


def judge(llm: LocalLLM, q: Question, answer: str) -> Verdict:
    last: Exception | None = None
    for _ in range(2):  # one retry on an unparsable reply
        try:
            return parse(llm.chat(SYSTEM, user_prompt(q, answer)).text)
        except LLMError as e:
            last = e
    raise last  # type: ignore[misc]
