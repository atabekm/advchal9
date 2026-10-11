"""`uv run check`: verify a running service from the outside, over the network, like any client.

  check limits --url URL --key KEY --demo-key KEY   network access, then each limit: 401, 413, 429, 503
  check load   --url URL --key KEY [--levels 1,2,4,8,12] [--rounds 2] [--max-tokens 128]
               N clients at once, each sending `rounds` streamed chats back to back: latency,
               time to first token, throughput, and what got turned away

--demo-key is a key with a low rate limit (the .env.example's `demo`, 3/min); --key needs room for
the load (give it a high rpm, e.g. `load:sk-...:1000`). Results go to results/<check>-<time>.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from datetime import datetime
from pathlib import Path

import httpx

RESULTS = Path(__file__).resolve().parent.parent / "results"
QUESTIONS = [
    "Explain what a reverse proxy does, in three sentences.",
    "Give me three tips for writing clear commit messages.",
    "What is the difference between a process and a thread?",
    "Write a haiku about a server running at night.",
    "How does a token bucket rate limiter work?",
    "Name three uses of a hash map, briefly.",
    "Why do databases use indexes? Keep it short.",
    "Summarize what HTTP status 429 means and how a client should react.",
]

def auth(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"}

def chat_body(text: str, **kw) -> dict:
    return {"messages": [{"role": "user", "content": text}], **kw}

def save(name: str, data: dict) -> Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"{name}-{datetime.now():%Y%m%dT%H%M%S}.json"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return path

# ------------------------------------------------------------------ limits

async def limits(url: str, key: str, demo_key: str) -> dict:
    out = {"url": url, "checks": []}

    def record(name: str, expect, got, detail: str = "") -> None:
        ok = got in expect if isinstance(expect, (list, tuple, set)) else got == expect
        out["checks"].append({"check": name, "expected": expect, "got": got, "ok": ok, "detail": detail})
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<44} expected {expect}, got {got}  {detail}")

    async with httpx.AsyncClient(base_url=url, timeout=300) as c:
        print(f"service at {url}")
        t0 = time.monotonic()
        h = (await c.get("/health")).json()
        out["health"] = h
        lim = h["limits"]
        record("network: /health reachable", "ok", h["status"], f"{(time.monotonic() - t0) * 1000:.0f} ms, "
               f"{h['model']} on Ollama {h['ollama']}")

        r = await c.post("/v1/chat/completions", json=chat_body("hi"))
        record("no API key", 401, r.status_code)
        r = await c.post("/v1/chat/completions", json=chat_body("hi"), headers=auth("sk-wrong"))
        record("wrong API key", 401, r.status_code)

        t0 = time.monotonic()
        r = await c.post("/v1/chat/completions", json=chat_body("Reply with one word: ready?", max_tokens=16),
                         headers=auth(key))
        reply = r.json()["choices"][0]["message"]["content"].strip() if r.status_code == 200 else r.text[:100]
        record("chat with a valid key", 200, r.status_code, f"{time.monotonic() - t0:.1f}s: {reply!r}")

        r = await c.post("/v1/chat/completions", json=chat_body("word " * lim["max_context"]), headers=auth(key))
        record(f"prompt over the {lim['max_context']}-token context", 413, r.status_code,
               r.json()["error"]["message"][:90] if r.status_code == 413 else "")
        r = await c.post("/v1/chat/completions", headers=auth(key),
                         json=chat_body("hi", max_tokens=lim["max_context"]))
        record("max_tokens = the whole context", 413, r.status_code)

        # the demo key's bucket: a minute's worth of requests, then 429 with Retry-After
        codes, retry = [], None
        for _ in range(6):
            r = await c.post("/v1/chat/completions", json=chat_body("hi", max_tokens=1), headers=auth(demo_key))
            codes.append(r.status_code)
            retry = r.headers.get("Retry-After", retry)
        rpm = int(r.headers.get("X-RateLimit-Limit", 0))
        record(f"6 quick requests on a {rpm}/min key", 429, codes[-1], f"codes {codes}, Retry-After {retry}s")

        # more requests at once than slots + queue: the overflow is turned away at once
        n = lim["max_concurrent"] + lim["max_queue"] + 4
        t0 = time.monotonic()

        async def one(i: int):
            r = await c.post("/v1/chat/completions", headers=auth(key),
                             json=chat_body(QUESTIONS[i % len(QUESTIONS)], max_tokens=24))
            why = r.json()["error"]["message"] if r.status_code != 200 else ""
            return r.status_code, time.monotonic() - t0, why

        results = await asyncio.gather(*(one(i) for i in range(n)))
        full = [t for s, t, why in results if s == 503 and "already waiting" in why]
        timed_out = [t for s, t, why in results if s == 503 and "no free slot" in why]
        codes = sorted(s for s, _, _ in results)
        record(f"{n} at once ({lim['max_concurrent']} slots + {lim['max_queue']} queue)", 503,
               503 if full else codes[-1],
               f"{codes.count(200)}×200; 503: {len(full)} queue full (in {max(full, default=0):.2f}s), "
               f"{len(timed_out)} waited past the {lim['queue_timeout']:.0f}s queue timeout; "
               f"all done in {time.monotonic() - t0:.0f}s")
        h = (await c.get("/health")).json()
        record("slots free again afterwards", {"active": 0, "queued": 0}, h["load"])
        out["health_after"] = h

    passed = sum(c["ok"] for c in out["checks"])
    print(f"{passed}/{len(out['checks'])} passed")
    return out

# -------------------------------------------------------------------- load

async def stream_chat(c: httpx.AsyncClient, key: str, text: str, max_tokens: int) -> dict:
    t0 = time.monotonic()
    rec = {"status": None, "ttft": None, "latency": None, "tokens": 0, "queue_wait": None}
    try:
        async with c.stream("POST", "/v1/chat/completions", headers=auth(key),
                            json=chat_body(text, max_tokens=max_tokens, stream=True)) as r:
            rec["status"] = r.status_code
            if r.status_code != 200:
                await r.aread()
                rec["latency"] = time.monotonic() - t0
                return rec
            rec["queue_wait"] = int(r.headers.get("X-Queue-Wait-Ms", 0)) / 1000
            async for line in r.aiter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                ev = json.loads(line[6:])
                if "error" in ev:
                    rec["status"] = "stream_error"
                    break
                if ev["choices"][0]["delta"].get("content") and rec["ttft"] is None:
                    rec["ttft"] = time.monotonic() - t0
                if "usage" in ev:
                    rec["tokens"] = ev["usage"]["completion_tokens"]
    except httpx.HTTPError as e:
        rec["status"] = f"error: {type(e).__name__}"
    rec["latency"] = time.monotonic() - t0
    return rec

def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 2)

async def load(url: str, key: str, levels: list[int], rounds: int, max_tokens: int) -> dict:
    out = {"url": url, "rounds": rounds, "max_tokens": max_tokens, "levels": []}
    async with httpx.AsyncClient(base_url=url, timeout=600) as c:
        h = (await c.get("/health")).json()
        out["health"] = h
        print(f"{h['model']} at {url}: {h['limits']['max_concurrent']} slots, queue {h['limits']['max_queue']}, "
              f"queue timeout {h['limits']['queue_timeout']:.0f}s; {rounds} chats per client, max_tokens {max_tokens}")
        print(f"{'clients':>7} {'ok':>6} {'429':>4} {'503':>4} {'other':>5} {'p50 s':>7} {'p95 s':>7} "
              f"{'ttft p50':>8} {'queue p50':>9} {'tok/s':>6} {'wall s':>6}")
        for n in levels:
            t0 = time.monotonic()

            async def client(i: int):
                recs = []
                for r in range(rounds):
                    recs.append(await stream_chat(c, key, QUESTIONS[(i + r) % len(QUESTIONS)], max_tokens))
                return recs

            recs = [rec for rs in await asyncio.gather(*(client(i) for i in range(n))) for rec in rs]
            wall = time.monotonic() - t0
            ok = [r for r in recs if r["status"] == 200]
            row = {
                "clients": n, "requests": len(recs), "ok": len(ok),
                "rate_limited": sum(r["status"] == 429 for r in recs),
                "busy": sum(r["status"] == 503 for r in recs),
                "other": sum(r["status"] not in (200, 429, 503) for r in recs),
                "latency_p50": pct([r["latency"] for r in ok], 50), "latency_p95": pct([r["latency"] for r in ok], 95),
                "ttft_p50": pct([r["ttft"] for r in ok if r["ttft"]], 50),
                "queue_wait_p50": pct([r["queue_wait"] for r in ok], 50),
                "tokens": sum(r["tokens"] for r in ok),
                "throughput_tok_s": round(sum(r["tokens"] for r in ok) / wall, 1),
                "wall_s": round(wall, 1), "raw": recs,
            }
            out["levels"].append(row)
            print(f"{n:>7} {row['ok']:>3}/{len(recs):<2} {row['rate_limited']:>4} {row['busy']:>4} {row['other']:>5} "
                  f"{row['latency_p50']!s:>7} {row['latency_p95']!s:>7} {row['ttft_p50']!s:>8} "
                  f"{row['queue_wait_p50']!s:>9} {row['throughput_tok_s']:>6} {row['wall_s']:>6}")
        out["health_after"] = (await c.get("/health")).json()
        print(f"after: {out['health_after']['load']}, served {out['health_after']['served']}")
    return out

def main() -> None:
    p = argparse.ArgumentParser(prog="check", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("limits", "load"):
        s = sub.add_parser(name)
        s.add_argument("--url", default="http://localhost:8030")
        s.add_argument("--key", required=True)
        if name == "limits":
            s.add_argument("--demo-key", required=True)
        else:
            s.add_argument("--levels", default="1,2,4,8,12")
            s.add_argument("--rounds", type=int, default=2)
            s.add_argument("--max-tokens", type=int, default=128)
    a = p.parse_args()
    url = a.url.rstrip("/")
    if a.cmd == "limits":
        data = asyncio.run(limits(url, a.key, a.demo_key))
    else:
        data = asyncio.run(load(url, a.key, [int(x) for x in a.levels.split(",")], a.rounds, a.max_tokens))
    print(f"saved {save(a.cmd, data)}")
