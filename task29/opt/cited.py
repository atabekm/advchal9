"""The structured answer: parse the model's JSON and check it against the retrieved chunks.

The model only gives passage numbers (`ref`). Source, section, pages and chunk_id come from
the `Hit` with that number, so the model cannot invent them.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .hits import Hit

CITE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
_LEAD = re.compile(r"^i don['’]t know\s*[:.,—-]?\s*", re.I)
_SPACE = re.compile(r"[ \t]+")


class FormatError(ValueError):
    """The reply does not follow the answer format; the message goes back to the model."""


@dataclass
class Quote:
    ref: int
    text: str
    score: float | None = None  # match against the chunk, 0..100, set by verify


@dataclass
class Cited:
    status: str  # "answer" | "unknown"
    answer: str
    quotes: list[Quote] = field(default_factory=list)
    clarification: str = ""


def markers(text: str) -> list[int]:
    """The [n] numbers in a text, in order of first appearance."""
    seen: dict[int, None] = {}
    for group in CITE.findall(text):
        for n in group.split(","):
            seen.setdefault(int(n), None)
    return list(seen)


def parse(text: str, hits: list[Hit]) -> Cited:
    """The reply as a Cited answer, or FormatError saying what is wrong with it."""
    try:
        data = json.loads(_strip_fence(text))
    except json.JSONDecodeError as e:
        raise FormatError(f"not valid JSON ({e.msg})") from None
    if not isinstance(data, dict):
        raise FormatError("the reply must be a JSON object")
    status = data.get("status")
    if status not in ("answer", "unknown"):
        raise FormatError('"status" must be "answer" or "unknown"')
    answer = _str(data, "answer").strip()
    clarification = _str(data, "clarification").strip()
    citations = data.get("citations") or []
    if not isinstance(citations, list):
        raise FormatError('"citations" must be a list')

    if status == "unknown":
        clarification = tidy(clarification)
        if not clarification:
            raise FormatError('status "unknown" needs a "clarification" question')
        return Cited("unknown", "", [], clarification)

    if not answer:
        raise FormatError('status "answer" needs a non-empty "answer"')
    refs = {h.rank for h in hits}
    quotes = []
    for c in citations:
        if not isinstance(c, dict) or not isinstance(c.get("quote"), str) or not c["quote"].strip():
            raise FormatError('each citation needs a "ref" number and a non-empty "quote"')
        ref = c.get("ref")
        if isinstance(ref, str) and ref.strip().strip("[]").isdigit():
            ref = int(ref.strip().strip("[]"))
        if not isinstance(ref, int) or ref not in refs:
            raise FormatError(f'citation ref {ref!r} is not a passage number; use one of {sorted(refs)}')
        quotes.append(Quote(ref, c["quote"].strip()))
    if not quotes:
        raise FormatError('status "answer" needs at least one citation with a quote')
    unknown = [n for n in markers(answer) if n not in refs]
    if unknown:
        raise FormatError(f"the answer cites [{unknown[0]}], which is not a passage number")
    unquoted = [n for n in markers(answer) if n not in {q.ref for q in quotes}]
    if unquoted:
        raise FormatError(f"the answer cites [{unquoted[0]}] but no citation quotes passage {unquoted[0]}")
    return Cited("answer", answer, quotes, "")


def sources(cited: Cited, hits: list[Hit]) -> list[Hit]:
    """The chunks the answer relies on: cited in the text or quoted, in order of first appearance."""
    by_rank = {h.rank: h for h in hits}
    order = dict.fromkeys([*markers(cited.answer), *(q.ref for q in cited.quotes)])
    return [by_rank[n] for n in order if n in by_rank]


def tidy(clarification: str) -> str:
    """Drop a repeated "I don't know:" and [n] markers: the user does not see the passages."""
    text = _LEAD.sub("", clarification.strip())
    return _SPACE.sub(" ", CITE.sub("", text)).replace(" .", ".").replace(" ,", ",").strip()


def _str(data: dict, key: str) -> str:
    value = data.get(key) or ""
    if not isinstance(value, str):
        raise FormatError(f'"{key}" must be a string')
    return value


def _strip_fence(text: str) -> str:
    """Models sometimes wrap JSON in a ```json fence even in JSON mode."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        text = text.rsplit("```", 1)[0]
    return text
