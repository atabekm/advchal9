"""indexer — build and inspect a local document index.

  indexer show  [--docs DIR] [--headings] [FILE...]   what extraction found
  indexer show  --chunks fixed|struct [--limit N]      chunk boundaries and metadata
  indexer index [--docs DIR] [--db FILE] [--rebuild]    chunk both ways, embed, store
  indexer query [--strategy S] [-k N] "question"        nearest chunks (sanity check)
  indexer stats [--db FILE] [--markdown FILE]           compare the two strategies
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import chunk_fixed as fixed_mod
from . import chunk_struct as struct_mod
from . import embed as embed_mod
from .chunk_fixed import chunk_fixed
from .chunk_struct import chunk_struct
from .embed import Embedder, EmbedError
from .extract import extract, find_sources
from .stats import collect, render_markdown, render_terminal
from .store import Store

CHUNKERS = {"fixed": chunk_fixed, "struct": chunk_struct}

TASK_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DOCS = TASK_DIR / "docs"
DEFAULT_DB = TASK_DIR / "index" / "index.db"

# What the vectors in an index depend on; a mismatch means --rebuild.
INDEX_META = {
    "model": embed_mod.MODEL,
    "doc_prefix": embed_mod.DOC_PREFIX,
    "fixed_size": fixed_mod.SIZE,
    "fixed_overlap": fixed_mod.OVERLAP,
    "struct_max_chars": struct_mod.MAX_CHARS,
    "struct_min_chars": struct_mod.MIN_CHARS,
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="indexer", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    show = sub.add_parser("show", help="print what extraction found in each document")
    show.add_argument("--docs", type=Path, default=DEFAULT_DOCS)
    show.add_argument("--headings", action="store_true", help="list every heading found")
    show.add_argument("--chunks", choices=CHUNKERS, help="print the chunks this strategy makes")
    show.add_argument("--limit", type=int, default=8, help="chunks per document with --chunks (0 = all)")
    show.add_argument("files", nargs="*", type=Path, help="only these files (default: all in --docs)")

    index = sub.add_parser("index", help="chunk every document both ways, embed, store in SQLite")
    index.add_argument("--docs", type=Path, default=DEFAULT_DOCS)
    index.add_argument("--db", type=Path, default=DEFAULT_DB)
    index.add_argument("--rebuild", action="store_true", help="drop the index and embed everything again")

    query = sub.add_parser("query", help="embed a question and print the nearest chunks")
    query.add_argument("--db", type=Path, default=DEFAULT_DB)
    query.add_argument("--strategy", choices=[*CHUNKERS, "both"], default="both")
    query.add_argument("-k", type=int, default=3)
    query.add_argument("question")

    stats = sub.add_parser("stats", help="static comparison of the chunking strategies")
    stats.add_argument("--db", type=Path, default=DEFAULT_DB)
    stats.add_argument("--markdown", type=Path, help="also write the tables as Markdown to this file")

    args = ap.parse_args(argv)
    try:
        return {"show": cmd_show, "index": cmd_index, "query": cmd_query, "stats": cmd_stats}[args.cmd](args)
    except EmbedError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _sources(args) -> list[Path]:
    root = args.docs.resolve()
    if getattr(args, "files", None):
        return [f.resolve() for f in args.files]
    paths = find_sources(root)
    if not paths:
        print(f"no documents in {root} — drop PDFs there", file=sys.stderr)
    return paths


def _root_for(path: Path, docs: Path) -> Path:
    docs = docs.resolve()
    return docs if path.is_relative_to(docs) else path.parent


def cmd_show(args) -> int:
    paths = _sources(args)
    total_pages = total_chars = 0
    for path in paths:
        doc = extract(path, _root_for(path, args.docs))
        heads = doc.headings
        total_pages += doc.pages
        total_chars += doc.chars
        print(f"{doc.source}")
        print(f"  title     {doc.title}")
        print(f"  pages     {doc.pages}   chars {doc.chars:,}   elements {len(doc.elements)}")
        print(f"  headings  {len(heads)} from {doc.heading_source}")
        if args.headings:
            for h in heads:
                print(f"    p{h.page:<3} {'  ' * (h.level - 1)}{h.text}")
        if args.chunks:
            chunks = CHUNKERS[args.chunks](doc)
            print(f"  chunks    {len(chunks)} ({args.chunks})")
            for c in chunks[: args.limit or None]:
                pages = f"p{c.page_start}" + (f"-{c.page_end}" if c.page_end != c.page_start else "")
                print(f"\n  ── {c.chunk_id}  {pages}  {c.char_len} chars  sections {c.sections_spanned}")
                print(f"     section: {c.section}")
                body = c.text if len(c.text) <= 400 else c.text[:200] + " … " + c.text[-160:]
                print("     " + body.replace("\n", "\n     "))
        print()
    if len(paths) > 1:
        print(f"{len(paths)} documents, {total_pages} pages, {total_chars:,} chars "
              f"(~{total_chars // 3000} pages of plain text at 3000 chars/page)")
    return 0 if paths else 1


def cmd_index(args) -> int:
    paths = _sources(args)
    if not paths:
        return 1
    store = Store(args.db)
    want = {k: str(v) for k, v in INDEX_META.items()}
    have = store.meta()
    if args.rebuild:
        store.clear()
    elif have and {k: have.get(k) for k in want} != want:
        changed = [k for k in want if have.get(k) != want[k]]
        print(f"index was built with different {', '.join(changed)} — run with --rebuild", file=sys.stderr)
        return 1
    embedder = Embedder()

    seen: set[str] = set()
    done = skipped = 0
    for path in paths:
        root = _root_for(path, args.docs)
        source = path.relative_to(root).as_posix()
        seen.add(source)
        doc = extract(path, root)
        if store.document_sha(source) == doc.sha256:
            skipped += 1
            print(f"  = {source}  unchanged")
            continue
        results = {}
        line = f"  + {source}  {doc.pages}p  {len(doc.headings)} headings ({doc.heading_source})"
        for name, chunker in CHUNKERS.items():
            chunks = chunker(doc)
            tokens_before = embedder.tokens
            t0 = time.perf_counter()
            vecs = embedder.documents([c.text for c in chunks])
            seconds = time.perf_counter() - t0
            results[name] = (chunks, vecs, embedder.tokens - tokens_before, seconds)
            line += f"  {name} {len(chunks)} chunks {seconds:.1f}s"
        store.replace_document(doc, results)
        done += 1
        print(line)

    gone = [s for s in store.sources() if s not in seen]
    for source in gone:
        store.delete_document(source)
        print(f"  - {source}  removed")
    store.set_meta({**INDEX_META, "dim": _dim(store)})

    counts = {name: len(store.chunks(name)) for name in CHUNKERS}
    size = args.db.stat().st_size
    print(f"\n{done} indexed, {skipped} unchanged, {len(gone)} removed → {args.db} ({size / 1e6:.1f} MB)")
    print("chunks: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    store.close()
    return 0


def _dim(store: Store) -> int:
    row = store.db.execute("SELECT embedding FROM chunks LIMIT 1").fetchone()
    return len(row["embedding"]) // 4 if row else 0


def cmd_query(args) -> int:
    if not args.db.exists():
        print(f"no index at {args.db} — run: indexer index", file=sys.stderr)
        return 1
    store = Store(args.db)
    vec = Embedder(store.meta().get("model", embed_mod.MODEL)).query(args.question)
    strategies = list(CHUNKERS) if args.strategy == "both" else [args.strategy]
    for name in strategies:
        print(f"── {name}")
        for score, row in store.search(name, vec, args.k):
            pages = f"p{row['page_start']}" + (f"-{row['page_end']}" if row["page_end"] != row["page_start"] else "")
            print(f"  {score:.3f}  {row['chunk_id']}  {pages}  [{row['section']}]")
            snippet = " ".join(row["text"].split())
            print(f"         {snippet[:220]}{'…' if len(snippet) > 220 else ''}")
        print()
    store.close()
    return 0


def cmd_stats(args) -> int:
    if not args.db.exists():
        print(f"no index at {args.db} — run: indexer index", file=sys.stderr)
        return 1
    store = Store(args.db)
    stats = collect(store)
    if not stats:
        print("index is empty", file=sys.stderr)
        return 1
    docs = store.documents()
    print(f"{len(docs)} documents, {sum(d['pages'] for d in docs)} pages, "
          f"{sum(d['chars'] for d in docs):,} chars, model {store.meta().get('model')}\n")
    print(render_terminal(stats))
    if args.markdown:
        _write_tables(args.markdown, render_markdown(stats, store))
        print(f"\nwrote {args.markdown}")
    store.close()
    return 0


STATS_START, STATS_END = "<!-- stats:start -->", "<!-- stats:end -->"


def _write_tables(path: Path, tables: str) -> None:
    """Replace only what sits between the stats markers, keeping the prose around it."""
    block = f"{STATS_START}\n{tables}\n{STATS_END}"
    old = path.read_text() if path.exists() else ""
    if STATS_START in old and STATS_END in old:
        head, rest = old.split(STATS_START, 1)
        tail = rest.split(STATS_END, 1)[1]
        path.write_text(head + block + tail)
    else:
        path.write_text(block + "\n")


if __name__ == "__main__":
    sys.exit(main())
