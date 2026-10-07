"""A minimal client for a local model served by Ollama (its native /api/chat).

Everything the chat needs from an LLM (condensing, rewriting, answers, memory edits, judging)
goes through `LocalLLM.chat`, so nothing leaves the machine. qwen3's reasoning is turned off:
these are short, structured calls, and thinking would cost minutes per turn at ~23 tokens/s.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

import requests

BASE_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_MODEL = "qwen3:8b"
NUM_CTX = 16384  # a turn's longest prompt is ~5k tokens; Ollama's default may silently truncate it


class LLMError(RuntimeError):
    pass


@dataclass
class Reply:
    text: str
    prompt_tokens: int
    completion_tokens: int
    seconds: float


def _base_url(url: str) -> str:
    url = url.rstrip("/")
    return url if "://" in url else f"http://{url}"


class LocalLLM:
    def __init__(self, model: str = DEFAULT_MODEL, base_url: str = BASE_URL, temperature: float = 0.0,
                 timeout: float = 600, num_ctx: int = NUM_CTX):
        self.model = model
        self.base_url = _base_url(base_url)
        self.temperature = temperature
        self.timeout = timeout
        self.num_ctx = num_ctx

    def chat(self, system: str, user: str, json: bool = False) -> Reply:
        """`json` makes Ollama constrain the output to one JSON object (the prompt must ask for JSON)."""
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx},
        }
        if json:
            body["format"] = "json"
        started = time.monotonic()
        try:
            r = requests.post(f"{self.base_url}/api/chat", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise LLMError(f"ollama unreachable at {self.base_url}: {e} (is `ollama serve` running?)") from e
        if r.status_code != 200:
            raise LLMError(_api_error(r, self.model))
        data = r.json()
        return Reply(text=(data.get("message", {}).get("content") or "").strip(),
                     prompt_tokens=data.get("prompt_eval_count", 0),
                     completion_tokens=data.get("eval_count", 0),
                     seconds=time.monotonic() - started)

    def status(self) -> dict:
        """The server version and whether the model is pulled; raises LLMError when unreachable."""
        try:
            version = requests.get(f"{self.base_url}/api/version", timeout=5).json().get("version", "?")
            names = [m["name"] for m in requests.get(f"{self.base_url}/api/tags", timeout=5).json().get("models", [])]
        except requests.RequestException as e:
            raise LLMError(f"ollama unreachable at {self.base_url}: {e} (is `ollama serve` running?)") from e
        return {"version": version, "model": self.model, "pulled": self.model in names}


def _api_error(r: requests.Response, model: str) -> str:
    try:
        msg = r.json()["error"]
    except (ValueError, KeyError, TypeError):
        msg = r.text.strip()
    hint = f" (run `ollama pull {model}`)" if r.status_code == 404 else ""
    return f"ollama HTTP {r.status_code}: {str(msg)[:300]}{hint}"
