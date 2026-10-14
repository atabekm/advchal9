"""Second stage: a cross-encoder reads the question and each passage together and scores relevance.

From task 31 (originally task 27): `BAAI/bge-reranker-base`, loaded from the local Hugging Face
cache. The logit goes through a sigmoid, so a score is 0..1.
"""

from __future__ import annotations

import numpy as np

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
