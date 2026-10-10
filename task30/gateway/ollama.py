"""The gateway's only way to the model: Ollama's native /api/chat, streamed.

The native API (not Ollama's own /v1) because it takes `think: false`. The model is
qwen3:4b-instruct, not qwen3:4b: that tag is the 2507 *Thinking* build, which ignores `think: false`
and reasons in the reply itself (~400 tokens before "Hello!"; minutes on a CPU box).
num_ctx is the same on every request; a request with a different one makes Ollama reload the model.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

class OllamaError(RuntimeError):
    pass

@dataclass
class Chunk:
    text: str
    done: bool = False
    finish_reason: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0

class Ollama:
    def __init__(self, base_url: str, model: str, num_ctx: int, timeout: float):
        self.base_url = base_url
        self.model = model
        self.num_ctx = num_ctx
        self.client = httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(timeout, connect=5))

    async def version(self) -> str | None:
        try:
            r = await self.client.get("/api/version", timeout=3)
            return r.json()["version"]
        except (httpx.HTTPError, ValueError, KeyError):
            return None

    async def loaded(self) -> bool:
        """Is the model pulled? (Not whether it's in memory: the first request loads it.)"""
        try:
            r = await self.client.get("/api/tags", timeout=3)
            return any(m["name"] == self.model or m["model"] == self.model for m in r.json()["models"])
        except (httpx.HTTPError, ValueError, KeyError):
            return False

    async def chat(self, messages: list[dict], max_tokens: int, temperature: float | None) -> AsyncIterator[Chunk]:
        options = {"num_ctx": self.num_ctx, "num_predict": max_tokens}
        if temperature is not None:
            options["temperature"] = temperature
        body = {"model": self.model, "messages": messages, "stream": True, "think": False, "options": options}
        try:
            async with self.client.stream("POST", "/api/chat", json=body) as r:
                if r.status_code != 200:
                    detail = (await r.aread()).decode(errors="replace")[:300]
                    raise OllamaError(f"ollama answered {r.status_code}: {detail}")
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    d = json.loads(line)
                    if "error" in d:
                        raise OllamaError(d["error"])
                    text = d.get("message", {}).get("content", "")
                    if d.get("done"):
                        reason = "length" if d.get("done_reason") == "length" else "stop"
                        yield Chunk(text, True, reason, d.get("prompt_eval_count", 0), d.get("eval_count", 0))
                        return
                    if text:
                        yield Chunk(text)
        except httpx.HTTPError as e:
            raise OllamaError(f"ollama unreachable at {self.base_url}: {e!r}") from e
        raise OllamaError("ollama closed the stream before it was done")
