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
- Changes for the 8B model, each found by replaying a real conversation:
  - **Constrained decoding.** The condense and memory calls pass a JSON schema as Ollama's
    `format`, so only valid kinds and the four real memory edits can be generated. Before
    this, qwen3 invented ops like `set_constraints`; they were rejected and the constraint was lost.
  - **Think before choosing.** The condense schema starts with an `asks` field ("what does
    this message ask of the documents?") before `kind`. Without it, "I'm vegetarian and I weigh
    82 kg" was turned into an invented question about protein, taken from an example in the
    prompt, and answered "I don't know".
  - **The memory only keeps what the user said.** qwen3 copied the prompt's examples into the
    memory: a "use kilograms, not pounds" constraint the user never set, which the answer step
    then obeyed ("multiply your weight in *kilograms* by 10–12", while the quoted passage says
    pounds). [`apply()`](rag/memory.py) now rejects an added item unless most of its words come
    from the user's message. It also strips a copied `- [c2]` / `k2:` prefix, and a duplicate
    becomes a no-op instead of an error.
  - **Prompt wording.** The goal is kept in the user's own words (the model was copying the
    example goal), every "please do X" about the answers is a constraint, and a message that
    only tells something about the user is small talk.
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

M1 Pro, 32 GB, `qwen3:8b` Q4_K_M fully on the GPU through Metal. This is the demo
conversation, replayed through the chat service:

| message | what happened | seconds |
|---|---|---:|
| I want to lose about 15 pounds of fat, answers from Gutless only, keep them short. What are the main rules? | goal, constraint and scope (Gutless) saved; "1. Calories, 2. Protein, 3. Consistency" | 47 (loads the reranker) |
| I'm vegetarian and I weigh 180 pounds. | small talk, no retrieval; saved as a clarification | 7 |
| How do I work out my calories with the first rule? | "multiply your weight in pounds by a number between 10 and 12 [2]", quote verified | 19 |
| And how much protein should I eat? | condensed to "How much protein per day does Gutless recommend?"; "1 gram per pound of lean bodyweight [3]" | 16 |
| Is pea protein a good option for that? | "that" resolved to protein intake; yes, with a source | 15 |
| Remind me: what's my goal, and what have we agreed on so far? | answered from memory and history, no retrieval; goal and all three facts correct | 8 |

And one that should get "I don't know": *According to Gutless, how many grams of creatine
should you take per day?* gets "I don't know", with what the book does cover and a clarifying question.

A chat turn makes 3–4 calls (condense, rewrite, answer, memory update), each with a few
thousand tokens of prompt, so a turn takes 15–20 s at ~23 tokens/s. With DeepSeek in task 25 a
turn took about 10 s. The first request after a while also loads the model into memory
(`keep_alive` is 30 minutes). Turning on qwen3's thinking for the answer call alone was not
usable: a single answer ran past 10 minutes.

### Where the 8B model still falls short

- **Unit conversion.** Ask for kilograms and it puts kilograms into Gutless's formula, which is
  written for pounds. With one prompt wording it said "kg × 10–12"; with another, "820–984 kcal a
  day". The quote check can't catch this: the quote is genuine, the arithmetic is wrong. So the
  demo uses pounds.
- **Ambiguity.** "What did the evaluation show?" should get a question back about which
  evaluation is meant (two papers have one). qwen3 picks the Apertium one and answers.
- **Over-caution.** "What protein sources does Gutless suggest for vegetarians?" gets "I don't
  know", although its own clarification says the book mentions pea protein. "Is pea protein a
  good option for vegetarians?" is answered.

The checks from tasks 24–25 still hold: quotes are verified against the chunks, a weak
retrieval gives "I don't know", and memory edits are validated. So a weaker model mostly shows
up as blander or less complete answers, not as invented sources. The unit-conversion case is
the exception: the source is real and the number is wrong.

## Proof that it's local

- The code only talks to `localhost:11434` (Ollama). There's no `.env` and no API key.
- `ollama ps` during a turn shows `qwen3:8b` at 100% GPU.
- Turn off Wi-Fi and keep chatting: nothing changes. The same check from a shell, with every
  outgoing connection sent to a dead proxy and only localhost let through:

```bash
HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=localhost,127.0.0.1 \
  uv run --offline rag ask "Who recorded the TatarTTS dataset?"     # cited answer, quotes ✓
```
