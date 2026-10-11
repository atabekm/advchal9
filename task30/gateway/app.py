"""The private chat service: an OpenAI-compatible API over one local model, and a web chat.

  GET  /                      the web chat (static page in web/; it asks for an API key)
  GET  /health                no key: is Ollama up, is the model there, load, limits, counters
  GET  /v1/models             the one model served
  POST /v1/chat/completions   OpenAI's chat format, streamed (SSE) or not

Every /v1 request goes through, in order: the API key (401), the key's rate limit (429), the
request's shape (400), the context limit (413), then a generation slot (503 when the queue is full
or the wait too long). Ollama errors come back as 502. Errors use OpenAI's {"error": {...}} body,
so OpenAI clients show them properly.
"""

from __future__ import annotations

import hmac
import json
import logging
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field, ValidationError

from .config import Key, Settings
from .limits import Gate, QueueFull, QueueTimeout, RateLimiter
from .ollama import Chunk, OllamaError

log = logging.getLogger("gateway")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str

class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[Message] = Field(min_length=1)
    stream: bool = False
    max_tokens: int | None = Field(None, ge=1)
    max_completion_tokens: int | None = Field(None, ge=1)
    temperature: float | None = Field(None, ge=0, le=2)

class Refused(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}

def error(status: int, code: str, message: str, headers: dict | None = None) -> JSONResponse:
    kind = "invalid_request_error" if status < 500 else "server_error"
    return JSONResponse({"error": {"message": message, "type": kind, "code": code}}, status, headers)

