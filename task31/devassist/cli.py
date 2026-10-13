"""`uv run devassist <command>`

    index [--full]     embed new and changed docs into index/index.db
    files              what is indexed: one line per document
    search QUESTION    the passages retrieval would give the model, with scores
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

from .embed import EmbedError
from .index import DEFAULT_DB, build
from .retrieve import IndexMissing, Retriever, mentioned_tasks
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


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="devassist", description="A developer assistant for this repository.")
    p.add_argument("--db", type=lambda s: __import__("pathlib").Path(s), default=DEFAULT_DB)
    sub = p.add_subparsers(dest="cmd", required=True)
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
        return args.fn(args)
    except (IndexMissing, EmbedError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
