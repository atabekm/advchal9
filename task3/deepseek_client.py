"""Minimal DeepSeek API client.

DeepSeek exposes an OpenAI-compatible chat-completions endpoint, so the request
and response shapes here match that spec.

Carried over from task2, which added the response-control parameters and the
Reply metrics. Task3 keeps both -- the metrics are what make four reasoning
methods comparable -- and adds `complete()`, one entry point that streams or
buffers depending on whether a chunk callback was given. Four methods times
seven rows is a lot of calls to make twice.
"""

import json
import os
import time
from dataclasses import dataclass

import requests

API_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-chat"
TIMEOUT = 120


class DeepSeekError(Exception):
    """Raised for any failure we can explain to the user in one line."""


def get_api_key():
    key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise DeepSeekError(
            "DEEPSEEK_API_KEY is not set.\n"
            "Copy .env.example to .env and paste your key from "
            "https://platform.deepseek.com/api_keys"
        )
    return key


def _explain(response):
    """Turn an HTTP error response into a readable message."""
    hints = {
        400: "Bad request - the message payload was rejected.",
        401: "Invalid API key. Check DEEPSEEK_API_KEY in your .env.",
        402: "Insufficient balance. Top up at https://platform.deepseek.com/",
        422: "Invalid parameters in the request.",
        429: "Rate limit reached. Wait a moment and try again.",
        500: "DeepSeek server error. Try again shortly.",
        503: "DeepSeek is overloaded. Try again shortly.",
    }
    detail = ""
    try:
        body = response.json()
        detail = body.get("error", {}).get("message", "")
    except ValueError:
        detail = response.text[:200]

    message = hints.get(response.status_code, f"HTTP {response.status_code}")
    return f"{message} {detail}".strip()


@dataclass
class Reply:
    """An answer plus the numbers that show how the request was constrained."""

    text: str
    finish_reason: str      # "stop" = the model ended it, "length" = API cut it off
    completion_tokens: int
    prompt_tokens: int
    elapsed: float

    @property
    def truncated(self):
        return self.finish_reason == "length"


def _post(messages, model, stream, **params):
    """POST a chat completion. `params` carries the response controls."""
    payload = {"model": model, "messages": messages, "stream": stream, **params}
    headers = {
        "Authorization": f"Bearer {get_api_key()}",
        "Content-Type": "application/json",
    }
    try:
        response = requests.post(
            API_URL, headers=headers, json=payload, stream=stream, timeout=TIMEOUT
        )
    except requests.Timeout:
        raise DeepSeekError(f"Request timed out after {TIMEOUT}s.")
    except requests.ConnectionError:
        raise DeepSeekError("Could not reach api.deepseek.com. Check your connection.")

    if not response.ok:
        raise DeepSeekError(_explain(response))
    return response


def ask_full(messages, model=DEFAULT_MODEL, **params):
    """Send messages, return a Reply: the text plus the response metrics."""
    started = time.monotonic()
    response = _post(messages, model, stream=False, **params)
    elapsed = time.monotonic() - started
    try:
        body = response.json()
        choice = body["choices"][0]
        usage = body.get("usage") or {}
        return Reply(
            text=choice["message"]["content"] or "",
            finish_reason=choice.get("finish_reason") or "unknown",
            completion_tokens=usage.get("completion_tokens", 0),
            prompt_tokens=usage.get("prompt_tokens", 0),
            elapsed=elapsed,
        )
    except (KeyError, IndexError, ValueError):
        raise DeepSeekError("Unexpected response shape from DeepSeek.")


def ask(messages, model=DEFAULT_MODEL, **params):
    """Send messages, return the assistant's reply as a string."""
    return ask_full(messages, model, **params).text


class Stream:
    """A streamed reply: iterate it for text chunks, then read `.reply`.

    The metrics arrive in the last chunk, so `.reply` stays None until the
    iteration finishes.
    """

    def __init__(self, response, started):
        self._response = response
        self._started = started
        self.reply = None

    def __iter__(self):
        parts, finish_reason, usage = [], "unknown", {}

        for line in self._response.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            data = line[len("data: "):]
            if data == "[DONE]":
                break
            try:
                event = json.loads(data)
            except ValueError:
                continue

            usage = event.get("usage") or usage
            choices = event.get("choices") or []
            if not choices:
                continue
            finish_reason = choices[0].get("finish_reason") or finish_reason
            chunk = (choices[0].get("delta") or {}).get("content")
            if chunk:
                parts.append(chunk)
                yield chunk

        self.reply = Reply(
            text="".join(parts),
            finish_reason=finish_reason,
            completion_tokens=usage.get("completion_tokens", 0),
            prompt_tokens=usage.get("prompt_tokens", 0),
            elapsed=time.monotonic() - self._started,
        )


def ask_stream(messages, model=DEFAULT_MODEL, **params):
    """Send messages, return a Stream of reply chunks."""
    started = time.monotonic()
    return Stream(_post(messages, model, stream=True, **params), started)

def complete(messages, model=DEFAULT_MODEL, on_chunk=None, **params):
    """One call, streamed or buffered, returning the same Reply either way.

    Pass `on_chunk` to stream: it is invoked with each text fragment as it
    arrives. Omit it and the call is buffered, which is what the parallel
    sweep wants -- eight interleaved streams are unreadable.
    """
    if on_chunk is None:
        return ask_full(messages, model, **params)

    stream = ask_stream(messages, model, **params)
    for chunk in stream:
        on_chunk(chunk)
    return stream.reply
