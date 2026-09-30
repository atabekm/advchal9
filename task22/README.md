# Task 22 — First RAG query

An agent with two modes answers questions about the documents indexed in task 21:

- **plain**: the question goes to the LLM as is.
- **rag**: the question is embedded, the nearest chunks are retrieved from the
  index, and they go to the LLM together with the question, with instructions to
  answer only from them and cite `[n]`.

Ten control questions with written expectations measure the difference:
[EVAL.md](EVAL.md).

Python 3.13, `uv`, Ollama `nomic-embed-text` for embeddings, DeepSeek
(`deepseek-flash`) for answers and for grading. `indexer/` is task 21, copied
unchanged; `rag/` is new. [PLAN.md](PLAN.md) has the design.

```
question ──▶ nomic-embed-text ──▶ top-k chunks ──┐   (rag mode only)
                                  index/index.db │   struct | fixed
                                                 ▼
          system rules + [1] title · pages · section + chunk … + question ──▶ DeepSeek ──▶ answer [n]
```

## Run

```bash
ollama pull nomic-embed-text               # once
cp ../task21/docs/*.pdf docs/              # the task 21 corpus
uv run indexer index                       # → index/index.db
echo 'DEEPSEEK_API_KEY=sk-…' > .env        # or export it

uv run rag ask "How many hours of speech does the TatarTTS dataset contain?"   # plain, then rag
uv run rag ask "…" --mode rag --strategy fixed -k 3 --show-context
uv run rag chat                            # /rag on|off  /strategy fixed  /k 3  /context on

uv run rag check                           # retrieval only: expected sources in the top k?
uv run rag eval --markdown EVAL.md         # 10 questions × plain, rag/struct, rag/fixed, judged
uv run rag eval --rejudge eval/run-….json  # grade saved answers again
uv run rag eval --report eval/run-….json --markdown EVAL.md
uv run pytest -q
```

## The two modes

| | plain | rag |
|---|---|---|
| system prompt | answer concisely; say if you don't know | answer only from the numbered context, cite `[n]`, reply "The documents do not contain the answer." when it isn't there |
| user message | the question | `Context:` + `[n] title (file), pages, section` + chunk text for each hit, then `Question: …` |
| retrieval | none | `nomic-embed-text` with the `search_query:` prefix, cosine top-k (default 5) over `struct` (default) or `fixed` chunks |

Temperature is 0 in both modes. Citations are parsed from the answer and mapped back
to the chunks, so `ask` prints which document, page and section each `[n]` came from.

## Control questions

[questions.json](questions.json): each entry has the question, `expect` (what a correct
answer contains, written from the documents), `must_contain` (keyword groups; every
group must match, any alternative within a group), and `sources` (file and pages where
the answer is).

| kind | ids | what it tests |
|---|---|---|
| fact | q01, q02, q04, q06, q07 | a number, a name, a list from one place |
| explain | q03, q05 | a section's worth of reasoning |
| multi | q08 | two documents at once |
| unanswerable | q09, q10 | not in the corpus: the right answer is a refusal |

## Scoring

- **keywords**: fraction of `must_contain` groups found in the answer. It is
  deterministic and free, and blind to paraphrase.
- **judge**: DeepSeek grades the answer against `expect` as correct / partial / wrong /
  refused and flags hallucinations. It never sees the mode or the context. On
  unanswerable questions, a refusal counts as correct.
- **retrieval hit@k**: a retrieved chunk comes from an expected source and overlaps
  its pages. For multi-source questions, every source must be found.
- **citation**: the chunks the answer cites include an expected source.

## Result

| | plain | rag/struct | rag/fixed |
|---|---:|---:|---:|
| judge score | 3.0 / 10 | 8.5 / 10 | 7.0 / 10 |
| hallucinations | 5 | 1\* | 0 |
| keyword score | 13% | 90% | 73% |
| retrieval hit@5 | — | 7 / 8 | 6 / 8 |
| latency | 30.9 s | 1.9 s | 1.9 s |

\* a judge false positive; see [EVAL.md](EVAL.md), which also has the per-question
table, every answer, and a reading of the misses (all of them are retrieval misses, not
generation errors).
