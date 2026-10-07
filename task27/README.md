# Task 27 — A local LLM in a real application

Task 25's RAG chat (web and terminal), moved off the cloud. Every model call now goes to
`qwen3:8b`, served by Ollama on `localhost:11434`: condensing follow-ups, rewriting queries,
the cited answers, "I don't know" clarifications, the task-memory edits and the judge.
Embeddings (`nomic-embed-text` in Ollama) and the reranker (`BAAI/bge-reranker-base`, loaded
from the local Hugging Face cache) were already local. The app has no API keys and makes no
calls outside the machine.

What changed from task 25:

- [`rag/llm.py`](rag/llm.py): `LocalLLM` replaces the DeepSeek client and keeps its
  `chat(system, user, json)` interface, so none of the pipeline code changed. It calls Ollama's
  `/api/chat` with `think: false` (all of these calls are short and structured, and qwen3's
  reasoning would add minutes per turn), `format: "json"` where the old client used JSON mode,
  `temperature 0`, and `num_ctx 16384` so a turn's ~5k-token prompt is never truncated.
- [`rag/rerank.py`](rag/rerank.py): the cross-encoder is loaded with `local_files_only` and
  downloads only if it isn't cached yet, so it never contacts the Hub, even to check for updates.
- `--model` accepts any pulled Ollama model (default `qwen3:8b`). The page header shows the
  model and the Ollama version it's talking to.

```
message ─▶ condense (memory + last 6 messages) ─▶ meta? ──yes──▶ reply from memory + history, no retrieval
                                                    │ no                                   │
                standalone question ─▶ rewrite ─▶ search (scope) ─▶ RRF ─▶ rerank           │
                                                    │                                      │
          best < 0.3: I don't know + question · else chunks ≥ 0.1 → cited JSON answer       │
          (memory, history and the raw message in front of the passages) → quote check      │
                                                    ▼                                      ▼
                         memory update (separate call): edits → validate → apply → log → save turn
      every LLM box above = qwen3:8b on Ollama · embeddings = nomic-embed-text on Ollama · rerank = local
```

## Run

```bash
brew install ollama                        # or the app from ollama.com; `ollama serve` if it isn't running
ollama pull qwen3:8b                       # once, 5.2 GB
ollama pull nomic-embed-text               # once
cp ../task24/docs/*.pdf docs/              # the task 21 corpus
uv run indexer index                       # → index/index.db

uv run rag web                             # http://127.0.0.1:8025
uv run rag chat                            # the same chat in the terminal; /memory /history /sessions /new /open ID
uv run rag ask "How many hours of speech does the TatarTTS dataset contain?"
uv run rag web --model llama3.2:3b         # any other pulled model
uv run pytest -q
```

`OLLAMA_HOST` overrides the server address. The first run downloads the reranker (~1 GB)
once. After that the app runs with Wi-Fi off.

The page: saved conversations on the left. In the middle, each reply shows its kind (answer, I
don't know, or no retrieval), the question it searched with, the sources (click a `[n]`), the
checked quotes, the retrieval, and the memory edits it caused. On the right is the task memory,
with the last turn's changes highlighted, and its change log.

## How it runs

M1 Pro, 32 GB, `qwen3:8b` Q4_K_M fully on the GPU through Metal. A four-message conversation:

| message | what happened | seconds |
|---|---|---:|
| I'm building a Tatar TTS system. Keep answers short and use kg for any weights. | goal and constraint saved to memory; condensed into a question and answered with a source | 38 (includes loading the reranker) |
| How much audio is in the TatarTTS dataset? | "around 70 hours of audio [1]", quote verified | 18 |
| and who recorded it? | condensed to "Who recorded the audio in the TatarTTS dataset?"; "two professional speakers, one male and one female [1]" | 18 |
| What have we agreed so far? | meta: answered from memory + history, no retrieval | 8 |

`rag ask` on its own takes 14 s for the answer call (2,032 prompt tokens in, 106 out). A chat
turn makes 3–4 calls (condense, rewrite, answer, memory update), each a few thousand tokens of
prompt, which is why a turn takes 15–20 s. With DeepSeek in task 25 a turn took about 10 s.
The first request after a while also loads the model into memory (`keep_alive` is 30 minutes).

The 8B model is noticeably weaker than DeepSeek on the subtler steps. In the run above it turned
the opening message into a question instead of treating it as context. Its recap mentioned the
facts but not the agreed constraints. Its memory notes are thinner ("the user is asking about…").
The safeguards from tasks 24–25 still apply: quotes are checked against the chunks, a weak
retrieval gives "I don't know", and memory edits are validated. So a weaker model shows up as
blander or less complete answers, not as invented citations.

## Proof that it's local

- The code only talks to `localhost:11434` (Ollama). There's no `.env` and no API key.
- `ollama ps` during a turn shows `qwen3:8b` at 100% GPU.
- Turn off Wi-Fi and keep chatting: nothing changes. The same check from a shell, with every
  outgoing connection sent to a dead proxy and only localhost let through:

```bash
HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=localhost,127.0.0.1 \
  uv run --offline rag ask "Who recorded the TatarTTS dataset?"     # cited answer, quotes ✓
```
