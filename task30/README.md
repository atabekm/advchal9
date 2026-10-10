# Task 30: a local LLM as a private service

`qwen3:4b-instruct` in Ollama, behind a small gateway that is the only thing on the network. The
gateway serves an **OpenAI-compatible HTTP API** and a **web chat**, and puts the limits a shared
CPU box needs in front of the model: API keys, a per-key rate limit, a context limit counted with
the model's own tokenizer, and a bounded queue in front of a fixed number of generation slots.
Everything runs with `docker compose`, and `deploy/deploy.sh user@host` puts it on a VPS.

```
 browser / curl / OpenAI SDK ──HTTP──▶ gateway :8030 ──compose network──▶ ollama :11434 (not published)
                                        401 no/unknown key
                                        429 over the key's requests/minute (Retry-After)
                                        400 malformed request, other model
                                        413 prompt + reply over the context window
                                        503 all slots busy and the queue full, or queued too long
                                        502 Ollama failed
```

## Result

Measured over the network (the Mac's LAN IP, not localhost) against the compose stack with
Ollama pinned to **4 CPU cores and 7 GB**, i.e. what a small CPU-only VPS gives. All numbers
below are in [`results/`](results).

**Limits** ([`check limits`](checks/cli.py)): 9/9 passed.

| check | expected | got |
|---|---|---|
| `/health` over the network | ok | ok, 34 ms |
| no API key / wrong key | 401 | 401 / 401 |
| chat with a valid key | 200 | 200 in 0.9 s |
| prompt over the 4096-token context | 413 | 413: "prompt is 4105 tokens; with at least 64 for the reply it is over the 4096-token context" |
| `max_tokens` = the whole context | 413 | 413 |
| 6 quick requests on a 3/min key | 429 | `200 200 200 429 429 429`, Retry-After 20 s |
| 12 at once (2 slots + 6 queue) | 503 | 8×200, 4×503 turned away in 0.03 s |
| slots free afterwards | 0 active, 0 queued | 0, 0 |

**Stability** ([`check load`](checks/cli.py)): N clients at once, each sending 2 streamed chats
back to back (`max_tokens` 128), 2 generation slots, queue of 6, 120 s queue timeout.

| clients | ok | 503 | latency p50 / p95 | first token p50 | queue wait p50 | throughput |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2/2 | 0 | 8.7 / 18.3 s | 0.2 s | 0 s | 7.0 tok/s |
| 2 | 4/4 | 0 | 36.0 / 36.9 s | 1.2 s | 0 s | 7.0 tok/s |
| 4 | 8/8 | 0 | 53.6 / 71.9 s | 26.2 s | 25.0 s | 7.1 tok/s |
| 8 | 16/16 | 0 | 93.9 / 120.8 s | 79.7 s | 79.2 s | 7.0 tok/s |
| 12 | 16/24 | 8 | 94.6 / 125.3 s | 79.3 s | 78.9 s | 7.0 tok/s |

No request failed, nothing timed out, and the slots were all free afterwards. Throughput is flat
at 7 tok/s: the box is saturated from the first client, and more load becomes queue wait, then,
past the queue, an immediate 503 instead of a hang. 12 clients is more than slots + queue (8), so a
third of their requests were turned away, and the rest were served as fast as with 8 clients.

## What the measurements changed

- **`qwen3:4b` is the wrong tag for a chat.** It's the 2507 *Thinking* build: it ignores
  `think: false` and reasons in the reply ("Okay, user wants me to say hello in exactly 5
  words. Hmm…", 388 tokens before the answer). `qwen3:4b-instruct` answers "Hello! 😊✨" in 6.
  (Task 29 didn't notice: there the output was constrained to a JSON schema.)
- **Ollama in a container uses the host's core count.** With `cpus: 4` (a quota) llama.cpp still
  started 10 threads and crawled at 3.6 tok/s, so the first load run had p50 latencies of 75 s
  and 503s from 4 clients on. Pinning cores (`cpuset`) and passing `num_thread: 4` with every
  request brought it to 7 tok/s. On a real VPS the host's cores *are* its vCPUs, so neither is
  needed there ([`compose.vps-sim.yaml`](compose.vps-sim.yaml) is the local-only override).
- **The queue is sized from the reply time.** A 128-token reply takes ~18 s here. With the first
  guess of 8 queued and a 60 s queue timeout, the tail of the queue was bound to time out after
  waiting for nothing. Now it's 6 queued and 120 s: a queued request gets served, and the
  overflow is told at once.
- **Two slots don't add throughput on a CPU, they split it** (7.0 tok/s either way; with one
  slot, [`load-1slot`](results): 6.6–6.7 tok/s). They do make the first token come sooner, 1.2 s
  instead of 19 s at 2 clients, because nobody waits for a whole reply before theirs starts.
  For a chat that's the better trade, so the default is 2.
- **The context limit is exact.** The gateway counts the prompt with qwen3's own tokenizer and
  chat template; it matched Ollama's `prompt_eval_count` exactly on short, multi-turn, Cyrillic +
  emoji and 1.5k-token chats. So a conversation that doesn't fit is refused with its size,
  instead of Ollama silently cutting off its beginning.

## Run it

```bash
cp .env.example .env            # put your own keys in API_KEYS
docker compose up -d --build    # pulls the model on first start (~2.5 GB), then serves :8030
open http://localhost:8030      # the web chat; sign in with a key from .env
```

Locally, to behave like a 4-vCPU VPS: `docker compose -f compose.yaml -f compose.vps-sim.yaml up -d --build`.
Without Docker: `ollama pull qwen3:4b-instruct && API_KEYS=me:sk-local uv run serve`.

### On a VPS

```bash
deploy/deploy.sh root@203.0.113.7
```

On a fresh Ubuntu/Debian box this installs Docker, allows SSH and the service port in `ufw`,
creates `.env` with three random keys (`me`, `demo` at 3/min, `load` at 1000/min) and prints them
once, and starts the stack. Running it again copies the code and rebuilds; `.env` and the pulled
model stay. 4 vCPU / 8 GB is enough: the model with two 4k-token slots takes 4.2 GB.

It's plain HTTP on `IP:8030`, so the API key travels unencrypted. For anything beyond a demo, put
Caddy in front with a domain (automatic HTTPS) or reach it over a VPN such as Tailscale.

## Use it

```bash
URL=http://203.0.113.7:8030 KEY=sk-...
curl $URL/health
curl $URL/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -d '{"messages": [{"role": "user", "content": "Hi!"}]}'
curl -N $URL/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -d '{"stream": true, "messages": [{"role": "user", "content": "Count to five."}]}'
```

Any OpenAI client works: `OpenAI(base_url=f"{URL}/v1", api_key=KEY)`, model `qwen3:4b-instruct`.
Responses carry `X-RateLimit-Limit`/`-Remaining`, `X-Queue-Wait-Ms` and `X-Prompt-Tokens`;
429 and 503 carry `Retry-After`. If `max_tokens` isn't given, the reply gets what's left of the
context, up to `MAX_OUTPUT`.

**The web chat** (`/`) asks for a key, keeps it and the conversation in the browser, and streams
the replies. Under each one it shows the queue wait, time to first token, speed and tokens, and
above the input a context meter and the requests left this minute. 413/429/503 show up as
readable notes in the conversation.

### Verify a deployment

```bash
uv run check limits --url $URL --key <load key> --demo-key <demo key>
uv run check load   --url $URL --key <load key> [--levels 1,2,4,8,12] [--rounds 2] [--max-tokens 128]
```

## Settings

All environment variables (`.env`), documented in [`gateway/config.py`](gateway/config.py):

| | default | |
|---|---|---|
| `API_KEYS` | (required) | `name:key[:rpm],...` |
| `MODEL` | `qwen3:4b-instruct` | |
| `MAX_CONTEXT` | 4096 | tokens, prompt + reply; also Ollama's `num_ctx` |
| `MAX_OUTPUT` | 1024 | tokens per reply |
| `RATE_LIMIT_RPM` | 20 | per key, unless the key sets its own |
| `MAX_CONCURRENT` | 2 | generation slots; compose sets `OLLAMA_NUM_PARALLEL` to match |
| `MAX_QUEUE` | 6 | requests that may wait for a slot |
| `QUEUE_TIMEOUT` | 120 | seconds a request may wait |
| `REQUEST_TIMEOUT` | 300 | seconds Ollama may take |
| `MAX_BODY_BYTES` | 262144 | |
| `NUM_THREAD` | Ollama's pick | only when the container has fewer cores than the host |

## Files

- [`gateway/app.py`](gateway/app.py): the API, the order of the checks, SSE streaming, `/health`
- [`gateway/limits.py`](gateway/limits.py): token-bucket rate limiter, the slot gate with its queue, the token counter
- [`gateway/ollama.py`](gateway/ollama.py): Ollama's native `/api/chat`, streamed, thinking off; warm-up
- [`gateway/serve.py`](gateway/serve.py), [`gateway/config.py`](gateway/config.py): `uv run serve`, settings
- [`web/`](web): the chat page
- [`checks/cli.py`](checks/cli.py): `uv run check limits|load`
- [`compose.yaml`](compose.yaml), [`Dockerfile`](Dockerfile), [`deploy/deploy.sh`](deploy/deploy.sh), [`.env.example`](.env.example)
- [`tests/`](tests): `uv run pytest`: auth, streaming format, 429 + refill, 413 + reply budget, body size, 400s, 502, 503 when the queue is full or times out, slots released
