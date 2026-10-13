"""Build or update the index: embed new and changed documents, drop removed ones."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .chunk import MAX_CHARS, MIN_CHARS, chunk
from .corpus import TASK_DIR, collect, repo_root
from .embed import DOC_PREFIX, Embedder
from .store import Store

DEFAULT_DB = TASK_DIR / "index" / "index.db"


@dataclass
class IndexReport:
    files: int = 0
    added: int = 0
    changed: int = 0
    removed: int = 0
    unchanged: int = 0
    chunks_embedded: int = 0
    seconds: float = 0.0

    def __str__(self) -> str:
        return (f"{self.files} documents: {self.added} new, {self.changed} changed, {self.removed} removed, "
                f"{self.unchanged} unchanged; {self.chunks_embedded} chunks embedded in {self.seconds:.1f}s")


def build(store: Store, root: Path | None = None, embedder: Embedder | None = None, full: bool = False,
          progress: Callable[[str], None] = lambda _: None) -> IndexReport:
    root = root or repo_root()
    embedder = embedder or Embedder()
    meta = store.meta()
    if meta.get("model", embedder.model) != embedder.model or meta.get("max_chars", str(MAX_CHARS)) != str(MAX_CHARS):
        full = True  # vectors from another model, or other chunk sizes, can't be mixed in
    started = time.monotonic()
    docs = collect(root)
    known = {} if full else store.file_shas()
    report = IndexReport(files=len(docs))
    current = {d.source for d in docs}
    for source in set(store.file_shas()) - current:
        store.delete_file(source)
        report.removed += 1
    for doc in docs:
        if known.get(doc.source) == doc.sha256:
            report.unchanged += 1
            continue
        chunks = chunk(doc)
        vecs = embedder.documents([c.embed_text for c in chunks])
        store.replace_file(doc, chunks, vecs)
        report.chunks_embedded += len(chunks)
        if doc.source in known:
            report.changed += 1
        else:
            report.added += 1
        progress(f"{doc.source}: {len(chunks)} chunks")
    report.seconds = time.monotonic() - started
    store.set_meta({"model": embedder.model, "doc_prefix": DOC_PREFIX, "max_chars": MAX_CHARS,
                    "min_chars": MIN_CHARS, "root": root, "built_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    return report
