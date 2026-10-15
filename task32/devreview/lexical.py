"""BM25 over the chunks, the keyword half of retrieval.

From task 31. Embeddings miss exact terms, and code is full of them: a hunk that calls
`replace_file` wants the chunk that defines `replace_file`.
"""

from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

TOKEN_RE = re.compile(r"[a-zа-яё0-9_]+", re.I)
STOP = set("a an and are as at be by can do does for from has have how i in is it its of on or "
           "the this to what when where which who why with you your".split())


def tokens(text: str) -> list[str]:
    """Words, lower-cased and singular. An identifier counts whole and by its parts:
    `replace_file` → replace_file, replace, file."""
    out = []
    for word in TOKEN_RE.findall(text.lower()):
        parts = [word] + [p for p in word.split("_") if p] if "_" in word.strip("_") else [word.strip("_")]
        for t in parts:
            if t in STOP or len(t) < 2:
                continue
            out.append(t[:-1] if len(t) > 3 and t.endswith("s") and not t.endswith("ss") else t)  # tasks → task
    return out


class BM25:
    def __init__(self, docs: list[str], k1: float = 1.2, b: float = 0.75):
        self.k1, self.b = k1, b
        self.tf = [Counter(tokens(d)) for d in docs]
        self.len = np.array([sum(tf.values()) for tf in self.tf], dtype=np.float64)
        self.avg = float(self.len.mean()) if len(docs) else 0.0
        df = Counter(t for tf in self.tf for t in tf)
        n = len(docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def scores(self, query: str) -> np.ndarray:
        out = np.zeros(len(self.tf))
        norm = self.k1 * (1 - self.b + self.b * self.len / (self.avg or 1))
        for t in set(tokens(query)):
            idf = self.idf.get(t)
            if idf is None:
                continue
            f = np.array([tf.get(t, 0) for tf in self.tf], dtype=np.float64)
            out += idf * f * (self.k1 + 1) / (f + norm)
        return out
