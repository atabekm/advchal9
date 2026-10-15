"""Answer a support question from the knowledge base and the customer's context.

1. **Context, always.** With a ticket: `get_ticket`, then `get_user` for its author (with the
   organization) and `list_user_tickets` for their other tickets. With only a user: the last
   two. All through MCP, before the model runs: whether the account is locked must never depend
   on the model deciding to look.
2. **The ticket steers retrieval.** "Why isn't authorization working?" alone retrieves the same
   passages for every customer. The search query adds the ticket's subject, error code, area and
   environment, the error codes in the user's recent failures, and words for the account states
   the CRM flags (locked, invited, suspended, SSO required; a revoked key or a disconnected
   integration only without a ticket: Brightpath's broken Slack has nothing to do with Tom's
   sign-in).
3. **One model call** with the context and the top passages, numbered [1]..[n].
4. **Citations are checked**: a [n] that points at no passage is removed. The model ends with
   an "Agent note:" line (the cause and the fact that shows it), split off for the support agent.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field

from .crm_client import CRMClient
from .llm import LocalLLM
from .retrieve import K, Hit, Retriever

PASSAGE_CHARS = 1800

SYSTEM = """\
You are the support assistant of Flowdesk, a task tracker for teams (web, desktop and mobile apps,
and a REST API). You answer customers' questions about the product.

Each question comes with:
- CUSTOMER CONTEXT: live data from the support CRM about the customer asking: the ticket they
  opened (with the error code the app attached), their account, their organization's settings
  and subscription, and their earlier tickets. It may be missing.
- KNOWLEDGE BASE: passages from Flowdesk's FAQ and documentation, numbered [1], [2], ...

How to answer:
1. If there is customer context, find the cause there first. Compare the facts (account status,
   error codes, recent failures, the organization's SSO, subscription and API keys, app versions,
   dates and how long ago they were) with what the passages say. Name the specific cause for THIS
   customer, and the fact that shows it, e.g. "your account was locked at 11:40 after 5 failed
   attempts". Don't list causes that the context rules out.
2. Then the steps to fix it, from the passages. If someone else has to act (an admin, the owner,
   the billing admin, their IT team), say who, by name when the context has it.
3. Without customer context, answer from the passages; if the answer depends on the account, give
   the most likely causes briefly and what to check.

Rules:
- Use only what the context and the passages say. Never invent settings, menu paths, prices,
  versions or time limits.
- Cite the passages you use, like [2], at the end of the sentence. Facts from the customer
  context need no citation.
- Never show the customer internal ids (u_110, org_acme): people by name, things by what they are.
- Write to the customer directly ("you"), by first name if known, friendly and concise: a few
  sentences or a short list. Answer in the language of the QUESTION.
- If nothing you have answers it, say so and suggest contacting support with the error code.
- End with one separate last line, in English, for the support agent:
  Agent note: <the cause in one sentence> (evidence: <the fact from the context>)
  Without customer context: Agent note: no customer context."""


class ContextError(LookupError):
    """The ticket or user doesn't exist."""


@dataclass
class Context:
    ticket_id: str | None = None
    user_id: str | None = None
    ticket: str = ""
    user: str = ""
    history: str = ""

    @property
    def empty(self) -> bool:
        return not (self.ticket or self.user)

    def blocks(self) -> list[tuple[str, str]]:
        return [(name, text) for name, text in (("TICKET", self.ticket), ("CUSTOMER AND ORGANIZATION", self.user),
                                               ("EARLIER TICKETS", self.history)) if text]


@dataclass
class Answer:
    question: str
    text: str
    agent_note: str
    context: Context
    query: str
    hits: list[Hit]
    cited: list[int] = field(default_factory=list)
    crm_calls: list[tuple[str, dict, str]] = field(default_factory=list)
    seconds: float = 0.0
    retrieval_seconds: float = 0.0
    llm_seconds: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""

    @property
    def sources(self) -> list[Hit]:
        return [h for h in self.hits if h.rank in self.cited]


class Assistant:
    def __init__(self, retriever: Retriever, crm: CRMClient, llm: LocalLLM | None = None, k: int = K):
        self.retriever = retriever
        self.crm = crm
        self.llm = llm or LocalLLM()
        self.k = k

    async def context(self, ticket_id: str | None = None, user_id: str | None = None) -> Context:
        ctx = Context(ticket_id=ticket_id or None, user_id=user_id or None)
        if ctx.ticket_id:
            ctx.ticket = await self._get("get_ticket", {"ticket_id": ctx.ticket_id})
            ctx.ticket_id = ctx.ticket.split(" ", 2)[1]  # normalized: "t1001" → "T-1001"
            m = re.search(r"^customer: .*?\((u_\w+)\)", ctx.ticket, re.M)
            ctx.user_id = ctx.user_id or (m.group(1) if m else None)
        if ctx.user_id:
            ctx.user = await self._get("get_user", {"user": ctx.user_id})
            ctx.user_id = ctx.user.split(" ", 2)[1]  # an email resolves to the id
            args = {"user": ctx.user_id} | ({"exclude_ticket": ctx.ticket_id} if ctx.ticket_id else {})
            history = await self.crm.call("list_user_tickets", args)
            ctx.history = "" if history.startswith("error:") or " has no " in history else history
        return ctx

    async def _get(self, tool: str, args: dict) -> str:
        out = await self.crm.call(tool, args)
        if out.startswith("error:"):
            raise ContextError(out.removeprefix("error:").strip())
        return out

    async def ask(self, question: str, ticket_id: str | None = None, user_id: str | None = None) -> Answer:
        started = time.monotonic()
        before = len(self.crm.calls)
        ctx = await self.context(ticket_id, user_id)
        query = search_query(question, ctx)
        t0 = time.monotonic()
        hits = await asyncio.to_thread(self.retriever.search, query, self.k)
        retrieval = time.monotonic() - t0
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user_prompt(question, ctx, hits)}]
        reply = await asyncio.to_thread(self.llm.chat, messages)
        body, note = split_agent_note(reply.text or "I couldn't produce an answer (the model returned nothing).")
        text, cited = check_citations(body, len(hits))
        return Answer(question, text, note, ctx, query, hits, cited, self.crm.calls[before:],
                      seconds=time.monotonic() - started, retrieval_seconds=retrieval, llm_seconds=reply.seconds,
                      prompt_tokens=reply.prompt_tokens, completion_tokens=reply.completion_tokens,
                      model=self.llm.model)


