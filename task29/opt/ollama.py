"""Ollama's /api/chat with everything a benchmark needs: options, think, format, and the server's timings.

Ollama reports its durations in nanoseconds: model load, prompt processing (prefill) and
generation. They give speed without client-side noise; time to first token is load + prefill.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import requests

DEFAULT_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")


class OllamaError(RuntimeError):
    pass


@dataclass
class Reply:
    text: str
    thinking: str
    prompt_tokens: int
    completion_tokens: int
    load_s: float
    prompt_s: float
    eval_s: float
    wall_s: float
    done_reason: str  # "stop", or "length" when num_predict cut it off

    @property
    def ttft_s(self) -> float:
        return self.load_s + self.prompt_s

    @property
    def prompt_tps(self) -> float:
        return self.prompt_tokens / self.prompt_s if self.prompt_s else 0.0

    @property
    def eval_tps(self) -> float:
        return self.completion_tokens / self.eval_s if self.eval_s else 0.0


def host_url(host: str) -> str:
    host = host.rstrip("/")
    return host if "://" in host else f"http://{host}"


class Ollama:
    def __init__(self, host: str = DEFAULT_HOST, timeout: float = 900):
        self.host = host_url(host)
        self.timeout = timeout

    def chat(self, model: str, messages: list[dict], options: dict | None = None, think: bool | None = None,
             format: str | dict | None = None, keep_alive: str = "30m") -> Reply:
        """`think=None` leaves the field out: the model's default (qwen3 thinks)."""
        body = {"model": model, "messages": messages, "stream": False, "keep_alive": keep_alive,
                "options": options or {}}
        if think is not None:
            body["think"] = think
        if format is not None:
            body["format"] = format
        started = time.monotonic()
        try:
            r = requests.post(f"{self.host}/api/chat", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise OllamaError(f"ollama unreachable at {self.host}: {e}") from e
        if r.status_code != 200:
            raise OllamaError(f"ollama HTTP {r.status_code}: {r.text.strip()[:300]}")
        d = r.json()
        msg = d.get("message", {})
        return Reply(text=(msg.get("content") or "").strip(), thinking=(msg.get("thinking") or "").strip(),
                     prompt_tokens=d.get("prompt_eval_count", 0), completion_tokens=d.get("eval_count", 0),
                     load_s=d.get("load_duration", 0) / 1e9, prompt_s=d.get("prompt_eval_duration", 0) / 1e9,
                     eval_s=d.get("eval_duration", 0) / 1e9, wall_s=time.monotonic() - started,
                     done_reason=d.get("done_reason", ""))

    def ps(self) -> list[dict]:
        """The loaded models: name, size (bytes in memory), size_vram, context_length."""
        return requests.get(f"{self.host}/api/ps", timeout=10).json().get("models", [])

    def version(self) -> str:
        return requests.get(f"{self.host}/api/version", timeout=10).json().get("version", "?")

    def unload_all(self) -> None:
        """Free the memory, so the next model loads cold and is measured alone."""
        for m in self.ps():
            requests.post(f"{self.host}/api/generate", json={"model": m["name"], "keep_alive": 0}, timeout=60)
        for _ in range(50):
            if not self.ps():
                return
            time.sleep(0.2)

