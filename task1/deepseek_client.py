"""Minimal DeepSeek API client.

DeepSeek exposes an OpenAI-compatible chat-completions endpoint, so the request
and response shapes here match that spec.
"""

import json
import os

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


def _post(messages, model, stream):
    payload = {"model": model, "messages": messages, "stream": stream}
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


def ask(messages, model=DEFAULT_MODEL):
    """Send messages, return the assistant's reply as a string."""
    response = _post(messages, model, stream=False)
    try:
        return response.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError):
        raise DeepSeekError("Unexpected response shape from DeepSeek.")


def ask_stream(messages, model=DEFAULT_MODEL):
    """Send messages, yield reply chunks as they arrive."""
    response = _post(messages, model, stream=True)
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data = line[len("data: "):]
        if data == "[DONE]":
            break
        try:
            delta = json.loads(data)["choices"][0]["delta"]
        except (KeyError, IndexError, ValueError):
            continue
        chunk = delta.get("content")
        if chunk:
            yield chunk
