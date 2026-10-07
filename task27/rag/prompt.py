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


CHAT_RULES = """

This question comes from a conversation. Before the passages you get the recent conversation
and, when there is one, the task memory: the user's goal, what they clarified about
themselves, the constraints and terms agreed. Use them to understand what the user wants and
how to answer:
- Follow the constraints (length, units, format, focus). "Short" means two or three sentences.
- Apply the passages to the user's situation when the passages give a method or rule: e.g.
  plug the user's weight into the book's formula. You may convert units and do simple
  arithmetic on numbers from the passages; show the step, and quote the passage that gives the
  original numbers or formula. Do not apply anything the passages do not state.
- If the passages answer the general question but say nothing about the user's particular
  situation (e.g. they are vegetarian), give the general answer and say briefly that the
  passages don't cover that case.
Facts still come only from the passages, never from the conversation or earlier answers: an
earlier answer is not a source."""

CITED_CHAT_SYSTEM = CITED_SYSTEM + CHAT_RULES


def cited_user(question: str, hits: list[Hit], conversation: str = "", constraints: list[str] = ()) -> str:
    head = f"{conversation}\n\n" if conversation else ""
    return (f"{head}Context:\n\n{context_block(hits)}\n\nQuestion: {question}\n\n"
            f"{constraints_line(constraints)}Reply with the JSON object.")


def constraints_line(constraints: list[str]) -> str:
    """Repeated next to the question: in the memory block at the top of a long prompt they get lost."""
    if not constraints:
        return ""
    return "The user's constraints for every answer (follow them): " + "; ".join(constraints) + ".\n\n"


META_SYSTEM = """\
You are the assistant in a chat about a small document collection. Every factual answer in this
chat comes from the documents, with sources. This message is not a question for the documents:
it is small talk, an instruction about how to answer, or a question about the conversation
itself ("what have we agreed so far?", "what was my goal?").

Reply briefly and naturally, using only the conversation you are given. When asked to recap,
summarize what the conversation established, without adding new facts about the documents.
If the user actually needs information from the documents, invite them to ask it as a question.
Plain text, no [n] markers."""


def meta_user(message: str, conversation: str, constraints: list[str] = ()) -> str:
    return f"{conversation}\n\nNew message: {message.strip()}\n\n{constraints_line(constraints)}".rstrip()


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
