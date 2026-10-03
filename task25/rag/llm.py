"""A minimal DeepSeek chat/completions client (OpenAI-style API)."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path

import requests

BASE_URL = "https://api.deepseek.com"
MODELS = ("deepseek-flash", "deepseek-v4-pro")
DEFAULT_MODEL = MODELS[0]
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class LLMError(RuntimeError):
    pass


@dataclass
class Reply:
    text: str
    prompt_tokens: int
    completion_tokens: int
    seconds: float


def api_key(env_file: Path = ENV_FILE) -> str:
    """DEEPSEEK_API_KEY from the environment, else from task24/.env."""
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "DEEPSEEK_API_KEY":
                key = value.strip().strip("'\"")
    if not key:
        raise LLMError(f"DEEPSEEK_API_KEY is not set (environment or {env_file})")
    return key


class DeepSeek:
    def __init__(self, model: str = DEFAULT_MODEL, key: str | None = None, base_url: str = BASE_URL,
                 temperature: float = 0.0, timeout: float = 120):
        self.model = model
        self.key = key or api_key()
        self.base_url = base_url.rstrip("/")
        self.temperature = temperature
        self.timeout = timeout

    def chat(self, system: str, user: str, json: bool = False) -> Reply:
        """`json` turns on JSON mode: the reply is one JSON object (the prompt must ask for JSON)."""
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": self.temperature,
        }
        if json:
            body["response_format"] = {"type": "json_object"}
        started = time.monotonic()
        last = ""
        for attempt in range(3):
            try:
                r = requests.post(f"{self.base_url}/chat/completions", json=body, timeout=self.timeout,
                                  headers={"Authorization": f"Bearer {self.key}"})
            except requests.RequestException as e:
                last = f"deepseek unreachable: {e}"
            else:
                if r.status_code == 200:
                    data = r.json()
                    if not data.get("choices"):
                        raise LLMError("deepseek returned no choices")
                    usage = data.get("usage", {})
                    return Reply(text=(data["choices"][0]["message"].get("content") or "").strip(),
                                 prompt_tokens=usage.get("prompt_tokens", 0),
                                 completion_tokens=usage.get("completion_tokens", 0),
                                 seconds=time.monotonic() - started)
                last = _api_error(r)
                if r.status_code not in (429, 500, 502, 503, 504):
                    raise LLMError(last)
            time.sleep(2 * (attempt + 1))
        raise LLMError(f"{last} (after 3 attempts)")


def _api_error(r: requests.Response) -> str:
    try:
        msg = r.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        msg = r.text.strip()
    hint = {401: " (check DEEPSEEK_API_KEY)", 402: " (insufficient balance)", 429: " (rate limited)"}.get(r.status_code, "")
    return f"deepseek HTTP {r.status_code}: {msg[:300]}{hint}"
