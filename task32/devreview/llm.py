"""A minimal client for a model served by Ollama (its native /api/chat), with structured output.

From task 31, without tools and with `format`: a JSON schema the reply is constrained to
(Ollama compiles it to a grammar, so the reply always parses). qwen3's reasoning stays off by
default: at ~23 tokens/s on this Mac it would add a minute or more to every file.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import requests

DEFAULT_MODEL = os.environ.get("DEVREVIEW_MODEL", "qwen3:8b")
NUM_CTX = 16384  # a file's prompt is kept under ~11k tokens, the rest is for the answer
NUM_PREDICT = 2048


class LLMError(RuntimeError):
    pass


@dataclass
class Reply:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0


class LocalLLM:
    def __init__(self, model: str | None = None, base_url: str | None = None, temperature: float = 0.0,
                 timeout: float = 900, num_ctx: int = NUM_CTX, think: bool = False):
        url = (base_url or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        self.base_url = url if "://" in url else f"http://{url}"
        self.model = model or DEFAULT_MODEL
        self.temperature = temperature
        self.timeout = timeout
        self.num_ctx = num_ctx
        self.think = think

    def chat(self, messages: list[dict], schema: dict | None = None) -> Reply:
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": self.think,
            "keep_alive": "30m",
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx, "num_predict": NUM_PREDICT},
        }
        if schema:
            body["format"] = schema
        started = time.monotonic()
        try:
            r = requests.post(f"{self.base_url}/api/chat", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise LLMError(f"ollama unreachable at {self.base_url}: {e} (is `ollama serve` running?)") from e
        if r.status_code != 200:
            raise LLMError(_api_error(r, self.model))
        data = r.json()
        msg = data.get("message", {})
        return Reply(text=(msg.get("content") or "").strip(), prompt_tokens=data.get("prompt_eval_count", 0),
                     completion_tokens=data.get("eval_count", 0), seconds=time.monotonic() - started)


def _api_error(r: requests.Response, model: str) -> str:
    try:
        msg = r.json()["error"]
    except (ValueError, KeyError, TypeError):
        msg = r.text.strip()
    hint = f" (run `ollama pull {model}`)" if r.status_code == 404 else ""
    return f"ollama HTTP {r.status_code}: {str(msg)[:300]}{hint}"
