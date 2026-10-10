"""Rule-based scoring of one reply. No LLM judge: every check is deterministic.

For a question the documents answer:
  format    the reply parses as the answer JSON (cited.parse)
  status    it answers instead of saying "I don't know"
  facts     the share of must_contain groups found in the answer
  quotes    the share of quotes that really are in the passage they cite (verify, >= 90%)
  source    a cited passage comes from an expected document and page
For an unanswerable or ambiguous one, the right reply is status "unknown" with a clarification.

  score    answerable: facts 0.5 + quotes 0.25 + source 0.25 (0 when format or status fails)
           not answerable: 1 when it says "unknown", else 0
  correct  answerable: every fact, at least one verified quote, an expected source, no failed quote
           not answerable: status "unknown"
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from . import cited as fmt
from .evalset import Question, cited_expected, keyword_score
from .hits import Hit
from .verify import verify


@dataclass
class Score:
    format_ok: bool
    format_error: str
    status: str  # "answer" | "unknown" | "" when the format fails
    status_ok: bool
    facts: float
    quotes_total: int
    quotes_ok: int
    source_ok: bool
    score: float
    correct: bool
    answer: str

    def to_dict(self) -> dict:
        return asdict(self)


def score(q: Question, text: str, hits: list[Hit]) -> Score:
    try:
        c = fmt.parse(text, hits)
    except fmt.FormatError as e:
        return Score(False, str(e), "", False, 0.0, 0, 0, False, 0.0, False, text[:500])
    shown = c.answer if c.status == "answer" else c.clarification
    if not q.answerable:
        ok = c.status == "unknown"
        return Score(True, "", c.status, ok, 0.0, len(c.quotes), 0, False, float(ok), ok, shown)
    if c.status != "answer":
        return Score(True, "", c.status, False, 0.0, 0, 0, False, 0.0, False, shown)
    verified, failed = verify(c.quotes, hits)
    facts, _ = keyword_score(q, c.answer)
    source_ok = bool(cited_expected(q, fmt.sources(c, hits)))
    quotes = len(verified) / len(c.quotes)
    s = 0.5 * facts + 0.25 * quotes + 0.25 * source_ok
    correct = facts == 1.0 and verified and not failed and source_ok
    return Score(True, "", "answer", True, facts, len(c.quotes), len(verified), source_ok, round(s, 3),
                 bool(correct), shown)
