"""LLM-as-judge: grade one answer against the question's written expectation.

The judge sees the question, the expectation and the answer. It never sees the mode,
the retrieved context or the other answers, so it grades what was said, not how.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass

from .evalset import Question
from .llm import DeepSeek, LLMError

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

When the expectation says the documents do NOT contain the answer, a refusal is the right
behaviour: grade it "correct". A specific answer (e.g. a number) is then "wrong" with
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
    scope = "" if q.answerable else "\n(The documents do not contain the answer to this question.)"
    return f"Question: {q.question}\n\nExpectation: {q.expect}{scope}\n\nAnswer to grade:\n{answer}"


def parse(text: str) -> Verdict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise LLMError(f"judge reply has no JSON: {text[:200]!r}")
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise LLMError(f"judge reply is not valid JSON: {e}") from e
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        raise LLMError(f"judge returned unknown verdict {verdict!r}")
    return Verdict(verdict, bool(data.get("hallucination", False)), str(data.get("reason", "")).strip())


def judge(llm: DeepSeek, q: Question, answer: str) -> Verdict:
    last: Exception | None = None
    for _ in range(2):  # one retry on an unparsable reply
        try:
            return parse(llm.chat(SYSTEM, user_prompt(q, answer)).text)
        except LLMError as e:
            last = e
    raise last  # type: ignore[misc]
