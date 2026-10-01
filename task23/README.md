# Task 23 — Reranking, filtering and query rewriting

The task 22 RAG agent gets a second retrieval stage and a query rewrite:

- **rerank**: a wide cosine search (top 20), then a local cross-encoder
  (`BAAI/bge-reranker-base`) scores each candidate against the question, and the best 5 that
  pass a threshold go to the LLM. If none pass, the agent refuses without calling the LLM.
- **cos-filter**: the cheap baseline. Keep the cosine top 5 within 0.06 of the best score.
- **rewrite**: DeepSeek turns the question into 1–3 search queries, written in the documents'
  vocabulary (it sees the document titles). The question and its rewrites are searched,
  and the results are fused by reciprocal rank.
- **rewrite+rerank**: the full pipeline. The fused pool is reranked, and each chunk keeps its
  best score over the question and its rewrites.

Fifteen control questions (task 22's ten, plus two vague and three near-miss unanswerable
ones) compare the modes: [EVAL.md](EVAL.md).

Python 3.13, `uv`, Ollama `nomic-embed-text` for embeddings, `sentence-transformers` for the
cross-encoder (MPS on Apple silicon), DeepSeek (`deepseek-flash`) for rewriting, answers and
grading. `indexer/` is task 21; `rag/` builds on task 22. [PLAN.md](PLAN.md) has the design.

```
question ─▶ [rewrite: DeepSeek → 1–3 queries] ─▶ nomic-embed-text ─▶ cosine top 20 per query ─▶ RRF fusion
                                                                                                   │
           ┌───────────────────────────────────────────────────────────────────────────────────────┘
           ▼
 [cross-encoder(query, chunk) → 0..1, best over the queries] ─▶ drop < threshold ─▶ top 5 ─▶ DeepSeek ─▶ answer [n]
                                                        nothing left? ─▶ "The documents do not contain the answer."
```

## Run

```bash
ollama pull nomic-embed-text               # once
cp ../task22/docs/*.pdf docs/              # the task 21 corpus
uv run indexer index                       # → index/index.db
echo 'DEEPSEEK_API_KEY=sk-…' > .env        # or export it
                                           # the first rerank downloads bge-reranker-base (~1.1 GB)

uv run rag ask "What are the three golden rules of fat loss in Gutless?" --show-context   # base, then rerank
uv run rag ask "…" --mode rewrite+rerank --show-context    # queries, kept chunks with both ranks, the rest
uv run rag ask "…" --mode rerank@0.3                       # a mode with its own threshold
uv run rag chat                            # /mode rewrite+rerank  /threshold 0.3  /k-before 30  /context on

uv run rag check [--rewrite]               # retrieval only: expected chunk's rank before and after reranking
uv run rag calibrate [--rewrite]           # score distributions and the threshold sweep
uv run rag eval --modes base,cos-filter,rerank@0,rerank,rerank@0.3,rewrite,rewrite+rerank@0,rewrite+rerank \
                --markdown EVAL.md
uv run rag eval --report eval/run-….json --markdown EVAL.md
uv run pytest -q
```

## Settings

| option | default | what it does |
|---|---|---|
| `--k-before` | 20 | cosine candidates per query (the pool the reranker sees) |
| `--k-after` | 5 | chunks that go into the prompt |
| `--threshold` | rerank 0.05, rewrite+rerank 0.3 | minimum cross-encoder score; `mode@T` sets it per mode |
| `--cos-delta` | 0.06 | cos-filter: maximum distance from the best cosine score |
| `--reranker-model` | `BAAI/bge-reranker-base` | any sentence-transformers cross-encoder |

The thresholds come from `rag calibrate`. For each mode, the default is the strictest cutoff that
leaves every answerable question with its hit.

## Result

| | base | rerank | rerank@0.3 | rewrite | rewrite+rerank |
|---|---:|---:|---:|---:|---:|
| judge score | 11.5 / 15 | 11.5 / 15 | 10.0 / 15 | 11.0 / 15 | 12.0 / 15 |
| keyword score | 89% | 87% | 72% | 87% | 92% |
| expected source in the context (answerable) | 9 / 10 | 9 / 10 | 8 / 10 | 9 / 10 | 10 / 10 |
| chunks sent (mean) | 5.0 | 4.3 | 2.8 | 5.0 | 3.9 |
| refused before the LLM (unanswerable / answerable) | 0 / 0 | 0 / 0 | 1 / 2 | 0 / 0 | 1 / 0 |
| latency | 2.2 s | 2.6 s | 2.0 s | 5.2 s | 6.9 s |

- **Reranking fixes the ordering misses.** The expected chunk moves from cosine rank 2–6 to
  rank 1 on q04, q06 and q07. Only rewrite + rerank also fixes the multi-document question
  (q08), and only because each chunk is scored against its best query.
- **The threshold is a cost control, not a relevance oracle.** It cuts 10–20% of the prompt
  and refuses the off-topic question without calling the LLM. But near-miss questions score
  like real answers (0.96), and a stricter cutoff empties the contexts of answerable
  questions.
- **The differences in judge score are within the run-to-run noise (±1.5).** EVAL.md reads
  them question by question, including where reranking made things worse (q02, q11, q12).
