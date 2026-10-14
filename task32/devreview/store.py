"""The index on disk: one SQLite file.

    files   one row per indexed document (sha256 decides whether to re-embed it)
    chunks  one row per chunk: metadata (kind doc/code, line range) + float32 embedding BLOB
    meta    embedding model, chunk sizes, the commit the index was last built from

Vectors are unit length, so cosine similarity is a dot product.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np

from .chunk import Chunk
from .corpus import Doc

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    source     TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    task       TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    chars      INTEGER NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id  TEXT PRIMARY KEY,
    source    TEXT NOT NULL REFERENCES files(source) ON DELETE CASCADE,
    task      TEXT NOT NULL,
    section   TEXT NOT NULL,
    ordinal   INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end  INTEGER NOT NULL,
    text      TEXT NOT NULL,
    embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_task ON chunks(task, source, ordinal);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        self._matrix: tuple[list[sqlite3.Row], np.ndarray] | None = None

    def close(self) -> None:
        self.db.close()

    def meta(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self.db.execute("SELECT key, value FROM meta")}

    def set_meta(self, values: dict[str, object]) -> None:
        with self.db:
            self.db.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                                [(k, str(v)) for k, v in values.items()])

    def file_shas(self) -> dict[str, str]:
        return {r["source"]: r["sha256"] for r in self.db.execute("SELECT source, sha256 FROM files")}

    def delete_file(self, source: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM files WHERE source = ?", (source,))
        self._matrix = None

    def replace_file(self, doc: Doc, chunks: list[Chunk], vecs: np.ndarray) -> None:
        with self.db:
            self.db.execute("DELETE FROM files WHERE source = ?", (doc.source,))
            self.db.execute("INSERT INTO files(source, kind, task, sha256, chars) VALUES (?, ?, ?, ?, ?)",
                            (doc.source, doc.kind, doc.task, doc.sha256, len(doc.text)))
            self.db.executemany(
                "INSERT INTO chunks(chunk_id, source, task, section, ordinal, kind, line_start, line_end, text, "
                "embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [(c.chunk_id, c.source, c.task, c.section, c.ordinal, c.kind, c.line_start, c.line_end, c.text,
                  v.astype(np.float32).tobytes())
                 for c, v in zip(chunks, vecs, strict=True)])
        self._matrix = None

    def files(self) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT f.*, COUNT(c.chunk_id) AS chunks FROM files f LEFT JOIN chunks c USING (source) "
            "GROUP BY f.source ORDER BY f.source").fetchall()

    def matrix(self) -> tuple[list[sqlite3.Row], np.ndarray]:
        if self._matrix is None:
            rows = self.db.execute("SELECT * FROM chunks ORDER BY source, ordinal").fetchall()
            mat = (np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
                   if rows else np.zeros((0, 0), dtype=np.float32))
            self._matrix = (rows, mat)
        return self._matrix
