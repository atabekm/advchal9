"""Embeddings from a local Ollama server (`nomic-embed-text`, 768-dim).

nomic-embed-text is trained with task prefixes: documents are embedded as
"search_document: ...", queries as "search_query: ...". Leaving them out
measurably hurts retrieval, so the prefix is part of the index metadata.
"""

from __future__ import annotations

import os
import time

import numpy as np
import requests

MODEL = "nomic-embed-text"
DOC_PREFIX = "search_document: "
QUERY_PREFIX = "search_query: "
BATCH = 32


class EmbedError(RuntimeError):
    pass


class Embedder:
    def __init__(self, model: str = MODEL, host: str | None = None, batch: int = BATCH):
        self.model = model
        self.host = (host or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        if not self.host.startswith("http"):
            self.host = "http://" + self.host
        self.batch = batch
        self.tokens = 0  # prompt tokens embedded so far, as Ollama counts them

    def documents(self, texts: list[str]) -> np.ndarray:
        return self._embed([DOC_PREFIX + t for t in texts])

    def query(self, text: str) -> np.ndarray:
        return self._embed([QUERY_PREFIX + text])[0]

    def _embed(self, inputs: list[str]) -> np.ndarray:
        out = []
        for i in range(0, len(inputs), self.batch):
            out.extend(self._call(inputs[i : i + self.batch]))
        vecs = np.asarray(out, dtype=np.float32).reshape(len(inputs), -1)
        # Ollama already returns unit vectors; normalise anyway so dot == cosine.
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        return vecs / np.where(norms == 0, 1, norms)

    def _call(self, batch: list[str]) -> list[list[float]]:
        last: Exception | None = None
        for attempt in range(3):
            try:
                r = requests.post(f"{self.host}/api/embed",
                                  json={"model": self.model, "input": batch, "truncate": True}, timeout=120)
                if r.status_code == 404:
                    raise EmbedError(f"model {self.model!r} not found — run: ollama pull {self.model}")
                r.raise_for_status()
                data = r.json()
                self.tokens += data.get("prompt_eval_count", 0)
                return data["embeddings"]
            except EmbedError:
                raise
            except requests.ConnectionError as e:
                raise EmbedError(f"cannot reach Ollama at {self.host} — is `ollama serve` running?") from e
            except (requests.RequestException, KeyError, ValueError) as e:
                last = e
                time.sleep(1 + attempt)
        raise EmbedError(f"embedding failed after 3 attempts: {last}")
