# Task 25 — Mini-chat with RAG, sources and task memory

A web chat over the task 21 corpus. Every message is a turn in a saved conversation. A question
is rewritten into a standalone question from the recent history and the task memory, then goes
through task 24's cited pipeline (retrieval, answer, sources, verified quotes, "I don't know"
with a clarifying question). After each turn a separate LLM call updates the **task memory**:
the goal of the conversation, what the user has clarified, and the constraints and terms that
were agreed. Two scripted scenarios of 12–15 messages check that the assistant stays on the
goal, keeps the constraints, and keeps citing sources to the end.

Python 3.13, `uv`. Built on a copy of task 24. Ollama `nomic-embed-text`, local
`bge-reranker-base`, DeepSeek (`deepseek-flash`) for condensing, answers, memory updates and
judging. FastAPI + uvicorn serve a static page (plain HTML/JS/CSS, no build, as in tasks 4–15).

## Decisions

| | choice | why |
|---|---|---|
| base | copy task 24 (`indexer/`, `rag/`, `tests/`; `docs/` and `index/` copied, gitignored); `rewrite+rerank`, cited style | the best retrieval and the checked-citation answer are already there |
| UI | web: `uv run rag web` → http://127.0.0.1:8025. FastAPI serves `web/` (index.html, app.js, styles.css) and a JSON API | the retrieval stack (Ollama, cross-encoder, SQLite) is Python, so the page can't call DeepSeek directly the way task 15's did; the page itself stays build-free |
| history | SQLite `chat/chat.db` (gitignored): sessions, messages (with sources, quotes, standalone question, retrieval as JSON), memory, memory log. Sessions can be resumed and listed | "stores conversation history", production-like: survives a restart |
| history in prompts | the last 6 messages verbatim; older turns reach the model only through the task memory | the prompt stays the same size on turn 15 as on turn 3; the memory has to carry what matters, which is what the test checks |
| follow-ups | new **condense** step before retrieval: history window + memory + message → JSON `{"kind": "question"\|"meta", "standalone": "..."}`. The standalone question goes to task 24's rewrite → search → rerank | "how much protein for that?" retrieves nothing as is. Task 24's rewriter always searches the raw question too, so the raw follow-up must not be what it sees |
| meta turns | `kind: meta` ("thanks", "what have we agreed so far?") → no retrieval; the reply is written from the memory and history, marked *no retrieval*, with no sources | your choice: skip RAG. Not counted as a missing-source failure |
| answering | task 24's cited agent, with the standalone question, plus two blocks in the prompt: the task memory and the history window. Sources, quote check, retry and both "I don't know" gates unchanged | the memory adds constraints ("short answers", "kg") and context; the quote check still ties every fact to a chunk, so history can't be passed off as a source |
| task memory | `{goal, clarified[], constraints[], terms[], scope[]}`. Items have an id, text and the turn they came from. `scope` is a list of documents the user limited the conversation to | the three things the task names, plus scope, which turns "only use Gutless" into a retrieval filter instead of a request the model may ignore |
| memory update | **separate** LLM call after the answer: current memory + this turn (message, standalone question, answer) → JSON operations: `set_goal`, `add {field, text}`, `remove {id}`, `set_scope [sources]`. The code validates and applies them and logs each with its turn | edits instead of a full rewrite: an item can't silently disappear or change, and the log shows when and why the memory changed |
| scope filter | `Retriever.search(..., sources=...)` filters by source in SQL; empty scope = all documents | a constraint the code enforces |
| "I don't know" + clarification | as in task 24. The user's reply is condensed together with the history ("the Apertium one" → the full question), and the memory update records it under `clarified` | in task 24 the clarifying question was a dead end; here it continues |

## A turn

```
message ─▶ condense (last 6 messages + memory) ─▶ meta? ──yes──▶ reply from memory + history (no retrieval)
                                                    │ no                                   │
                                                    ▼                                      │
                    standalone question ─▶ rewrite ─▶ search (scope) ─▶ RRF ─▶ rerank       │
                                                    │                                      │
                          task 24 cited agent (+ memory, + history window): gates, quotes   │
                                                    │                                      │
                                                    ▼                                      ▼
                                 memory update (separate LLM call) → ops → validate → apply → log
                                                    │
                                    save the turn ─▶ answer + Sources + Quotes + memory changes
```

## The page

```
┌ sessions ─────┬ chat ──────────────────────────────────────────┬ task memory ─────────────┐
│ + new         │ you: and how much protein for that?             │ goal                     │
│ ▸ Fat loss…   │   ↳ "Daily protein intake for a vegetarian       │   lose ~8 kg using Gutless│
│   TatarTTS…   │      losing fat, according to Gutless"           │ clarified                │
│               │ assistant: … 1 g per pound of goal weight [1] …  │   vegetarian        (t3) │
│               │   ▾ Sources  [1] Gutless.pdf · Ch. 4 · p. 14     │ constraints              │
│               │   ▾ Quotes   ✓ 100 [1] "…"                       │   short answers     (t1) │
│               │   memory: + constraints "use kg"                 │   + use kg          (t7) │
│               │ [ message …                          ] [send]    │ terms · scope            │
└───────────────┴─────────────────────────────────────────────────┴──────────────────────────┘
```

