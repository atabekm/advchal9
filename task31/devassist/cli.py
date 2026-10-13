"""`uv run devassist [command]`

    (none) / chat      the interactive assistant: /help QUESTION, /branch, /files, /diff, ...
    ask QUESTION       one /help answer and exit (--json for the full record)
    eval [ID ...]      run questions.json through /help and check the answers
    index [--full]     embed new and changed docs into index/index.db
    files              what is indexed: one line per document
    search QUESTION    the passages retrieval would give the model, with scores
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from pathlib import Path

from .assistant import dumps
from .embed import EmbedError
from .index import DEFAULT_DB, build
from .llm import LLMError
from .repl import make_assistant, render, run
from .retrieve import IndexMissing, Retriever, mentioned_tasks
from .store import Store
from .tools import DevTools

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
        raise IndexMissing(f"no index at {args.db} — run: uv run devassist index")
    store = Store(args.db)
    rows = store.files()
    for r in rows:
        print(f"{r['kind']:9} {r['chunks']:3} chunks  {r['source']}")
    kinds = Counter(r["kind"] for r in rows)
    print(f"\n{len(rows)} documents, {sum(r['chunks'] for r in rows)} chunks "
          f"({', '.join(f'{n} {k}' for k, n in kinds.most_common())}); built {store.meta().get('built_at', '?')}")
    store.close()
    return 0


def cmd_search(args) -> int:
    question = " ".join(args.question)
    retriever = Retriever(args.db)
    tasks = mentioned_tasks(question)
    if tasks:
        print(f"{DIM}scope: {', '.join(sorted(tasks))} + repository docs{RESET}")
    for h in retriever.search(question, k=args.k, rerank=not args.no_rerank):
        rr = f"rerank {h.rerank:.3f}  " if h.rerank is not None else ""
        print(f"{BOLD}[{h.rank}]{RESET} {h.label}  {DIM}{rr}cos {h.score:.3f}  bm25 {h.bm25:.1f}{RESET}")
        print("    " + " ".join(h.text.split())[:240])
    retriever.close()
    return 0


def cmd_chat(args) -> int:
    async def go():
        async with DevTools() as tools:
            await run(make_assistant(tools, args.db, args.model), color=sys.stdout.isatty())
    asyncio.run(go())
    return 0


def cmd_ask(args) -> int:
    async def go():
        async with DevTools() as tools:
            answer = await make_assistant(tools, args.db, args.model).help(" ".join(args.question))
        print(dumps(answer) if args.json else render(answer, color=sys.stdout.isatty()))
    asyncio.run(go())
    return 0


def cmd_eval(args) -> int:
    from . import evaluate as ev

    async def go():
        async with DevTools() as tools:
            assistant = make_assistant(tools, args.db, args.model)
            checks = await ev.evaluate(assistant, ev.load(only=args.ids))
            print()
            print(ev.summary(checks))
            print(f"\n{ev.save(checks, assistant.llm.model).relative_to(ev.TASK_DIR)}")
            return 0 if all(c.passed for c in checks) else 2
    return asyncio.run(go())


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="devassist", description="A developer assistant for this repository.")
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--model", default=None, help="Ollama model (default qwen3:8b)")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("chat", help="the interactive assistant (the default)")
    s.set_defaults(fn=cmd_chat)
    s = sub.add_parser("ask", help="answer one question and exit")
    s.add_argument("question", nargs="+")
    s.add_argument("--json", action="store_true", help="the full record: passages, tool calls, timings")
    s.set_defaults(fn=cmd_ask)
    s = sub.add_parser("eval", help="run questions.json and check the answers")
    s.add_argument("ids", nargs="*", help="only these question ids")
    s.set_defaults(fn=cmd_eval)
    s = sub.add_parser("index", help="embed new and changed docs")
    s.add_argument("--full", action="store_true", help="re-embed everything")
    s.set_defaults(fn=cmd_index)
    s = sub.add_parser("files", help="list indexed documents")
    s.set_defaults(fn=cmd_files)
    s = sub.add_parser("search", help="show what retrieval finds for a question")
    s.add_argument("question", nargs="+")
    s.add_argument("-k", type=int, default=6)
    s.add_argument("--no-rerank", action="store_true")
    s.set_defaults(fn=cmd_search)
    args = p.parse_args(argv)
    try:
        return args.fn(args) if args.cmd else cmd_chat(args)
    except (IndexMissing, EmbedError, LLMError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
