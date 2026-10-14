"""`uv run devreview <command>`

    index [--ref main] [--full]   embed new and changed docs and code into the index
    files                         what is indexed: one line per document
    search QUERY                  the passages retrieval finds, with scores
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

from .corpus import GitError, GitTree, Tree, repo_root
from .embed import EmbedError
from .index import DEFAULT_DB, build
from .retrieve import IndexMissing, Retriever
from .store import Store

DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def cmd_index(args) -> int:
    root = repo_root()
    tree = GitTree(root, args.ref) if args.ref else Tree(root)
    store = Store(args.db)
    try:
        report = build(store, tree, full=args.full, progress=lambda line: args.verbose and print(f"  {DIM}{line}{RESET}"))
    finally:
        store.close()
    print(report)
    return 0


def cmd_files(args) -> int:
    if not args.db.exists():
        raise IndexMissing(f"no index at {args.db} — run: uv run devreview index")
    store = Store(args.db)
    rows = store.files()
    for r in rows:
        print(f"{r['kind']:9} {r['chunks']:3} chunks  {r['source']}")
    kinds = Counter(r["kind"] for r in rows)
    meta = store.meta()
    print(f"\n{len(rows)} documents, {sum(r['chunks'] for r in rows)} chunks "
          f"({', '.join(f'{n} {k}' for k, n in kinds.most_common())}); "
          f"built from {meta.get('ref', '?')} {meta.get('sha', '')[:7]} at {meta.get('built_at', '?')}")
    store.close()
    return 0


def cmd_search(args) -> int:
    query = " ".join(args.query)
    retriever = Retriever(args.db)
    tasks = set(args.task) | {""} if args.task else set()
    for h in retriever.search(query, k=args.k, tasks=tasks, kind=args.kind, rerank=not args.no_rerank):
        rr = f"rerank {h.rerank:.3f}  " if h.rerank is not None else ""
        print(f"{BOLD}{h.kind:4}{RESET} {h.label}  {DIM}{rr}cos {h.score:.3f}  bm25 {h.bm25:.1f}{RESET}")
        print("     " + " ".join(h.text.split())[:240])
    retriever.close()
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="devreview", description="Automated code review of pull requests.")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"the index (default {DEFAULT_DB})")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("index", help="embed new and changed docs and code")
    s.add_argument("--ref", default="main", help="the commit to index (default main; '' for the working tree)")
    s.add_argument("--full", action="store_true", help="re-embed everything")
    s.add_argument("-v", "--verbose", action="store_true", help="one line per embedded file")
    s.set_defaults(fn=cmd_index)
    s = sub.add_parser("files", help="list indexed documents")
    s.set_defaults(fn=cmd_files)
    s = sub.add_parser("search", help="show what retrieval finds for a query")
    s.add_argument("query", nargs="+")
    s.add_argument("-k", type=int, default=6)
    s.add_argument("--task", action="append", default=[], help="only this task folder (and the repo docs)")
    s.add_argument("--kind", choices=["doc", "code"])
    s.add_argument("--no-rerank", action="store_true")
    s.set_defaults(fn=cmd_search)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.fn(args)
    except (IndexMissing, EmbedError, GitError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