A turn takes several seconds (condense, rewrite, answer, memory update). The page shows a
spinner; the API answers in one request. API: `GET/POST /api/sessions`,
`GET/DELETE /api/sessions/{id}`, `POST /api/sessions/{id}/messages`. The reranker and the
index load once when the server starts.

## Scenarios — 2 × 12–15 messages

`scenarios.json`. Each user message has its expectations: `kind` (answer / unknown / meta),
the documents it should cite, optional `must_contain`, what a follow-up `means`, and memory
items that should exist after it. First drafts, settled in stage 4 against the real corpus:

**S1 — Gutless fat-loss plan.** Turn 1 sets the goal ("lose about 8 kg, base everything on
Gutless, keep answers short"). Then: the three rules → "how do I work out my calories for
that?" → "I'm vegetarian, how do I get enough protein?" → "use kg, not pounds" (Gutless works
in pounds; later numbers should be in kg) → creatine (not in the book: I don't know, without
losing the goal) → "remind me what we've agreed" (meta) → several more follow-ups using
"it"/"that" → a final recap.

**S2 — a TTS dataset for a low-resource language.** Goal: plan a speech dataset, using TatarTTS
as the model. Then: size and speakers → "how did they record it?" → a term ("by *the paper* I
mean TatarTTS") → "what did the evaluation show?" (ambiguous between TatarTTS and Apertium → I
don't know + which one?) → "the TTS one" (the clarification is used) → a scope change ("now
also look at the Apertium paper") → a question across both → recap.

## Evaluation

`uv run rag scenario run` runs each scenario in-process through the same chat service the web
API uses (a fresh session each time), saves `eval/scenario-….json` and writes `EVAL.md`.

| check | how |
|---|---|
| **sources on every answer** | answer turns: ≥ 1 source and ≥ 1 verified quote; meta turns: no retrieval |
| **expected document cited** | a cited chunk comes from the expected source |
| **I don't know where expected** | with a clarifying question; and not on answerable turns |
| **follow-up resolved** | judge: does the standalone question mean what the scenario's `means` says? |
| **memory correct** | the expected items are in the memory after their turn (judge, so wording can differ); the goal set on turn 1 is still the goal at the end |
| **constraints kept** | judge per answer: does it respect the constraints in the memory (short, kg, scope)? |
| **on track** | judge per answer: does it serve the goal and answer the resolved question? |
| **faithful** | task 24's faithfulness judge on each answer and its quotes |

For contrast, the same scenarios run with the **memory off** (history window only, no memory
blocks, no scope). The expectation is that constraints from early turns ("kg", "short",
"vegetarian") are lost once those turns leave the window. EVAL.md: a table for memory on and
memory off per scenario, a written reading, and the full transcript of each scenario with
sources, quotes and memory changes per turn.

## Layout

```
task25/
  docs/ index/            ← copied from task 24 (gitignored)
  chat/                   ← chat.db (gitignored)
  indexer/                ← unchanged
  rag/                    ← task 24, plus:
    store.py              SQLite: sessions, messages, memory, memory log
    condense.py           history + memory + message → {kind, standalone}
    memory.py             TaskMemory, the update prompt, ops parse/validate/apply
    chat.py               ChatService.turn(session, message): condense → agent → memory → save
    retrieve.py           + sources filter
    prompt.py             + memory and history blocks in the cited prompt, the meta prompt
    server.py             FastAPI: the API + static web/
    scenario.py           run the scenarios, checks, judges, memory on/off
    cli.py                + web, scenario run; chat uses ChatService (--session)
  web/                    index.html, app.js, styles.css
  scenarios.json
  EVAL.md
```

## Stages

One branch, `task25/rag-chat`, one commit per stage, one PR at the end.

1. **copy + chat core**: copy task 24, `store.py`, `condense.py`, the history window,
   `ChatService.turn` with meta turns, the CLI `rag chat` on top of it with `--session`. Tests
   with a mocked LLM: follow-up condensed, meta skips retrieval, history saved and resumed.
2. **task memory**: `memory.py`, the update call, ops validation (unknown id, bad field),
   the log, memory and history blocks in the answer and condense prompts, the scope filter in
   the retriever. Tests for ops, scope and the prompts.
3. **web**: `server.py`, `web/` (sessions, chat with Sources/Quotes, the memory panel with
   per-turn changes), `uv run rag web`. Tests with FastAPI's TestClient against a mocked chat.
4. **scenarios**: `scenarios.json` (2 × 12–15), `scenario.py` with the checks and judges,
   memory on vs off, full runs, EVAL.md with the reading, README.

## Setup you need to do

- `ollama serve` with `nomic-embed-text`
- `DEEPSEEK_API_KEY` in the environment or `task25/.env`
- `bge-reranker-base` is already in the Hugging Face cache
