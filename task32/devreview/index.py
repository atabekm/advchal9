"""Build or update the index: embed new and changed documents, drop removed ones.

The index lives outside the checkout (`~/.cache/devreview/index.db`, or `$DEVREVIEW_DB`), so the
self-hosted runner keeps it between jobs and each job embeds only what `main` changed since.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .chunk import CODE_MAX_CHARS, MAX_CHARS, MIN_CHARS, chunk
from .corpus import GitTree, Tree, collect
from .embed import DOC_PREFIX, Embedder
from .store import Store

DEFAULT_DB = Path(os.environ.get("DEVREVIEW_DB") or Path.home() / ".cache" / "devreview" / "index.db")
LAYOUT = f"{MAX_CHARS}/{MIN_CHARS}/{CODE_MAX_CHARS}/v1"  # chunking settings: a change re-embeds everything


@dataclass
class IndexReport:
    files: int = 0
    added: int = 0
    changed: int = 0
    removed: int = 0
    unchanged: int = 0
    chunks_embedded: int = 0
    seconds: float = 0.0
    ref: str = ""

    def __str__(self) -> str:
        at = f" at {self.ref}" if self.ref else ""
        return (f"{self.files} documents{at}: {self.added} new, {self.changed} changed, {self.removed} removed, "
                f"{self.unchanged} unchanged; {self.chunks_embedded} chunks embedded in {self.seconds:.1f}s")


def build(store: Store, tree: Tree, embedder: Embedder | None = None, full: bool = False,
          progress: Callable[[str], None] = lambda _: None) -> IndexReport:
    embedder = embedder or Embedder()
    meta = store.meta()
    if meta.get("model", embedder.model) != embedder.model or meta.get("layout", LAYOUT) != LAYOUT:
        full = True  # vectors from another model, or other chunk sizes, can't be mixed in
    started = time.monotonic()
    docs = collect(tree)
    known = {} if full else store.file_shas()
    sha = getattr(tree, "sha", "")
    report = IndexReport(files=len(docs), ref=f"{tree.ref} ({sha[:7]})" if tree.ref else "")
    current = {d.source for d in docs}
    for source in set(store.file_shas()) - current:
        store.delete_file(source)
        report.removed += 1
    for doc in docs:
        if known.get(doc.source) == doc.sha256:
            report.unchanged += 1
            continue
        chunks = chunk(doc)
        if not chunks:
            continue
        vecs = embedder.documents([c.embed_text for c in chunks])
        store.replace_file(doc, chunks, vecs)
        report.chunks_embedded += len(chunks)
        if doc.source in known:
            report.changed += 1
        else:
            report.added += 1
        progress(f"{doc.source}: {len(chunks)} chunks")
    report.seconds = time.monotonic() - started
    store.set_meta({"model": embedder.model, "doc_prefix": DOC_PREFIX, "layout": LAYOUT, "root": tree.root,
                    "ref": tree.ref or "(working tree)", "sha": sha,
                    "built_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    return report
