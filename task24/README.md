# Task 24 — Citations, sources and "I don't know"

The task 23 RAG agent now always answers in three parts, or says it doesn't know:

- **answer** with `[n]` markers
- **sources**: source file · section · pages · chunk_id, for every passage the answer uses
- **quotes**: text copied from those chunks, each checked against the chunk it cites
- **"I don't know" + a clarifying question** when relevance is below the threshold, when the
  passages don't state the answer, or when the question is ambiguous

The model answers in JSON and gives only passage numbers. Source, section, pages and chunk_id
are filled in from the retrieved chunk, so it can't invent them. Every quote is fuzzy-matched
against its chunk. A reply with a bad format or a quote that isn't in its chunk is retried once.
After that, failed quotes are dropped, and an answer left with no quote becomes "I don't know".

Python 3.13, `uv`, Ollama `nomic-embed-text`, local cross-encoder `bge-reranker-base`, DeepSeek
(`deepseek-flash`) for rewriting, answers, clarifying questions and both judges, `rapidfuzz` for
quote matching. `indexer/` is task 21, `rag/` builds on task 23. [PLAN.md](PLAN.md) has the design.

```
question ─▶ rewrite ─▶ search ─▶ RRF ─▶ rerank ─▶ best score < 0.3? ──yes──▶ LLM: clarifying question ─▶ I don't know + question
                                                        │ no                                                 (gate 1)
                                                        ▼
                              DeepSeek JSON {status, answer, citations[ref, quote], clarification}
                                                        │
               parse ─▶ check refs ─▶ match each quote in its chunk (≥ 90) ─▶ bad? retry once with the error
                                                        │
                       status unknown (no answer / ambiguous), or no quote left? ──yes──▶ I don't know + question (gate 2)
                                                        │ no
                                                        ▼
                                          answer [n]  +  Sources  +  Quotes ✓ score
```

## Run

```bash
ollama pull nomic-embed-text               # once
cp ../task23/docs/*.pdf docs/              # the task 21 corpus
uv run indexer index                       # → index/index.db
echo 'DEEPSEEK_API_KEY=sk-…' > .env        # or export it

uv run rag ask "What are the three golden rules of fat loss in Gutless?"
uv run rag ask "What did the evaluation show?"                     # ambiguous → I don't know + which one?
uv run rag ask "According to Gutless, how many grams of creatine should you take per day?" --show-context   # below the threshold
uv run rag ask "…" --json                  # the structured answer
uv run rag ask "…" --style legacy          # task 23's free-text answer, for comparison
uv run rag chat                            # /style cited|legacy  /threshold 0.3  /context on

uv run rag eval --markdown EVAL.md         # legacy vs cited on the 10 questions, both judges
uv run rag eval --report eval/run-….json --markdown EVAL.md
uv run pytest -q
```

```
── rewrite+rerank  (1919→330 tokens, 2.4s)
  The three golden rules of fat loss in Gutless are: 1. Calories, 2. Protein, and 3. Consistency [1]. …
  Sources
    [1] Gutless.pdf · … > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11 · gutless:struct:0012
    [4] Gutless.pdf · … > Chapter 2: The Three Golden Rules of Fat Loss · p. 9 · gutless:struct:0010
  Quotes
    ✓ 100.0  [1] "1. Calories 2. Protein  3. Consistency"
    ✓ 100.0  [4] "RULE ONE: Rule number one concerns the amount of energy - measured in calories - …"
```

## Result

Ten questions: 7 answerable, 2 unanswerable, 1 ambiguous. The same `rewrite+rerank` retrieval
feeds both columns. Details and three runs are in [EVAL.md](EVAL.md).

| | legacy (task 23 prompt) | cited |
|---|---:|---:|
| sources in the answer | 8 / 8 | 7 / 7 |
| quotes in the answer | 0 / 8 | 7 / 7 |
| quotes found in their chunk | — | 30 / 31 |
| meaning matches the quotes (supported / partial / unsupported) | — | 5 / 2 / 0 |
| I don't know where expected | 2 / 3 | 3 / 3 |
| … with a clarifying question | 0 / 3 | 3 / 3 |
| I don't know on an answerable question | 0 / 7 | 0 / 7 |
| correctness judge | 8.0 / 10 | 8.0 / 10 |
| answer latency (mean) | 1.7 s | 7.3 s (one 49 s outlier) |

- **The prompt mattered most.** With "every [n] needs a quote", the model gave one quote per
  passage, and 3 of 7 answers were fully supported. "Every fact must be in a quote; drop what
  you cannot quote" raised that to 5–6.
- **Two gates are needed.** The relevance threshold stops the off-topic question before the
  answering LLM. Near misses score like real answers (0.96), so only the model reading the
  passages catches them, and the ambiguous question too, once the prompt says to ask which one.
- **Fuzzy matching has to allow for the PDF.** A real quote failed at 81 because a page break
  (footnote + running header) splits the sentence inside the chunk. One gap is now allowed.
