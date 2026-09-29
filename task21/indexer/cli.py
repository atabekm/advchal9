"""indexer — build and inspect a local document index.

  indexer show  [--docs DIR] [--headings] [FILE...]   what extraction found
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .extract import extract, find_sources

TASK_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DOCS = TASK_DIR / "docs"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="indexer", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    show = sub.add_parser("show", help="print what extraction found in each document")
    show.add_argument("--docs", type=Path, default=DEFAULT_DOCS)
    show.add_argument("--headings", action="store_true", help="list every heading found")
    show.add_argument("files", nargs="*", type=Path, help="only these files (default: all in --docs)")

    args = ap.parse_args(argv)
    return {"show": cmd_show}[args.cmd](args)


def _sources(args) -> list[Path]:
    root = args.docs.resolve()
    if args.files:
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
        print()
    if len(paths) > 1:
        print(f"{len(paths)} documents, {total_pages} pages, {total_chars:,} chars "
              f"(~{total_chars // 3000} pages of plain text at 3000 chars/page)")
    return 0 if paths else 1


if __name__ == "__main__":
    sys.exit(main())
