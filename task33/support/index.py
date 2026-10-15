"""Build or update the index: embed new and changed documents of kb/, drop removed ones."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .embed import DOC_PREFIX, Embedder
from .kb import KB_DIR, MAX_CHARS, MIN_CHARS, TASK_DIR, chunk, collect
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


def build(store: Store, kb_dir: Path = KB_DIR, embedder: Embedder | None = None, full: bool = False,
          progress: Callable[[str], None] = lambda _: None) -> IndexReport:
    embedder = embedder or Embedder()
    meta = store.meta()
    if meta.get("model", embedder.model) != embedder.model or meta.get("max_chars", str(MAX_CHARS)) != str(MAX_CHARS):
        full = True  # vectors from another model, or other chunk sizes, can't be mixed in
    started = time.monotonic()
    docs = collect(kb_dir)
    known = {} if full else store.file_shas()
    report = IndexReport(files=len(docs))
    for source in set(store.file_shas()) - {d.source for d in docs}:
        store.delete_file(source)
        report.removed += 1
    for doc in docs:
        if known.get(doc.source) == doc.sha256:
            report.unchanged += 1
            continue
        chunks = chunk(doc)
        store.replace_file(doc, chunks, embedder.documents([c.embed_text for c in chunks]))
        report.chunks_embedded += len(chunks)
        if doc.source in known:
            report.changed += 1
        else:
            report.added += 1
        progress(f"{doc.source}: {len(chunks)} chunks")
    report.seconds = time.monotonic() - started
    store.set_meta({"model": embedder.model, "doc_prefix": DOC_PREFIX, "max_chars": MAX_CHARS,
                    "min_chars": MIN_CHARS, "built_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    return report
