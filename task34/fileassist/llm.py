"""A minimal client for a model served by Ollama (its native /api/chat), with tool calls.

From task 31, plus a fixed seed and an optional thinking switch. Thinking is off by default: the
agent makes 10-25 model calls per goal, and reasoning tokens would multiply the time. gpt-oss always
reasons; `think` is its level then ("low", "medium", "high"), and False means "low".
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

import requests

DEFAULT_MODEL = os.environ.get("FILEASSIST_MODEL", "gpt-oss:20b")
NUM_CTX = 32768  # system + goal + a dozen tool results; old results are trimmed past ~75 % of it
NUM_PREDICT = 4096  # per reply: with thinking on, qwen3:8b can reason for 15+ minutes otherwise


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
    thinking: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    message: dict = field(default_factory=dict)  # the assistant message as Ollama returned it


class LocalLLM:
    def __init__(self, model: str | None = None, base_url: str | None = None, temperature: float = 0.0,
                 seed: int = 7, think: bool | str = False, timeout: float = 900, num_ctx: int = NUM_CTX):
        url = (base_url or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        self.base_url = url if "://" in url else f"http://{url}"
        self.model = model or DEFAULT_MODEL
        self.temperature = temperature
        self.seed = seed
        if self.model.startswith("gpt-oss"):
            think = think if isinstance(think, str) else ("medium" if think else "low")
        self.think = think
        self.timeout = timeout
        self.num_ctx = num_ctx

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> Reply:
        body = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": self.think,
            "keep_alive": "30m",
            "options": {"temperature": self.temperature, "seed": self.seed, "num_ctx": self.num_ctx,
                        "num_predict": NUM_PREDICT},
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
                     thinking=(msg.get("thinking") or "").strip(),
                     prompt_tokens=data.get("prompt_eval_count", 0), completion_tokens=data.get("eval_count", 0),
                     seconds=time.monotonic() - started, message=msg)

    def version(self) -> str:
        """Parameter size and quantization, for transcripts: "8.2B Q4_K_M"."""
        try:
            r = requests.post(f"{self.base_url}/api/show", json={"model": self.model}, timeout=10)
            details = r.json().get("details", {})
            return f"{details.get('parameter_size', '?')} {details.get('quantization_level', '?')}"
        except (requests.RequestException, ValueError):
            return "?"


def ollama_specs(tools: list) -> list[dict]:
    """MCP tools in Ollama's /api/chat format (OpenAI-style function definitions)."""
    out = []
    for t in tools:
        schema = dict(getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {})
        props = {k: {kk: vv for kk, vv in v.items() if kk != "title" and not (kk == "default" and vv is None)}
                 for k, v in schema.get("properties", {}).items()}
        for v in props.values():  # `str | None` arrives as anyOf; a small model reads a plain type better
            if "anyOf" in v:
                types = [a.get("type") for a in v.pop("anyOf") if a.get("type") != "null"]
                v["type"] = types[0] if types else "string"
        out.append({"type": "function", "function": {
            "name": t.name, "description": t.description or "",
            "parameters": {"type": "object", "properties": props, "required": schema.get("required", [])}}})
    return out


def _api_error(r: requests.Response, model: str) -> str:
    try:
        msg = r.json()["error"]
    except (ValueError, KeyError, TypeError):
        msg = r.text.strip()
    hint = f" (run `ollama pull {model}`)" if r.status_code == 404 else ""
    return f"ollama HTTP {r.status_code}: {str(msg)[:300]}{hint}"
