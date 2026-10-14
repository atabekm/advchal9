"""`uv run devreview <command>`

    index [--ref main] [--full]   embed new and changed docs and code into the index
    files                         what is indexed: one line per document
    search QUERY                  the passages retrieval finds, with scores
    context [TARGET]              what the reviewer would be shown, file by file

TARGET is one of
    --base main --head HEAD       two refs of this repository (the default)
    --pr N                        a GitHub pull request (through `gh`)
    --patch FILE [--base main]    a patch applied on top of a ref
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

from .context import build_context
from .corpus import GitError, GitTree, Tree, repo_root
from .diff import Change, GhError, PatchError, local, patched, pull_request
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


def load_change(args) -> Change:
    root = repo_root()
    if args.pr:
        return pull_request(root, args.pr)
    if args.patch:
        return patched(root, args.patch, args.base)
    return local(root, args.base, args.head)


def cmd_context(args) -> int:
    change = load_change(args)
    retriever = None if args.no_rag else Retriever(args.db)
    print(f"{BOLD}{change.title}{RESET}  {DIM}{change.base.sha[:7]}..{change.head.sha[:7]}, "
          f"{len(change.files)} files{RESET}")
    for fd in change.files:
        reason = fd.skip_reason()
        if reason:
            print(f"\n{DIM}{fd.path}: skipped ({reason}){RESET}")
            continue
        ctx = build_context(change, fd, retriever)
        print(f"\n{BOLD}{fd.path}{RESET} ({fd.status}, +{len(fd.added)} -{len(fd.removed)})")
        print(f"  changed:   {', '.join(s.name for s in ctx.touched.changed) or '-'}")
        if ctx.touched.removed:
            print(f"  removed:   {', '.join(ctx.touched.removed)}")
        print(f"  code:      {'whole file' if ctx.code_whole else 'excerpts'}, {len(ctx.code)} chars; "
              f"diff {len(ctx.numbered_diff)} chars")
        for name, us in ctx.callers.items():
            print(f"  callers of {name}:", *(f"\n    {u}" for u in us))
        for name, us in ctx.dangling.items():
            print(f"  {name} removed, still used:", *(f"\n    {u}" for u in us))
        for d in ctx.definitions:
            print(f"  calls {d.name}: {d.path}:{d.line}")
        for h in ctx.passages:
            print(f"  {h.kind:4} {h.label}  {DIM}rerank {h.rerank or 0:.2f}{RESET}")
    if retriever:
        retriever.close()
    return 0


def add_target(s: argparse.ArgumentParser) -> None:
    s.add_argument("--base", default="main", help="the branch the change goes into (default main)")
    s.add_argument("--head", default="HEAD", help="the change's branch or commit (default HEAD)")
    s.add_argument("--pr", type=int, help="a GitHub pull request number instead of --base/--head")
    s.add_argument("--patch", type=Path, help="a patch file, applied on top of --base")


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
    s = sub.add_parser("context", help="show what the reviewer would be shown")
    add_target(s)
    s.add_argument("--no-rag", action="store_true", help="skip retrieval (no index, no Ollama)")
    s.set_defaults(fn=cmd_context)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.fn(args)
    except (IndexMissing, EmbedError, GitError, GhError, PatchError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
