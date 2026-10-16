"""A minimal client for a model served by Ollama (its native /api/chat). From task 31, without
tool calls: the context is gathered before the model runs.

qwen3's reasoning stays off: at ~23 tokens/s on this Mac it would add a minute to every answer.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import requests

DEFAULT_MODEL = "qwen3:8b"
NUM_CTX = 8192  # system + customer context + 5 passages ≈ 3-4k tokens


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
                 timeout: float = 600, num_ctx: int = NUM_CTX):
        url = (base_url or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        self.base_url = url if "://" in url else f"http://{url}"
        self.model = model or DEFAULT_MODEL
        self.temperature = temperature
        self.timeout = timeout
        self.num_ctx = num_ctx

    def chat(self, messages: list[dict]) -> Reply:
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx},
        }
        started = time.monotonic()
        try:
            r = requests.post(f"{self.base_url}/api/chat", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise LLMError(f"ollama unreachable at {self.base_url}: {e} (is `ollama serve` running?)") from e
        if r.status_code != 200:
            raise LLMError(_api_error(r, self.model))
        data = r.json()
        return Reply(text=(data.get("message", {}).get("content") or "").strip(),
                     prompt_tokens=data.get("prompt_eval_count", 0), completion_tokens=data.get("eval_count", 0),
                     seconds=time.monotonic() - started)


def _api_error(r: requests.Response, model: str) -> str:
    try:
        msg = r.json()["error"]
    except (ValueError, KeyError, TypeError):
        msg = r.text.strip()
    hint = f" (run `ollama pull {model}`)" if r.status_code == 404 else ""
    return f"ollama HTTP {r.status_code}: {str(msg)[:300]}{hint}"
