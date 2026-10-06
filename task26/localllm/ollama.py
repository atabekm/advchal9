"""A minimal client for Ollama's HTTP API (http://localhost:11434 by default)."""

import json
import os
from dataclasses import dataclass, field
from typing import Callable

import requests

HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
if not HOST.startswith("http"):
    HOST = "http://" + HOST


@dataclass
class Reply:
    model: str
    content: str
    thinking: str = ""
    # timings from Ollama's final chunk, converted from nanoseconds to seconds
    load_s: float = 0.0
    prompt_tokens: int = 0
    prompt_s: float = 0.0
    output_tokens: int = 0
    output_s: float = 0.0
    total_s: float = 0.0
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def tokens_per_s(self) -> float:
        return self.output_tokens / self.output_s if self.output_s else 0.0


def version() -> str:
    return _get("/api/version")["version"]


def models() -> list[dict]:
    """Models pulled to disk (`ollama list`)."""
    return _get("/api/tags")["models"]


def running() -> list[dict]:
    """Models currently loaded in memory (`ollama ps`)."""
    return _get("/api/ps")["models"]


def chat(
    model: str,
    messages: list[dict],
    think: bool = False,
    on_token: Callable[[str, str], None] | None = None,
    options: dict | None = None,
) -> Reply:
    """Stream a chat completion. on_token(kind, text) gets each piece, kind is "thinking" or "content"."""
    body = {"model": model, "messages": messages, "think": think, "stream": True}
    if options:
        body["options"] = options
    content, thinking, last = [], [], {}
    with requests.post(f"{HOST}/api/chat", json=body, stream=True, timeout=600) as r:
        _raise(r)
        for line in r.iter_lines():
            if not line:
                continue
            chunk = json.loads(line)
            if "error" in chunk:
                raise RuntimeError(chunk["error"])
            msg = chunk.get("message", {})
            for kind, parts in (("thinking", thinking), ("content", content)):
                if text := msg.get(kind):
                    parts.append(text)
                    if on_token:
                        on_token(kind, text)
            if chunk.get("done"):
                last = chunk
    ns = 1e9
    return Reply(
        model=model,
        content="".join(content),
        thinking="".join(thinking),
        load_s=last.get("load_duration", 0) / ns,
        prompt_tokens=last.get("prompt_eval_count", 0),
        prompt_s=last.get("prompt_eval_duration", 0) / ns,
        output_tokens=last.get("eval_count", 0),
        output_s=last.get("eval_duration", 0) / ns,
        total_s=last.get("total_duration", 0) / ns,
        raw=last,
    )


def _get(path: str) -> dict:
    r = requests.get(HOST + path, timeout=10)
    _raise(r)
    return r.json()


def _raise(r: requests.Response) -> None:
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", r.text)
        except ValueError:
            msg = r.text
        raise RuntimeError(f"Ollama {r.status_code}: {msg}")
