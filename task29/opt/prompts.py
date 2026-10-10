"""The prompt templates being compared. Each one turns (question, passages) into chat messages.

  naive    what a first attempt looks like: "answer from the context, reply in this JSON"
  task27   task 27's cited prompt as it ships (rules for quotes, "I don't know", ambiguity)
  tuned    written for qwen3:8b from the failures of the other two (see README)

All of them ask for the same JSON object, so one parser scores them all.
"""

from __future__ import annotations

from .hits import Hit

SHAPE = '{"status": "answer", "answer": "...", "citations": [{"ref": 1, "quote": "..."}], "clarification": ""}'


def context_block(hits: list[Hit]) -> str:
    parts = []
    for h in hits:
        where = f"{h.title} ({h.source}), {h.pages}"
        if h.section:
            where += f", section: {h.section}"
        parts.append(f"[{h.rank}] {where}\n{h.text.strip()}")
    return "\n\n".join(parts)


# --- naive -----------------------------------------------------------------------------------

NAIVE_SYSTEM = f"""\
Answer the question using the context. Reply in JSON:
{SHAPE}
"citations" lists the passage numbers you used and a quote from each. If the context does not
contain the answer, set "status" to "unknown" and ask a clarifying question in "clarification"."""


def naive_user(question: str, hits: list[Hit]) -> str:
    return f"Context:\n\n{context_block(hits)}\n\nQuestion: {question}"


# --- task27 (copied from task27/rag/prompt.py) -----------------------------------------------

TASK27_SYSTEM = """\
You answer questions using ONLY the numbered context passages from a document collection,
and you back every answer with quotes from those passages.

Reply with one JSON object only, in this shape:
{"status": "answer", "answer": "...", "citations": [{"ref": 1, "quote": "..."}], "clarification": ""}

Rules:
- "answer": use only facts stated in the passages; no outside knowledge. Mark each claim with
  the passage it comes from, as [n] right after the claim, e.g. "... 70 hours [2]."
  Be concise: a few sentences, or a short list when the question asks for several items.
- "citations": at least one. "ref" is the passage number n. "quote" is copied word for word
  from passage n: one sentence or a short span (at most ~40 words). Do not paraphrase, shorten
  with "...", or join text from two places in one quote.
- Every fact in the answer (number, name, claim) must be stated in one of your quotes. Give one
  quote per fact or sentence, as many as needed. If you cannot quote a fact, leave it out of the
  answer; a shorter answer that is fully quoted is better than a longer one.
  Every [n] in the answer needs at least one quote from passage n.
- If the question is ambiguous (it could mean different things the passages describe, e.g.
  "the evaluation" when they describe several evaluations of different systems), do not pick
  one: reply with status "unknown" and ask which one is meant, naming the options. A question
  that asks about several things at once ("which documents …") is not ambiguous; answer it.
- If the passages do not state the answer, do not guess. Reply
  {"status": "unknown", "answer": "", "citations": [], "clarification": "..."}
  where "clarification" is one or two short sentences back to the user: what the passages do
  cover near the question, then one question that would help (what they meant, or a narrower
  question). Do not answer the question there either, and do not use [n] markers: the user
  does not see the passages.
- "clarification" is "" when status is "answer"."""


def task27_user(question: str, hits: list[Hit]) -> str:
    return f"Context:\n\n{context_block(hits)}\n\nQuestion: {question}\n\nReply with the JSON object."


# --- tuned -------------------------------------------------------------------------------------
# Three versions, each run on the eval set (README, "Prompt"). `tuned` is the one that ships:
# adding rules for each remaining failure (`tuned-rules`), or a reasoning field in front of
# the JSON (`tuned-check`), made qwen3:8b worse, not better.

_INTRO = """\
You answer questions about a document collection. You get numbered passages and a question,
and you reply with one JSON object.
"""

_REFS = """
[n] means passage n of the ones given to you. Numbers in brackets inside a passage's text, like
"LibriTTS [7]", are that paper's own references: never use them in "answer" or "ref".
"""

_EXAMPLE_PASSAGE = """
Example. Passages: [1] "... The corpus contains 12 hours of recordings from a single speaker. ..."
Question: "How long is the corpus and how many speakers recorded it?"
"""
_EXAMPLE_REPLY = """\
 "citations": [{"ref": 1, "quote": "The corpus contains 12 hours of recordings from a single speaker."}],
 "status": "answer", "answer": "It has 12 hours of recordings from one speaker [1].", "clarification": ""}"""

