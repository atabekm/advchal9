"""Second stage: a cross-encoder reads the question and each chunk together and scores relevance.

Cosine similarity compares two vectors made separately; the cross-encoder sees both texts at
once, so it can tell "about the same topic" from "answers the question". Its logit goes
through a sigmoid, so the score is 0..1 and one threshold means the same for every question.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from .hits import Hit

DEFAULT_MODEL = "BAAI/bge-reranker-base"


class Reranker:
    def __init__(self, model: str = DEFAULT_MODEL, encoder=None):
        """`encoder` is anything with `predict(pairs) -> logits`; loaded lazily when not given."""
        self.model = model
        self._encoder = encoder

    @property
    def encoder(self):
        if self._encoder is None:
            import torch
            from sentence_transformers import CrossEncoder
            from transformers.utils import logging

            logging.disable_progress_bar()
            try:  # the cached copy, without asking the Hub (works offline)
                self._encoder = CrossEncoder(self.model, activation_fn=torch.nn.Identity(), local_files_only=True)
            except OSError:  # first run: download it once
                self._encoder = CrossEncoder(self.model, activation_fn=torch.nn.Identity())
        return self._encoder

    def scores(self, question: str, texts: list[str]) -> list[float]:
        if not texts:
            return []
        logits = np.asarray(self.encoder.predict([(question, t) for t in texts], show_progress_bar=False),
                            dtype=np.float64)
        return (1 / (1 + np.exp(-logits))).tolist()

    def rerank(self, queries: str | list[str], hits: list[Hit]) -> list[Hit]:
        """The hits ordered by cross-encoder score, renumbered from 1; the cosine rank is kept.

        With several queries (the question and its rewrites) a chunk scores its best over them:
        a multi-part question's rewrite "Apertium … Tatar" is what makes an Apertium chunk
        relevant, and the question as a whole scores it near 0."""
        queries = [queries] if isinstance(queries, str) else queries
        texts = [h.text for h in hits]
        best = [max(col) for col in zip(*(self.scores(q, texts) for q in queries))] if texts else []
        scored = sorted(zip(best, hits), key=lambda p: -p[0])
        return [replace(h, rank=i, cosine_rank=h.cosine_rank or h.rank, rerank=s)
                for i, (s, h) in enumerate(scored, start=1)]
