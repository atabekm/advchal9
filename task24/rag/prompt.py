"""The prompts. RAG prompts number the chunks so answers can cite [n]; the cited prompt asks for JSON with quotes."""

from __future__ import annotations

from .retrieve import Hit

NOT_FOUND = "The documents do not contain the answer."

PLAIN_SYSTEM = """\
You are a helpful assistant. Answer the question concisely and factually.
If you do not know the answer, say so instead of guessing."""

RAG_SYSTEM = f"""\
You answer questions using ONLY the numbered context passages from a document collection.
Rules:
- Use only facts stated in the context. Do not add knowledge from outside it.
- Cite the passages you used as [n] right after the claim they support, e.g. "... 70 hours [2]."
- If the context does not contain the answer, reply exactly: "{NOT_FOUND}"
  You may then add one sentence on what the context does cover.
- Be concise: a few sentences, or a short list when the question asks for several items."""


IDK = "I don't know: the documents do not contain the answer."

CITED_SYSTEM = """\
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


def cited_user(question: str, hits: list[Hit]) -> str:
    return f"Context:\n\n{context_block(hits)}\n\nQuestion: {question}\n\nReply with the JSON object."


def retry_user(user: str, error: str) -> str:
    """The same request again, with what was wrong with the previous reply."""
    return f"{user}\n\nYour previous reply was rejected: {error}. Reply again with the JSON object only, following the rules."


def context_block(hits: list[Hit]) -> str:
    parts = []
    for h in hits:
        where = f"{h.title} ({h.source}), {h.pages}"
        if h.section:
            where += f", section: {h.section}"
        parts.append(f"[{h.rank}] {where}\n{h.text.strip()}")
    return "\n\n".join(parts)


def rag_user(question: str, hits: list[Hit]) -> str:
    return f"Context:\n\n{context_block(hits)}\n\nQuestion: {question}"


def plain_user(question: str) -> str:
    return question