TUNED_STEPS = """
Work in this order:
1. "citations": find the sentences in the passages that answer the question and copy each one
   exactly, character for character, with its passage number as "ref". One sentence per quote;
   never shorten, merge or reword. Usually 1 to 4 quotes.
2. "status": "answer" if your quotes answer the question. "unknown" if no passage states the
   answer (then "citations" is []), or if the question could mean two different things the
   passages describe (e.g. two different evaluations): then don't pick one.
3. "answer" (status "answer"): answer in a few sentences, using only what your quotes say, and
   put [n] after each claim. Keep every number exactly as written. If the question gives a value
   in a different unit than the passage's formula (kg vs pounds), convert it first and show the step.
4. "clarification" (status "unknown"): one or two sentences: what the passages do cover close to
   the question, then one question back to the user. No [n] markers. Otherwise "".
"""

RULES_STEPS = """
Work in this order:
1. "citations": find the sentences in the passages that answer the question and copy each one
   exactly, character for character, with its passage number as "ref". One sentence per quote;
   never shorten, merge or reword. Usually 1 to 4 quotes; a question with several parts needs a
   quote for each part.
2. "status": "answer" if your quotes answer the question. "unknown" (and "citations" []) when:
   - no passage states the answer. A value for a different item is not the answer: if the
     question names a language pair, model, dataset or person, the quote must be about exactly
     that one, not a neighbouring row of a table;
   - the question says "the evaluation", "the module", "the dataset" without saying which one,
     and the passages describe more than one (often from different documents). Don't pick one.
3. "answer" (status "answer"): use only what your quotes say, and put [n] after each claim.
   Answer every part of the question, and keep the specifics: names of methods, tools and
   models, and every number exactly as written. When the answer needs a calculation, write it
   out ("200 lb x 10 = 2,000"); if the question gives a value in another unit than the
   passage's formula (kg vs pounds), convert it first.
4. "clarification" (status "unknown"): one or two sentences: what the passages do cover close to
   the question, then one question back to the user (when it's unclear which one, name the
   options). No [n] markers. Otherwise "".
"""

CHECK_STEP = """
Before anything else, "check": one or two short sentences: which exact item the question asks
about (which document, dataset, language pair, person, number), whether a passage states it for
exactly that item, and the calculation if the answer needs one.
"""

TUNED_SYSTEM = _INTRO + TUNED_STEPS + _REFS + _EXAMPLE_PASSAGE + "{" + _EXAMPLE_REPLY[1:]
RULES_SYSTEM = _INTRO + RULES_STEPS + _REFS + _EXAMPLE_PASSAGE + "{" + _EXAMPLE_REPLY[1:]
CHECK_SYSTEM = (_INTRO + CHECK_STEP + RULES_STEPS + _REFS + _EXAMPLE_PASSAGE
                + '{"check": "Asks the corpus\'s length and speakers; passage 1 states both.",\n' + _EXAMPLE_REPLY)

_CITATIONS = {"type": "array", "items": {
    "type": "object",
    "properties": {"ref": {"type": "integer"}, "quote": {"type": "string"}},
    "required": ["ref", "quote"]}}

# citations come first: the model copies the quotes, then writes the answer from them
TUNED_SCHEMA = {
    "type": "object",
    "properties": {
        "citations": _CITATIONS,
        "status": {"type": "string", "enum": ["answer", "unknown"]},
        "answer": {"type": "string"},
        "clarification": {"type": "string"},
    },
    "required": ["citations", "status", "answer", "clarification"],
}

CHECK_SCHEMA = {
    "type": "object",
    "properties": {"check": {"type": "string"}, **TUNED_SCHEMA["properties"]},
    "required": ["check", *TUNED_SCHEMA["required"]],
}


def tuned_user(question: str, hits: list[Hit]) -> str:
    return f"Passages:\n\n{context_block(hits)}\n\nQuestion: {question}"


TEMPLATES = {
    "naive": (NAIVE_SYSTEM, naive_user),
    "task27": (TASK27_SYSTEM, task27_user),
    "tuned": (TUNED_SYSTEM, tuned_user),
    "tuned-rules": (RULES_SYSTEM, tuned_user),
    "tuned-check": (CHECK_SYSTEM, tuned_user),
}


def messages(template: str, question: str, hits: list[Hit], with_system: bool = True) -> list[dict]:
    """`with_system=False` for a model whose Modelfile already carries the system prompt."""
    system, user = TEMPLATES[template]
    msgs = [{"role": "system", "content": system}] if with_system else []
    return msgs + [{"role": "user", "content": user(question, hits)}]
