"""The prompts for both modes. RAG mode numbers the chunks so answers can cite [n]."""

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
