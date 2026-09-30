"""rag — answer questions about the indexed documents, with or without retrieval.

  rag ask  "question" [--mode rag|plain|both] [--strategy struct|fixed] [-k N] [--show-context]
  rag chat [--mode rag|plain] [--strategy struct|fixed] [-k N]
           in chat: /rag on|off  /strategy struct|fixed  /k N  /context on|off  /quit
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from pathlib import Path

from indexer.embed import EmbedError

from .agent import MODES, Agent, Answer
from .llm import MODELS, DeepSeek, LLMError
from .retrieve import DEFAULT_DB, DEFAULT_K, DEFAULT_STRATEGY, STRATEGIES, Hit, IndexMissing, Retriever

WIDTH = 100


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rag", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--db", type=Path, default=DEFAULT_DB)
        p.add_argument("--model", choices=MODELS, default=MODELS[0])
        p.add_argument("--strategy", choices=STRATEGIES, default=DEFAULT_STRATEGY)
        p.add_argument("-k", type=int, default=DEFAULT_K, help="chunks to retrieve")

    ask = sub.add_parser("ask", help="answer one question")
    ask.add_argument("question")
    ask.add_argument("--mode", choices=[*MODES, "both"], default="both")
    ask.add_argument("--show-context", action="store_true", help="print the retrieved chunks")
    common(ask)

    chat = sub.add_parser("chat", help="interactive session with a RAG on/off switch")
    chat.add_argument("--mode", choices=MODES, default="rag")
    chat.add_argument("--show-context", action="store_true")
    common(chat)

    args = ap.parse_args(argv)
    try:
        return {"ask": cmd_ask, "chat": cmd_chat}[args.cmd](args)
    except (EmbedError, IndexMissing, LLMError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _agent(args, need_index: bool) -> Agent:
    llm = DeepSeek(args.model)
    return Agent(llm, Retriever(args.db) if need_index else None)


def cmd_ask(args) -> int:
    modes = list(MODES)[::-1] if args.mode == "both" else [args.mode]  # plain first, then rag
    agent = _agent(args, "rag" in modes)
    for mode in modes:
        ans = agent.answer(args.question, mode, args.strategy, args.k)
        if ans.hits and args.show_context:
            print_context(ans.hits, args.strategy)
        print_answer(ans)
    return 0


def cmd_chat(args) -> int:
    agent = _agent(args, need_index=True)
    mode, strategy, k, show = args.mode, args.strategy, args.k, args.show_context
    print(f"rag chat · {args.model} · type /help for commands")
    while True:
        try:
            line = input(f"\n[{mode if mode == 'plain' else f'rag/{strategy} k={k}'}] › ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            continue
        if line.startswith("/"):
            cmd, _, arg = line[1:].partition(" ")
            arg = arg.strip()
            if cmd in ("quit", "exit", "q"):
                return 0
            elif cmd == "rag" and arg in ("on", "off"):
                mode = "rag" if arg == "on" else "plain"
            elif cmd == "strategy" and arg in STRATEGIES:
                strategy = arg
            elif cmd == "k" and arg.isdigit() and int(arg) > 0:
                k = int(arg)
            elif cmd == "context" and arg in ("on", "off"):
                show = arg == "on"
            else:
                print("  /rag on|off   /strategy struct|fixed   /k N   /context on|off   /quit")
            continue
        try:
            ans = agent.answer(line, mode, strategy, k)
        except (EmbedError, LLMError) as e:
            print(f"error: {e}")
            continue
        if ans.hits and show:
            print_context(ans.hits, strategy)
        print_answer(ans)


def print_context(hits: list[Hit], strategy: str) -> None:
    print(f"── context ({strategy}, k={len(hits)})")
    for h in hits:
        print(f"  [{h.rank}] {h.score:.3f}  {h.source}  {h.pages}  {h.section or '—'}")
        snippet = " ".join(h.text.split())
        snippet = snippet[:300] + ("…" if len(snippet) > 300 else "")
        print(textwrap.indent(textwrap.fill(snippet, WIDTH - 6), " " * 6))
    print()


def print_answer(ans: Answer) -> None:
    print(f"── {ans.label}  ({ans.prompt_tokens}→{ans.completion_tokens} tokens, {ans.seconds:.1f}s)")
    for para in ans.text.splitlines():
        print(textwrap.fill(para, WIDTH, initial_indent="  ", subsequent_indent="  ") if para.strip() else "")
    if ans.cited:
        print("  sources:")
        for h in ans.cited:
            print(f"    [{h.rank}] {h.source}  {h.pages}  {h.section or '—'}")
    elif ans.mode == "rag":
        print("  sources: none cited")
    print()
