"""The index on disk: one SQLite file, both strategies side by side.

    documents   one row per source file (sha256 decides whether to re-index)
    chunks      one row per chunk: metadata columns + float32 embedding BLOB
    embed_runs  how long each document took to embed, per strategy
    meta        model, dimension, prefix, chunking parameters

Vectors are unit length, so cosine similarity is a dot product.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Collection
from pathlib import Path

import numpy as np

from .chunk import Chunk
from .extract import Document

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
    source         TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    pages          INTEGER NOT NULL,
    chars          INTEGER NOT NULL,
    sha256         TEXT NOT NULL,
    heading_source TEXT NOT NULL,
    headings       INTEGER NOT NULL,
    indexed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id         TEXT PRIMARY KEY,
    strategy         TEXT NOT NULL,
    source           TEXT NOT NULL REFERENCES documents(source) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    section          TEXT NOT NULL,
    page_start       INTEGER NOT NULL,
    page_end         INTEGER NOT NULL,
    ordinal          INTEGER NOT NULL,
    char_len         INTEGER NOT NULL,
    sections_spanned INTEGER NOT NULL,
    text             TEXT NOT NULL,
    embedding        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_strategy ON chunks(strategy, source, ordinal);
CREATE TABLE IF NOT EXISTS embed_runs (
    source   TEXT NOT NULL REFERENCES documents(source) ON DELETE CASCADE,
    strategy TEXT NOT NULL,
    chunks   INTEGER NOT NULL,
    tokens   INTEGER NOT NULL,
    seconds  REAL NOT NULL,
    PRIMARY KEY (source, strategy)
);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False)  # the web server searches from worker threads, one turn at a time
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    # --- meta ---

    def meta(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self.db.execute("SELECT key, value FROM meta")}

    def set_meta(self, values: dict[str, object]) -> None:
        with self.db:
            self.db.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                                [(k, str(v)) for k, v in values.items()])

    # --- documents ---

    def document_sha(self, source: str) -> str | None:
        row = self.db.execute("SELECT sha256 FROM documents WHERE source = ?", (source,)).fetchone()
        return row["sha256"] if row else None

    def sources(self) -> list[str]:
        return [r["source"] for r in self.db.execute("SELECT source FROM documents ORDER BY source")]

    def delete_document(self, source: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM documents WHERE source = ?", (source,))

    def replace_document(self, doc: Document, results: dict[str, tuple[list[Chunk], np.ndarray, int, float]]) -> None:
        """Write a document and all its chunks in one transaction.

        results: strategy -> (chunks, embeddings, tokens, seconds)
        """
        with self.db:
            self.db.execute("DELETE FROM documents WHERE source = ?", (doc.source,))
            self.db.execute(
                "INSERT INTO documents(source, title, pages, chars, sha256, heading_source, headings) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (doc.source, doc.title, doc.pages, doc.chars, doc.sha256, doc.heading_source, len(doc.headings)))
            for strategy, (chunks, vecs, tokens, seconds) in results.items():
                self.db.executemany(
                    "INSERT INTO chunks(chunk_id, strategy, source, title, section, page_start, page_end, "
                    "ordinal, char_len, sections_spanned, text, embedding) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(c.chunk_id, c.strategy, c.source, c.title, c.section, c.page_start, c.page_end,
                      c.ordinal, c.char_len, c.sections_spanned, c.text, v.astype(np.float32).tobytes())
                     for c, v in zip(chunks, vecs, strict=True)])
                self.db.execute(
                    "INSERT INTO embed_runs(source, strategy, chunks, tokens, seconds) VALUES (?, ?, ?, ?, ?)",
                    (doc.source, strategy, len(chunks), tokens, seconds))

    def clear(self) -> None:
        with self.db:
            for table in ("embed_runs", "chunks", "documents", "meta"):
                self.db.execute(f"DELETE FROM {table}")
        self.db.execute("VACUUM")

    # --- reading ---

    def chunks(self, strategy: str | None = None) -> list[sqlite3.Row]:
        sql = "SELECT * FROM chunks"
        args: tuple = ()
        if strategy:
            sql += " WHERE strategy = ?"
            args = (strategy,)
        return self.db.execute(sql + " ORDER BY strategy, source, ordinal", args).fetchall()

    def matrix(self, strategy: str) -> tuple[list[sqlite3.Row], np.ndarray]:
        rows = self.chunks(strategy)
        if not rows:
            return rows, np.zeros((0, 0), dtype=np.float32)
        return rows, np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])

    def search(self, strategy: str, query_vec: np.ndarray, k: int = 5,
               sources: Collection[str] = ()) -> list[tuple[float, sqlite3.Row]]:
        """Top k by cosine; `sources`, when given, keeps only chunks of those documents."""
        rows, mat = self.matrix(strategy)
        if not rows:
            return []
        scores = mat @ query_vec
        if sources:
            scores = np.where([r["source"] in sources for r in rows], scores, -np.inf)
        top = [i for i in np.argsort(-scores)[:k] if np.isfinite(scores[i])]
        return [(float(scores[i]), rows[i]) for i in top]

    def documents(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM documents ORDER BY source").fetchall()

    def embed_runs(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM embed_runs ORDER BY source, strategy").fetchall()
