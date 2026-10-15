"""Test doubles and a throwaway git repository, shared by the test modules."""

import subprocess
from pathlib import Path

import numpy as np

from devreview.lexical import tokens


class FakeEmbedder:
    """Bag-of-words vectors over a fixed vocabulary: deterministic, no Ollama needed."""
    model = "fake"
    VOCAB = ["queue", "gateway", "branch", "test", "schema", "ollama", "readme", "rerank", "store", "save"]

    def __init__(self):
        self.calls = 0

    def _vec(self, text):
        v = np.array([text.lower().count(w) for w in self.VOCAB], dtype=np.float32) + 0.01
        return v / np.linalg.norm(v)

    def documents(self, texts):
        self.calls += len(texts)
        return np.vstack([self._vec(t) for t in texts])

    def query(self, text):
        return self._vec(text)


class FakeReranker:
    def scores(self, question, texts):
        q = set(tokens(question))
        return [len(q & set(tokens(t))) / (len(q) or 1) for t in texts]


def git(root: Path, *args) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def init_repo(root: Path) -> Path:
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "T")
    return root


def commit(root: Path, message: str = "c") -> str:
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", message)
    return git(root, "rev-parse", "HEAD").strip()