CODE_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
STATE_HINTS = [  # a fact the CRM spells out → words the knowledge base uses for it
    ("account status: LOCKED", "account locked too many attempts lockout"),
    ("account status: INVITED", "invitation expired resend invite"),
    ("account status: DEACTIVATED", "account deactivated"),
    ("workspace SUSPENDED", "workspace suspended unpaid invoice"),
    ("subscription: PAST DUE", "subscription past due unpaid invoice"),
    ("single sign-on: REQUIRED", "require SSO sign in with SSO"),
]
ORG_HINTS = [  # organization-wide things that are only a lead when there is no ticket to say what's wrong
    (": REVOKED", "API key revoked"),
    (": DISCONNECTED", "integration disconnected reconnect"),
]


def search_query(question: str, ctx: Context) -> str:
    """The question plus what the context says about the problem, for retrieval."""
    parts = [question.strip()]
    if ctx.ticket:
        fields = dict(re.findall(r"^(subject|error code attached by the app|environment): (.*)$", ctx.ticket, re.M))
        area = re.search(r"· area (.+)$", ctx.ticket.splitlines()[0])
        parts.append(fields.get("subject", ""))
        if area:
            parts.append(area.group(1))
        code = fields.get("error code attached by the app", "none")
        if code != "none":
            parts.append(f"error {code}")
        parts.append(fields.get("environment", ""))
    if ctx.user:
        for line in ctx.user.splitlines():
            if line.startswith(("recent sign-in failures:", "clients:")):
                parts.extend(c for c in CODE_RE.findall(line) if c not in " ".join(parts))
        hints = STATE_HINTS + ([] if ctx.ticket else ORG_HINTS)
        parts.extend(hint for flag, hint in hints if flag in ctx.user)
    return ". ".join(p for p in parts if p)


def user_prompt(question: str, ctx: Context, hits: list[Hit]) -> str:
    if ctx.empty:
        context = "none: the question was asked without a ticket or a signed-in customer"
    else:
        context = "\n\n".join(f"{name}\n{text}" for name, text in ctx.blocks())
    passages = "\n\n".join(f"[{h.rank}] {h.label}\n{_clip(h.text)}" for h in hits) or "(no passages found)"
    return (f"CUSTOMER CONTEXT (from the CRM, live)\n{context}\n\n"
            f"KNOWLEDGE BASE\n{passages}\n\n"
            f"QUESTION\n{question}\n\n"
            f"(Cite every passage you use as [n]. End with the Agent note line.)")


def _clip(text: str) -> str:
    return text if len(text) <= PASSAGE_CHARS else text[:PASSAGE_CHARS] + " …"


NOTE_RE = re.compile(r"^\W*agent note\W*:?\**\s*(.*)$", re.I | re.M)


def split_agent_note(text: str) -> tuple[str, str]:
    """The reply without its "Agent note:" line, and the note."""
    m = None
    for m in NOTE_RE.finditer(text):
        pass  # the last one
    if not m:
        return text.strip(), ""
    note = m.group(1).strip().strip("*_ ")
    body = (text[:m.start()] + text[m.end():]).strip()
    body = re.sub(r"\n\s*-{3,}\s*$", "", body).strip()  # a rule the model put before the note
    return body, note


CITE_RE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")


def check_citations(text: str, n_hits: int) -> tuple[str, list[int]]:
    """Drop [n] markers that point at no passage; return the text and the passages cited."""
    cited: list[int] = []

    def fix(m: re.Match) -> str:
        nums = [int(x) for x in re.findall(r"\d+", m.group(1))]
        good = [n for n in nums if 1 <= n <= n_hits]
        cited.extend(n for n in good if n not in cited)
        return f"[{', '.join(map(str, good))}]" if good else ""

    fixed = CITE_RE.sub(fix, text)
    fixed = re.sub(r"[ \t]+([.,;:])", r"\1", fixed)
    return fixed, sorted(cited)


def answer_json(a: Answer) -> dict:
    return {
        "question": a.question,
        "answer": a.text,
        "agent_note": a.agent_note,
        "ticket_id": a.context.ticket_id,
        "user_id": a.context.user_id,
        "context": [{"name": name, "text": text} for name, text in a.context.blocks()],
        "search_query": a.query,
        "passages": [{"rank": h.rank, "label": h.label, "source": h.source, "text": h.text, "rerank": h.rerank,
                      "cited": h.rank in a.cited} for h in a.hits],
        "crm_calls": [{"tool": n, "arguments": args} for n, args, _ in a.crm_calls],
        "model": a.model,
        "seconds": round(a.seconds, 1),
        "timings": {"retrieval": round(a.retrieval_seconds, 2), "llm": round(a.llm_seconds, 1)},
        "tokens": {"prompt": a.prompt_tokens, "completion": a.completion_tokens},
    }


def dumps(a: Answer) -> str:
    return json.dumps(answer_json(a), ensure_ascii=False, indent=2)
