"""The three limits the gateway puts in front of the model.

RateLimiter  per-key token bucket: a full minute's worth of requests, refilled continuously.
Gate         how many generations run at once, and how many may wait for one. A small CPU box
             can't serve more in parallel without every request slowing down, so the rest queue,
             and past the queue they're turned away at once (503) instead of hanging.
TokenCounter counts a chat's prompt tokens the way Ollama will, so a too-long conversation is
             refused up front (413) instead of being silently truncated by Ollama.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("gateway")

@dataclass
class Bucket:
    tokens: float
    stamp: float

@dataclass
class Verdict:
    allowed: bool
    limit: int
    remaining: int
    retry_after: int  # seconds until one request is allowed again (0 when allowed)

class RateLimiter:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.buckets: dict[str, Bucket] = {}

    def check(self, key: str, rpm: int) -> Verdict:
        now = self.clock()
        b = self.buckets.setdefault(key, Bucket(float(rpm), now))
        b.tokens = min(float(rpm), b.tokens + (now - b.stamp) * rpm / 60)
        b.stamp = now
        if b.tokens >= 1:
            b.tokens -= 1
            return Verdict(True, rpm, int(b.tokens), 0)
        return Verdict(False, rpm, 0, math.ceil((1 - b.tokens) * 60 / rpm))

class QueueFull(Exception):
    pass

class QueueTimeout(Exception):
    pass

class Gate:
    def __init__(self, max_concurrent: int, max_queue: int, timeout: float):
        self.max_concurrent = max_concurrent
        self.max_queue = max_queue
        self.timeout = timeout
        self.active = 0
        self.waiting = 0
        self._sem = asyncio.Semaphore(max_concurrent)

    async def acquire(self) -> float:
        """Waits for a slot; returns the seconds spent waiting. Pair with release()."""
        if self._sem.locked() and self.waiting >= self.max_queue:
            raise QueueFull
        started = time.monotonic()
        self.waiting += 1
        try:
            await asyncio.wait_for(self._sem.acquire(), self.timeout)
        except TimeoutError:
            raise QueueTimeout from None
        finally:
            self.waiting -= 1
        self.active += 1
        return time.monotonic() - started

    def release(self) -> None:
        self.active -= 1
        self._sem.release()

TOKENIZER_URL = "https://huggingface.co/Qwen/Qwen3-4B/resolve/main/tokenizer.json"

class TokenCounter:
    def __init__(self, path: str):
        from tokenizers import Tokenizer

        p = Path(path)
        if not p.exists():
            log.info("downloading the qwen3 tokenizer to %s", p)
            p.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(TOKENIZER_URL, p)
        self.tok = Tokenizer.from_file(str(p))

    def chat(self, messages: list[dict]) -> int:
        """qwen3's chat template, as Ollama renders it for qwen3:4b-instruct: matches Ollama's
        prompt_eval_count exactly (checked on short, multi-turn, non-Latin and 1.5k-token chats)."""
        text = "".join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in messages)
        text += "<|im_start|>assistant\n"
        return len(self.tok.encode(text, add_special_tokens=False).ids)
