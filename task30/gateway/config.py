"""Settings, all from environment variables so the same image runs locally and on the VPS.

  API_KEYS          name:key[:rpm],...   who may call the service; rpm overrides RATE_LIMIT_RPM
  OLLAMA_URL        where Ollama listens (never exposed itself; only the gateway talks to it)
  MODEL             the one model this service serves
  MAX_CONTEXT       the context window, in tokens: prompt + reply must fit (also Ollama's num_ctx)
  MAX_OUTPUT        the most tokens one reply may generate
  RATE_LIMIT_RPM    requests per minute per key (a token bucket that holds a minute's worth)
  MAX_CONCURRENT    generations running at once (match OLLAMA_NUM_PARALLEL)
  MAX_QUEUE         requests that may wait for a slot; one more gets 503
  QUEUE_TIMEOUT     seconds a request may wait for a slot before it gets 503
  REQUEST_TIMEOUT   seconds Ollama may take to answer
  MAX_BODY_BYTES    the largest request body accepted
  NUM_THREAD        CPU threads per generation (unset: Ollama's pick, the host's core count; set it
                    when the container gets fewer cores than the host has)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

@dataclass(frozen=True)
class Key:
    name: str
    secret: str
    rpm: int

@dataclass(frozen=True)
class Settings:
    keys: list[Key] = field(default_factory=list)
    ollama_url: str = "http://localhost:11434"
    model: str = "qwen3:4b-instruct"
    max_context: int = 4096
    max_output: int = 1024
    min_output: int = 64
    rate_limit_rpm: int = 20
    max_concurrent: int = 2
    max_queue: int = 6
    queue_timeout: float = 120
    request_timeout: float = 300
    max_body_bytes: int = 256 * 1024
    num_thread: int | None = None
    tokenizer_path: str = os.path.expanduser("~/.cache/llm-gateway/qwen3-tokenizer.json")

def parse_keys(spec: str, default_rpm: int) -> list[Key]:
    keys = []
    for item in filter(None, (s.strip() for s in spec.split(","))):
        parts = item.split(":")
        if len(parts) not in (2, 3) or not all(parts):
            raise ValueError(f"API_KEYS entry {item!r} is not name:key or name:key:rpm")
        rpm = int(parts[2]) if len(parts) == 3 else default_rpm
        keys.append(Key(parts[0], parts[1], rpm))
    return keys

def from_env(env: dict[str, str] = os.environ) -> Settings:
    d = Settings()
    rpm = int(env.get("RATE_LIMIT_RPM", d.rate_limit_rpm))
    keys = parse_keys(env.get("API_KEYS", ""), rpm)
    if not keys:
        raise SystemExit("API_KEYS is empty: a private service needs at least one key (name:key[:rpm])")
    return Settings(
        keys=keys,
        ollama_url=env.get("OLLAMA_URL", d.ollama_url).rstrip("/"),
        model=env.get("MODEL", d.model),
        max_context=int(env.get("MAX_CONTEXT", d.max_context)),
        max_output=int(env.get("MAX_OUTPUT", d.max_output)),
        rate_limit_rpm=rpm,
        max_concurrent=int(env.get("MAX_CONCURRENT", d.max_concurrent)),
        max_queue=int(env.get("MAX_QUEUE", d.max_queue)),
        queue_timeout=float(env.get("QUEUE_TIMEOUT", d.queue_timeout)),
        request_timeout=float(env.get("REQUEST_TIMEOUT", d.request_timeout)),
        max_body_bytes=int(env.get("MAX_BODY_BYTES", d.max_body_bytes)),
        tokenizer_path=env.get("TOKENIZER_PATH", d.tokenizer_path),
        num_thread=int(env["NUM_THREAD"]) if env.get("NUM_THREAD") else None,
    )