def create_app(settings: Settings, backend, counter, web_dir: Path = WEB_DIR) -> FastAPI:
    """`backend` is an `Ollama` (or a test double), `counter` a `TokenCounter`."""
    app = FastAPI(title="private llm", docs_url=None, redoc_url=None)
    limiter = RateLimiter()
    gate = Gate(settings.max_concurrent, settings.max_queue, settings.queue_timeout)
    served = Counter()  # by status code
    tokens = Counter()
    started = time.time()

    def authenticate(request: Request) -> Key:
        header = request.headers.get("authorization", "")
        secret = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""
        for key in settings.keys:
            if secret and hmac.compare_digest(secret.encode(), key.secret.encode()):
                return key
        raise Refused(401, "invalid_api_key", "missing or unknown API key (Authorization: Bearer <key>)")

    def rate_limit(key: Key) -> dict:
        v = limiter.check(key.name, key.rpm)
        headers = {"X-RateLimit-Limit": str(v.limit), "X-RateLimit-Remaining": str(v.remaining)}
        if not v.allowed:
            raise Refused(429, "rate_limit_exceeded",
                          f"rate limit of {v.limit} requests/minute reached for key '{key.name}'; retry in {v.retry_after}s",
                          headers | {"Retry-After": str(v.retry_after)})
        return headers

    def budget(req: ChatRequest, messages: list[dict]) -> tuple[int, int]:
        """The prompt's tokens, and how many the reply may have: the asked-for max_tokens if it
        fits, else what's left of the context (but at least min_output)."""
        prompt = counter.chat(messages)
        asked = req.max_completion_tokens or req.max_tokens
        room = settings.max_context - prompt
        if asked is not None:
            if prompt + asked > settings.max_context:
                raise Refused(413, "context_length_exceeded",
                              f"prompt is {prompt} tokens and max_tokens {asked}: {prompt + asked} is over the "
                              f"{settings.max_context}-token context; shorten the conversation or lower max_tokens")
            return prompt, min(asked, settings.max_output)
        if room < settings.min_output:
            raise Refused(413, "context_length_exceeded",
                          f"prompt is {prompt} tokens; with at least {settings.min_output} for the reply it is over the "
                          f"{settings.max_context}-token context; shorten the conversation")
        return prompt, min(room, settings.max_output)

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        t0 = time.monotonic()
        size = request.headers.get("content-length")
        if size and size.isdigit() and int(size) > settings.max_body_bytes:
            response = error(413, "body_too_large", f"request body over {settings.max_body_bytes} bytes")
        else:
            response = await call_next(request)
        if request.url.path.startswith("/v1/"):
            served[str(response.status_code)] += 1
            log.info("%s %s %d %.2fs", request.method, request.url.path, response.status_code, time.monotonic() - t0)
        return response

    @app.exception_handler(Refused)
    async def refused(_: Request, e: Refused):
        return error(e.status, e.code, e.message, e.headers)

    @app.get("/health")
    async def health():
        version = await backend.version()
        model = await backend.loaded() if version else False
        return JSONResponse({
            "status": "ok" if version and model else "degraded",
            "ollama": version, "model": settings.model, "model_pulled": model,
            "load": {"active": gate.active, "queued": gate.waiting},
            "limits": {"max_context": settings.max_context, "max_output": settings.max_output,
                       "rate_limit_rpm": settings.rate_limit_rpm, "max_concurrent": settings.max_concurrent,
                       "max_queue": settings.max_queue, "queue_timeout": settings.queue_timeout},
            "served": dict(sorted(served.items())),
            "tokens": dict(tokens),
            "uptime": round(time.time() - started),
        }, 200 if version else 503)

    @app.get("/v1/models")
    async def models(request: Request):
        authenticate(request)
        return {"object": "list", "data": [{"id": settings.model, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        key = authenticate(request)
        headers = rate_limit(key)
        try:
            req = ChatRequest.model_validate_json(await request.body())
        except ValidationError as e:
            first = e.errors()[0]
            raise Refused(400, "invalid_request", f"{'.'.join(map(str, first['loc']))}: {first['msg']}", headers) from None
        if req.model and req.model != settings.model:
            raise Refused(400, "model_not_found", f"this service serves '{settings.model}' only", headers)
        messages = [m.model_dump() for m in req.messages]
        try:
            prompt_tokens, max_tokens = budget(req, messages)
        except Refused as e:
            e.headers |= headers
            raise
        rid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        try:
            waited = await gate.acquire()
        except QueueFull:
            raise Refused(503, "server_busy", f"all {settings.max_concurrent} slots busy and {settings.max_queue} "
                          "requests already waiting; retry later", headers | {"Retry-After": "10"}) from None
        except QueueTimeout:
            raise Refused(503, "server_busy", f"no free slot within {settings.queue_timeout:.0f}s; retry later",
                          headers | {"Retry-After": "10"}) from None
        released = False

        def release():
            nonlocal released
            if not released:
                released = True
                gate.release()

        if await request.is_disconnected():  # gave up while queued
            release()
            return error(499, "client_closed", "client went away while queued")
        headers |= {"X-Queue-Wait-Ms": str(round(waited * 1000)), "X-Prompt-Tokens": str(prompt_tokens),
                    "X-Max-Context": str(settings.max_context)}
        log.info("%s key=%s prompt=%d max_tokens=%d waited=%.2fs", rid, key.name, prompt_tokens, max_tokens, waited)
        chunks = backend.chat(messages, max_tokens, req.temperature)

        def account(last: Chunk) -> dict:
            tokens["prompt"] += last.prompt_tokens
            tokens["completion"] += last.completion_tokens
            return {"prompt_tokens": last.prompt_tokens, "completion_tokens": last.completion_tokens,
                    "total_tokens": last.prompt_tokens + last.completion_tokens}

        if not req.stream:
            try:
                parts = []
                async for c in chunks:
                    parts.append(c.text)
                    last = c
            except OllamaError as e:
                return error(502, "upstream_error", str(e), headers)
            finally:
                release()
            return JSONResponse({
                "id": rid, "object": "chat.completion", "created": int(time.time()), "model": settings.model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(parts)},
                             "finish_reason": last.finish_reason}],
                "usage": account(last),
            }, headers=headers)

        async def events():
            def event(delta: dict, finish: str | None = None, **extra) -> str:
                return "data: " + json.dumps({
                    "id": rid, "object": "chat.completion.chunk", "created": int(time.time()), "model": settings.model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}) + "\n\n"

            try:
                yield event({"role": "assistant", "content": ""})
                async for c in chunks:
                    if c.text:
                        yield event({"content": c.text})
                    if c.done:
                        yield event({}, c.finish_reason, usage=account(c))
                yield "data: [DONE]\n\n"
            except OllamaError as e:
                served["stream_error"] += 1
                yield "data: " + json.dumps({"error": {"message": str(e), "type": "server_error", "code": "upstream_error"}}) + "\n\n"
            finally:
                await chunks.aclose()
                release()

        # release() also runs as a background task: a client that leaves before the stream starts
        # never runs events()'s finally
        return StreamingResponse(events(), media_type="text/event-stream", background=BackgroundTask(release),
                                 headers=headers | {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if web_dir.is_dir():
        app.mount("/static", StaticFiles(directory=web_dir), name="static")

        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(web_dir / "index.html")

    return app
