"""The conversation history in SQLite: sessions, their messages, task memory and its log.

A message is one side of a turn: the user's text, or the assistant's reply with everything that
produced it (the standalone question, the retrieval, sources, quotes) as JSON in `data`. The
web page and the CLI read the same rows, so a session can be resumed from either. The task
memory is one JSON row per session; every edit to it is also appended to `memory_log`.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CHAT_DB = TASK_DIR / "chat" / "chat.db"
TITLE_CHARS = 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created REAL NOT NULL,
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS memory (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    change TEXT NOT NULL,
    created REAL NOT NULL
);
"""


class SessionMissing(KeyError):
    pass


@dataclass
class Session:
    id: str
    title: str
    created: float
    updated: float
    turns: int = 0


@dataclass
class Message:
    turn: int  # 1-based; a user message and its reply share the number
    role: str  # "user" | "assistant"
    text: str
    data: dict = field(default_factory=dict)
    created: float = 0.0


class ChatStore:
    """One connection, shared by the web server's threads behind a lock."""

    def __init__(self, path: Path = DEFAULT_CHAT_DB):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._lock = threading.Lock()

    def create_session(self, title: str = "") -> Session:
        now = time.time()
        s = Session(uuid.uuid4().hex[:12], title.strip()[:TITLE_CHARS] or "new conversation", now, now)
        with self._lock, self._db:
            self._db.execute("INSERT INTO sessions (id, title, created, updated) VALUES (?, ?, ?, ?)",
                             (s.id, s.title, s.created, s.updated))
        return s

    def session(self, session_id: str) -> Session:
        with self._lock:
            row = self._db.execute(
                "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS turns "
                "FROM sessions s WHERE s.id = ?", (session_id,)).fetchone()
        if row is None:
            raise SessionMissing(session_id)
        return Session(row["id"], row["title"], row["created"], row["updated"], row["turns"])

    def sessions(self) -> list[Session]:
        """Most recently used first."""
        with self._lock:
            rows = self._db.execute(
                "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS turns "
                "FROM sessions s ORDER BY s.updated DESC").fetchall()
        return [Session(r["id"], r["title"], r["created"], r["updated"], r["turns"]) for r in rows]

    def delete_session(self, session_id: str) -> None:
        with self._lock, self._db:
            if self._db.execute("DELETE FROM sessions WHERE id = ?", (session_id,)).rowcount == 0:
                raise SessionMissing(session_id)

    def rename(self, session_id: str, title: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE sessions SET title = ? WHERE id = ?", (title.strip()[:TITLE_CHARS], session_id))

    def add_message(self, session_id: str, turn: int, role: str, text: str, data: dict | None = None) -> Message:
        now = time.time()
        with self._lock, self._db:
            self._db.execute("INSERT INTO messages (session_id, turn, role, text, data, created) VALUES (?, ?, ?, ?, ?, ?)",
                             (session_id, turn, role, text, json.dumps(data or {}, ensure_ascii=False), now))
            self._db.execute("UPDATE sessions SET updated = ? WHERE id = ?", (now, session_id))
        return Message(turn, role, text, data or {}, now)

    def save_turn(self, session_id: str, turn: int, user_text: str, reply: str, data: dict,
                  memory: dict | None = None, changes: list[dict] = ()) -> None:
        """A whole turn in one transaction: the message, the reply, and the memory after it."""
        now = time.time()
        with self._lock, self._db:
            self._db.executemany(
                "INSERT INTO messages (session_id, turn, role, text, data, created) VALUES (?, ?, ?, ?, ?, ?)",
                [(session_id, turn, "user", user_text, "{}", now),
                 (session_id, turn, "assistant", reply, json.dumps(data, ensure_ascii=False), now)])
            if memory is not None:
                self._db.execute("INSERT INTO memory (session_id, data, updated) VALUES (?, ?, ?) "
                                 "ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
                                 (session_id, json.dumps(memory, ensure_ascii=False), now))
            self._db.executemany("INSERT INTO memory_log (session_id, turn, change, created) VALUES (?, ?, ?, ?)",
                                 [(session_id, turn, json.dumps(c, ensure_ascii=False), now) for c in changes])
            self._db.execute("UPDATE sessions SET updated = ? WHERE id = ?", (now, session_id))

    def memory(self, session_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT data FROM memory WHERE session_id = ?", (session_id,)).fetchone()
        return None if row is None else json.loads(row["data"])

    def memory_log(self, session_id: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT change FROM memory_log WHERE session_id = ? ORDER BY id",
                                    (session_id,)).fetchall()
        return [json.loads(r["change"]) for r in rows]

    def messages(self, session_id: str, last: int | None = None) -> list[Message]:
        """All messages in order, or only the `last` n."""
        self.session(session_id)
        with self._lock:
            rows = self._db.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY id", (session_id,)).fetchall()
        out = [Message(r["turn"], r["role"], r["text"], json.loads(r["data"]), r["created"]) for r in rows]
        return out[-last:] if last else out

    def close(self) -> None:
        self._db.close()
