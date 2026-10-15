"""`uv run support <command>`

    ask QUESTION [--ticket T-1001] [--user u_102] [--json]
                       one answer: the customer's context over MCP, the docs, the model
    context [--ticket T] [--user U] [QUESTION]
                       what the model would be given (context, search query, passages), no model
    serve [--port 8033]
                       the HTTP service: POST /ask and the web page at /
    index [--full]     embed new and changed kb/ documents into index/index.db
    files              what is indexed: one line per document
    search QUERY       the passages retrieval finds for a query, with scores
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from .assistant import Answer, Assistant, ContextError, dumps, search_query, user_prompt
from .crm_client import CRMClient
from .embed import EmbedError
from .index import DEFAULT_DB, build
from .llm import LLMError, LocalLLM
from .retrieve import IndexMissing, Retriever
from .store import Store

DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def cmd_index(args) -> int:
    store = Store(args.db)
    try:
        report = build(store, full=args.full, progress=lambda line: print(f"  {DIM}{line}{RESET}"))
    finally:
        store.close()
    print(report)
    return 0


def cmd_files(args) -> int:
    if not args.db.exists():
        raise IndexMissing(f"no index at {args.db} — run: uv run support index")
    store = Store(args.db)
    rows = store.files()
    for r in rows:
        print(f"{r['chunks']:3} chunks  {r['source']:28} {r['title']}")
    print(f"\n{len(rows)} documents, {sum(r['chunks'] for r in rows)} chunks; built {store.meta().get('built_at', '?')}")
    store.close()
    return 0


def cmd_search(args) -> int:
    retriever = Retriever(args.db)
    for h in retriever.search(" ".join(args.query), k=args.k, rerank=not args.no_rerank):
        rr = f"rerank {h.rerank:.3f}  " if h.rerank is not None else ""
        print(f"{BOLD}[{h.rank}]{RESET} {h.label}  {DIM}{rr}cos {h.score:.3f}  bm25 {h.bm25:.1f}{RESET}")
        print("    " + " ".join(h.text.split())[:240])
    retriever.close()
    return 0


def render(a: Answer, color: bool = True) -> str:
    b, d, r = (BOLD, DIM, RESET) if color else ("", "", "")
    who = f"ticket {a.context.ticket_id}, " if a.context.ticket_id else ""
    who += f"user {a.context.user_id}" if a.context.user_id else "no customer context"
    lines = [f"{d}{who}{r}", "", a.text, ""]
    if a.agent_note:
        lines += [f"{b}agent note{r} {a.agent_note}", ""]
    if a.sources:
        lines.append(f"{b}sources{r}")
        lines += [f"  [{h.rank}] {h.label}" for h in a.sources]
    calls = ", ".join(f"{n}({', '.join(map(str, args.values()))})" for n, args, _ in a.crm_calls) or "none"
    lines.append(f"{d}MCP: {calls} · {a.prompt_tokens}+{a.completion_tokens} tokens · {a.seconds:.1f}s{r}")
    return "\n".join(lines)


ERRORS = (IndexMissing, EmbedError, LLMError, ContextError)


async def with_crm(fn):
    """`fn(crm)` inside an MCP session. An error is caught inside and raised after the session
    closes: raised inside, the MCP client's task group would wrap it in an ExceptionGroup."""
    async with CRMClient() as crm:
        try:
            return await fn(crm), None
        except ERRORS as e:
            error = e
    raise error


def cmd_ask(args) -> int:
    async def go(crm):
        assistant = Assistant(Retriever(args.db), crm, LocalLLM(args.model))
        return await assistant.ask(" ".join(args.question), args.ticket, args.user)
    answer, _ = asyncio.run(with_crm(go))
    print(dumps(answer) if args.json else render(answer, color=sys.stdout.isatty()))
    return 0


def cmd_context(args) -> int:
    question = " ".join(args.question) or "Why isn't authorization working?"

    async def go(crm):
        ctx = await Assistant(None, crm).context(args.ticket, args.user)  # the CRM first: no index needed to see it
        query = search_query(question, ctx)
        return ctx, query, Retriever(args.db).search(query)
    (ctx, query, hits), _ = asyncio.run(with_crm(go))
    print(user_prompt(question, ctx, hits))
    print(f"\n{DIM}search query: {query}{RESET}")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    from .service import create_app, default_factory

    app = create_app(default_factory(args.db, args.model))
    print(f"http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="support", description="A user support assistant for Flowdesk.")
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--model", default=None, help="Ollama model (default qwen3:8b)")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("ask", help="answer one question")
    s.add_argument("question", nargs="+")
    s.add_argument("--ticket", help="ticket id, e.g. T-1001")
    s.add_argument("--user", help="user id or email, e.g. u_102")
    s.add_argument("--json", action="store_true", help="the full record: context, passages, timings")
    s.set_defaults(fn=cmd_ask)
    s = sub.add_parser("context", help="what the model would be given, without the model")
    s.add_argument("question", nargs="*")
    s.add_argument("--ticket")
    s.add_argument("--user")
    s.set_defaults(fn=cmd_context)
    s = sub.add_parser("serve", help="the HTTP service and web page")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8033)
    s.set_defaults(fn=cmd_serve)
    s = sub.add_parser("index", help="embed new and changed kb/ documents")
    s.add_argument("--full", action="store_true", help="re-embed everything")
    s.set_defaults(fn=cmd_index)
    s = sub.add_parser("files", help="list indexed documents")
    s.set_defaults(fn=cmd_files)
    s = sub.add_parser("search", help="show what retrieval finds for a query")
    s.add_argument("query", nargs="+")
    s.add_argument("-k", type=int, default=5)
    s.add_argument("--no-rerank", action="store_true")
    s.set_defaults(fn=cmd_search)
    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except ERRORS as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
