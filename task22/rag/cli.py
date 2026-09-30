"""rag — answer questions about the indexed documents, with or without retrieval.

  rag ask "question" --show-context [--strategy struct|fixed] [-k N]   the chunks RAG would send
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from pathlib import Path

from indexer.embed import EmbedError

from .retrieve import DEFAULT_DB, DEFAULT_K, DEFAULT_STRATEGY, STRATEGIES, Hit, IndexMissing, Retriever


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rag", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    ask = sub.add_parser("ask", help="answer one question")
    ask.add_argument("question")
    ask.add_argument("--db", type=Path, default=DEFAULT_DB)
    ask.add_argument("--strategy", choices=STRATEGIES, default=DEFAULT_STRATEGY)
    ask.add_argument("-k", type=int, default=DEFAULT_K, help="chunks to retrieve")
    ask.add_argument("--show-context", action="store_true", help="print the retrieved chunks")

    args = ap.parse_args(argv)
    try:
        return {"ask": cmd_ask}[args.cmd](args)
    except (EmbedError, IndexMissing) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def cmd_ask(args) -> int:
    retriever = Retriever(args.db)
    try:
        hits = retriever.search(args.question, args.strategy, args.k)
    finally:
        retriever.close()
    print_context(hits, args.strategy)
    return 0


def print_context(hits: list[Hit], strategy: str, width: int = 100) -> None:
    print(f"── context ({strategy}, k={len(hits)})")
    for h in hits:
        print(f"  [{h.rank}] {h.score:.3f}  {h.source}  {h.pages}  {h.section or '—'}")
        snippet = " ".join(h.text.split())
        snippet = snippet[:300] + ("…" if len(snippet) > 300 else "")
        print(textwrap.indent(textwrap.fill(snippet, width - 6), " " * 6))
    print()
