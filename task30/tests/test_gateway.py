import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import Key, Settings, parse_keys
from gateway.limits import RateLimiter
from gateway.ollama import Chunk, OllamaError

KEY = {"Authorization": "Bearer sk-alice"}

class FakeOllama:
    def __init__(self, reply="Hello there", fail=False, hold: asyncio.Event | None = None):
        self.reply, self.fail, self.hold = reply, fail, hold
        self.calls = []

    async def version(self):
        return "0.0-test"

    async def loaded(self):
        return True

    async def chat(self, messages, max_tokens, temperature):
        self.calls.append({"messages": messages, "max_tokens": max_tokens, "temperature": temperature})
        if self.hold:
            await self.hold.wait()
        if self.fail:
            raise OllamaError("boom")
        words = self.reply.split(" ")
        for w in words[:-1]:
            yield Chunk(w + " ")
        yield Chunk(words[-1], True, "stop", 7, len(words))

class WordCounter:
    """One token per word: easy to reason about in tests."""
    def chat(self, messages):
        return sum(len(m["content"].split()) for m in messages)

def make(backend=None, **kw):
    settings = Settings(keys=[Key("alice", "sk-alice", kw.pop("rpm", 100)), Key("bob", "sk-bob", 100)], **kw)
    backend = backend or FakeOllama()
    return create_app(settings, backend, WordCounter(), web_dir=Path("/nonexistent")), backend

def body(text="hi", **kw):
    return {"messages": [{"role": "user", "content": text}], **kw}

def test_parse_keys():
    assert parse_keys("a:k1, b:k2:5", 20) == [Key("a", "k1", 20), Key("b", "k2", 5)]
    with pytest.raises(ValueError):
        parse_keys("nokey", 20)

def test_health_needs_no_key():
    app, _ = make()
    r = TestClient(app).get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.json()["limits"]["max_context"] == 4096

@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "sk-alice"}])
def test_rejects_without_a_valid_key(headers):
    app, backend = make()
    r = TestClient(app).post("/v1/chat/completions", json=body(), headers=headers)
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_api_key"
    assert not backend.calls

def test_completion():
    app, backend = make()
    r = TestClient(app).post("/v1/chat/completions", json=body("say hi", temperature=0.2), headers=KEY)
    assert r.status_code == 200
    d = r.json()
    assert d["choices"][0]["message"] == {"role": "assistant", "content": "Hello there"}
    assert d["usage"] == {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9}
    assert backend.calls[0]["temperature"] == 0.2
    assert r.headers["X-Prompt-Tokens"] == "2"

def test_stream_is_openai_sse():
    app, _ = make()
    r = TestClient(app).post("/v1/chat/completions", json=body(stream=True), headers=KEY)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = [line.removeprefix("data: ") for line in r.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert "".join(c["choices"][0]["delta"].get("content", "") for c in chunks) == "Hello there"
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop" and chunks[-1]["usage"]["total_tokens"] == 9

def test_rate_limit_per_key():
    app, _ = make(rpm=3)
    c = TestClient(app)
    codes = [c.post("/v1/chat/completions", json=body(), headers=KEY).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    r = c.post("/v1/chat/completions", json=body(), headers=KEY)
    assert r.json()["error"]["code"] == "rate_limit_exceeded" and int(r.headers["Retry-After"]) >= 1
    # another key has its own bucket
    assert c.post("/v1/chat/completions", json=body(), headers={"Authorization": "Bearer sk-bob"}).status_code == 200

def test_bucket_refills():
    now = [0.0]
    rl = RateLimiter(clock=lambda: now[0])
    assert [rl.check("k", 2).allowed for _ in range(3)] == [True, True, False]
    assert rl.check("k", 2).retry_after == 30
    now[0] = 30
    assert rl.check("k", 2).allowed

def test_context_limit():
    app, backend = make(max_context=100, max_output=50, min_output=16)
    c = TestClient(app)
    # no max_tokens: the reply gets what's left, capped by max_output
    assert c.post("/v1/chat/completions", json=body("w " * 70), headers=KEY).status_code == 200
    assert backend.calls[-1]["max_tokens"] == 30
    assert c.post("/v1/chat/completions", json=body("w " * 10), headers=KEY).status_code == 200
    assert backend.calls[-1]["max_tokens"] == 50
    # too little room for any reply
    r = c.post("/v1/chat/completions", json=body("w " * 90), headers=KEY)
    assert r.status_code == 413 and r.json()["error"]["code"] == "context_length_exceeded"
    # an explicit max_tokens that doesn't fit
    assert c.post("/v1/chat/completions", json=body("w " * 70, max_tokens=40), headers=KEY).status_code == 413
    assert len(backend.calls) == 2

def test_body_too_large():
    app, _ = make(max_body_bytes=1000)
    r = TestClient(app).post("/v1/chat/completions", json=body("x" * 2000), headers=KEY)
    assert r.status_code == 413 and r.json()["error"]["code"] == "body_too_large"

@pytest.mark.parametrize("payload", [{"messages": []}, {"messages": [{"role": "tool", "content": "x"}]},
                                     {"messages": [{"role": "user", "content": "x"}], "model": "gpt-5"}])
def test_bad_requests(payload):
    app, _ = make()
    assert TestClient(app).post("/v1/chat/completions", json=payload, headers=KEY).status_code == 400

def test_upstream_error_is_502():
    app, _ = make(FakeOllama(fail=True))
    r = TestClient(app).post("/v1/chat/completions", json=body(), headers=KEY)
    assert r.status_code == 502 and r.json()["error"]["code"] == "upstream_error"

@pytest.mark.anyio
async def test_queue_full_is_503_and_slots_come_back():
    hold = asyncio.Event()
    app, backend = make(FakeOllama(hold=hold), max_concurrent=2, max_queue=1)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        post = lambda: c.post("/v1/chat/completions", json=body(), headers=KEY)
        first = [asyncio.create_task(post()) for _ in range(3)]  # 2 running, 1 queued
        await asyncio.sleep(0.05)
        r = await post()
        assert r.status_code == 503 and r.json()["error"]["code"] == "server_busy"
        assert (await c.get("/health")).json()["load"] == {"active": 2, "queued": 1}
        hold.set()
        assert [t.status_code for t in await asyncio.gather(*first)] == [200, 200, 200]
        assert (await c.get("/health")).json()["load"] == {"active": 0, "queued": 0}
        assert (await post()).status_code == 200

@pytest.mark.anyio
async def test_queue_timeout_is_503():
    app, _ = make(FakeOllama(hold=asyncio.Event()), max_concurrent=1, queue_timeout=0.05)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        running = asyncio.create_task(c.post("/v1/chat/completions", json=body(), headers=KEY))
        await asyncio.sleep(0.02)
        r = await c.post("/v1/chat/completions", json=body(), headers=KEY)
        assert r.status_code == 503 and "no free slot" in r.json()["error"]["message"]
        running.cancel()

@pytest.fixture
def anyio_backend():
    return "asyncio"
