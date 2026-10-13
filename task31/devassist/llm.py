"""A minimal client for a model served by Ollama (its native /api/chat), with tool calls.

Based on task 27's `LocalLLM`, which only sent one system + one user message. The assistant
needs a running message list (tool calls and their results go back in) and the `tools` field.
qwen3's reasoning stays off: at ~23 tokens/s on this Mac it would add a minute to every answer.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

import requests

DEFAULT_MODEL = "qwen3:8b"
NUM_CTX = 16384  # system + git state + 6 passages + tool results ≈ 5-8k tokens


class LLMError(RuntimeError):
    pass


@dataclass
class ToolCall:
    name: str
    arguments: dict


@dataclass
class Reply:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    message: dict = field(default_factory=dict)  # the assistant message as Ollama returned it


class LocalLLM:
    def __init__(self, model: str = DEFAULT_MODEL, base_url: str | None = None, temperature: float = 0.0,
                 timeout: float = 600, num_ctx: int = NUM_CTX):
        url = (base_url or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        self.base_url = url if "://" in url else f"http://{url}"
        self.model = model
        self.temperature = temperature
        self.timeout = timeout
        self.num_ctx = num_ctx

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> Reply:
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx},
        }
        if tools:
            body["tools"] = tools
        started = time.monotonic()
        try:
            r = requests.post(f"{self.base_url}/api/chat", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise LLMError(f"ollama unreachable at {self.base_url}: {e} (is `ollama serve` running?)") from e
        if r.status_code != 200:
            raise LLMError(_api_error(r, self.model))
        data = r.json()
        msg = data.get("message", {})
        calls = []
        for c in msg.get("tool_calls") or []:
            fn = c.get("function", {})
            args = fn.get("arguments") or {}
            if isinstance(args, str):  # some models send a JSON string
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            calls.append(ToolCall(fn.get("name", ""), args if isinstance(args, dict) else {}))
        return Reply(text=(msg.get("content") or "").strip(), tool_calls=calls,
                     prompt_tokens=data.get("prompt_eval_count", 0), completion_tokens=data.get("eval_count", 0),
                     seconds=time.monotonic() - started, message=msg)


def _api_error(r: requests.Response, model: str) -> str:
    try:
        msg = r.json()["error"]
    except (ValueError, KeyError, TypeError):
        msg = r.text.strip()
    hint = f" (run `ollama pull {model}`)" if r.status_code == 404 else ""
    return f"ollama HTTP {r.status_code}: {str(msg)[:300]}{hint}"
