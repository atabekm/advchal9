# Task 25 — Mini-chat with RAG, sources and task memory

A web chat (and a CLI one) over the task 21 corpus. Conversations are saved and can be resumed.
Every question goes through task 24's cited pipeline, so every answer has sources and quotes
checked against their chunks, or is an "I don't know" with a clarifying question. Two things
make it a conversation rather than a series of questions:

- **condensing**: a follow-up ("and how much protein?") is rewritten from the recent history
  and the memory into a standalone question before retrieval. Small talk and "what have we
  agreed?" skip retrieval.
- **task memory**: after every turn a separate LLM call edits a small structured record:
  the **goal**, what the user **clarified** (their situation, what they meant), the
  **constraints** and **terms** agreed, and the **scope** (documents the user limited the chat
  to, enforced by the retriever). Only the last 6 messages go into the prompts verbatim;
  older turns reach the model only through this memory.

Python 3.13, `uv`, FastAPI + a build-free page (`web/`), SQLite for the history. Ollama
`nomic-embed-text`, local `bge-reranker-base`, DeepSeek (`deepseek-flash`) for condensing,
rewriting, answers, memory updates and judging. [PLAN.md](PLAN.md) has the design and what the
build changed.

```
message ─▶ condense (memory + last 6 messages) ─▶ meta? ──yes──▶ reply from memory + history, no retrieval
                                                    │ no                                   │
                standalone question ─▶ rewrite ─▶ search (scope) ─▶ RRF ─▶ rerank           │
                                                    │                                      │
          best < 0.3: I don't know + question · else chunks ≥ 0.1 → cited JSON answer       │
          (memory, history and the raw message in front of the passages) → quote check      │
                                                    ▼                                      ▼
                         memory update (separate call): edits → validate → apply → log → save turn
```

## Run

```bash
ollama pull nomic-embed-text               # once
cp ../task24/docs/*.pdf docs/              # the task 21 corpus
uv run indexer index                       # → index/index.db
echo 'DEEPSEEK_API_KEY=sk-…' > .env        # or export it

uv run rag web                             # http://127.0.0.1:8025
uv run rag web --no-memory                 # the same chat with the history window only
uv run rag chat                            # in the terminal; /memory /history /sessions /new /open ID
uv run rag chat --session ID               # resume a saved conversation
uv run rag chat --list

uv run rag scenario --markdown EVAL.md     # both scenarios, memory on and off, judged
uv run rag scenario --report eval/scenario-….json --markdown EVAL.md
uv run pytest -q
```

The page: saved conversations on the left; in the middle each reply with its kind (answer /
I don't know / no retrieval), the question it searched with, the sources (click a `[n]`),
the checked quotes, the retrieval and the memory edits it caused; on the right the task memory,
with what the last turn changed highlighted, and its change log.

## Result

Two scripted conversations of 13 messages each, run with the task memory and without it (only
the last 6 messages). Details, transcripts and the reading are in [EVAL.md](EVAL.md).

| | memory on | memory off |
|---|---:|---:|
| reply of the expected kind (answer / I don't know / meta) | 26/26 | 26/26 |
| answers with sources and verified quotes | 18/18 | 18/18 |
| expected document cited | 18/18 | 17/18 |
| follow-up resolved (judge) | 14/14 | 12/14 |
| constraints kept: short, kg, bullet points (judge) | 26/26 | 15/26 |
| on track: serves the goal, recap correct (judge) | 26/26 | 22/26 |
| faithful: supported / partial / unsupported | 8 / 10 / 0 | 4 / 13 / 1 |
| memory: items at their turn / at the end / wrong | 9/9 · 9/9 · 0 | — |
| mean seconds · prompt tokens per turn | 9.9 · 4,430 | 8.3 · 3,288 |

Sources hold either way: they come from the pipeline. Without the memory, the constraints set
on turns 1–2 are gone once those turns leave the window: answers got long again, a calculation
was done in pounds, bullet points stopped, and "the paper" was read as the wrong paper. With
it, the conversation stayed on the user's task to the last turn.
