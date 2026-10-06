# Task 26 — A local LLM

`qwen3:8b` (8.2B parameters, Q4_K_M, 5.2 GB) served by **Ollama 0.33.2** on an M1 Pro with 32 GB,
fully on the GPU through Metal. It's reached two ways: the `ollama` CLI and the HTTP API on
`localhost:11434`. `llm` is a small Python CLI over that HTTP API. It streams answers (and
qwen3's reasoning, dimmed), keeps a multi-turn chat, and runs the graded prompts with timings.

## Run

```bash
brew install ollama          # or the app from ollama.com; then `ollama serve` if it isn't running
ollama pull qwen3:8b         # once, 5.2 GB

uv run llm status                                  # server version, pulled and loaded models
uv run llm ask "What is a mutex?"                  # one request, streamed
uv run llm ask --think "Is 1001 prime?"            # with the model's reasoning shown
uv run llm chat -s "Answer briefly."               # multi-turn chat; empty line quits
uv run llm run                                     # prompts.json → results/run-*.json
uv run llm -m llama3.2:3b ask "..."                # any other pulled model
```

`OLLAMA_HOST` overrides the server address.

## Proof that it's local

- `llm status` / `ollama ps` show `qwen3:8b` loaded at 9.9 GB, 100% GPU (the weights plus the KV cache for its 40,960-token context).
- Every request goes to `localhost:11434`. Turning off Wi-Fi changes nothing.
- The raw API with no client in between:

```bash
ollama run qwen3:8b --think=false "Say hello in Kazakh, one line."      # → Сәлем!
curl -s localhost:11434/api/chat -d '{"model":"qwen3:8b","stream":false,"think":false,
  "messages":[{"role":"user","content":"2+2?"}]}' | jq -r .message.content
curl -s localhost:11434/v1/chat/completions -d '{"model":"qwen3:8b",
  "messages":[{"role":"user","content":"2+2?"}]}' | jq -r '.choices[0].message.content'   # OpenAI-compatible
```

## Three requests of rising difficulty

[`prompts.json`](prompts.json), results in [`results/`](results/):

| level   | request | think | in | out | tok/s | wall |
|---------|---------|-------|---:|----:|------:|-----:|
| simple  | capital of Kazakhstan, one sentence | off | 28 | 10 | 25.9 | 0.6 s |
| medium  | explain RAG in exactly three sentences | off | 48 | 92 | 23.8 | 4.2 s |
| complex | two trains meeting + a Python `meet()` function, checked | on | 108 | 4325 | 22.0 | 197 s |

What came back:

- **simple:** "The capital of Kazakhstan is Nur-Sultan." This was wrong as of 2022, when the city was
  renamed back to Astana. The model is fast and fluent, but its knowledge stops at its training data,
  and nothing in the answer signals that. (This is the gap RAG from tasks 21–25 fills.)
- **medium:** exactly three sentences covering what RAG is, why it helps, and a limitation, as asked.
- **complex:** correct. The trains meet at 11:13:20, 177.8 km from A. The function
  `meet(d, v1, v2, delay_h) = ((d + v2·delay)/(v1+v2), v1·t)` returns `(2.222, 177.78)`. But it spent
  ~11k characters reasoning (4.3k tokens, about 3 minutes) to get there. It also closes by claiming the
  function handles the case where the first train arrives before the second departs. It doesn't: the
  formula then gives a meeting point past B.

Speed is a steady ~22–26 tokens/s for generation. Prompt processing is near-instant at these
sizes. A cold request first pays ~4 s to load the model into memory, and Ollama unloads it
after 5 idle minutes. With thinking on, time grows with the reasoning, not the answer, so it's
worth turning on only for problems that need it.

## Files

- `localllm/ollama.py`: a minimal client for `/api/version`, `/api/tags`, `/api/ps` and streaming `/api/chat`, with timings from the final chunk
- `localllm/cli.py`: the `llm` command (`status`, `ask`, `chat`, `run`)
- `prompts.json`: the graded requests
- `results/`: saved runs (answer, reasoning, token counts, speed)
