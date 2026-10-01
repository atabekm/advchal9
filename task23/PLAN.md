# Task 23 — Reranking, filtering and query rewriting

Add a second stage after retrieval: a wide cosine search, then a cross-encoder that
rescores the candidates, drops the ones below a threshold and keeps the best few. Put an
LLM query rewrite in front of the search. Measure every combination against the task 22
pipeline on the same control questions, plus a few new ones.

Python 3.13, `uv`. Built on a copy of task 22. Ollama `nomic-embed-text` for embeddings,
DeepSeek (`deepseek-flash`) for rewriting, answers and grading, and a local cross-encoder
for reranking.

## Decisions

| | choice | why |
|---|---|---|
| base | copy task 22 (`indexer/`, `rag/`, `tests/`, `questions.json`; `docs/` and `index/` copied, gitignored) | builds on top; task 22 stays as submitted |
| strategy | `struct` only | it won task 22 (8.5 vs 7.0); one strategy keeps the mode matrix readable |
| reranker | cross-encoder `BAAI/bge-reranker-base` via `sentence-transformers`, MPS on the M1, `--reranker-model` to swap in `bge-reranker-v2-m3` | it reads the question and the chunk together, unlike cosine over two separate vectors; struct chunks are ≤ 1,500 chars (~350 tokens), inside its 512-token window |
| rerank score | sigmoid of the cross-encoder logit, 0..1 | a fixed threshold means the same thing for every question, which cosine scores (all bunched around 0.5–0.8) do not give |
| K | `--k-before 20` (cosine pool) → rerank → threshold → `--k-after 5` | task 22's misses sat at ranks 6–11; a pool of 20 holds all of them |
| threshold | `--threshold`, default picked in stage 2 from a sweep, not guessed | it is the one number this task is about |
| empty context | every chunk under the threshold → answer "The documents do not contain the answer." without calling the LLM | the filter can refuse unanswerable questions on its own; counted separately in the eval |
| rewrite | DeepSeek turns the question into 1–3 search queries (JSON): resolve vague wording, add the terms a document would use, split multi-part questions | q08 needs one query per document; a conversational question needs the document's vocabulary |
| merging queries | each query retrieves `k-before`; the pools are unioned by chunk id. With the reranker: rerank the union against the **original** question. Without it: reciprocal rank fusion, top `k-after` | the reranker judges relevance to what was asked, not to the rewrite |
| cheap baseline | a cosine-threshold filter mode (relative: keep chunks within Δ of the top cosine score) | shows what the cross-encoder adds over a free heuristic |

## The pipeline

```
question ──▶ [rewrite: DeepSeek → 1–3 queries] ──▶ embed each ──▶ cosine top-20 per query ──▶ union
                    optional                                                                  │
                                       ┌──────────────────────────────────────────────────────┘
                                       ▼
                     [cross-encoder(question, chunk) → score 0..1] ──▶ drop < threshold ──▶ top-5
                          optional                                                           │
                                     empty? ──▶ "The documents do not contain the answer."   │
                                                                                             ▼
                                             task 22 prompt ([n] context + question) ──▶ DeepSeek ──▶ answer
```

## Modes compared

| label | rewrite | stage 2 | what it shows |
|---|---|---|---|
| `base` | — | — (cosine top-5) | task 22 rag/struct, the baseline |
| `cos-filter` | — | cosine top-20 → relative cosine threshold → top-5 | the free heuristic |
| `rerank` | — | cosine top-20 → cross-encoder → threshold → top-5 | the filter on its own |
| `rewrite` | ✓ | — (RRF top-5) | the rewrite on its own |
| `rewrite+rerank` | ✓ | cross-encoder → threshold → top-5 | the full pipeline |

`plain` stays available (`--modes plain,…`) but is not in the default run; task 22
already measured it.

## Layout

```
task23/
  docs/ index/            ← copied from task 22 (gitignored)
  indexer/                ← unchanged
  rag/
    retrieve.py           + search_many(queries, k) → pooled hits; keeps the cosine rank
    rerank.py             CrossEncoder wrapper: score(question, hits) → hits with rerank score, new rank
    rewrite.py            question → queries (DeepSeek, JSON), with a fallback to the question itself
    pipeline.py           Config(rewrite, stage2, k_before, k_after, threshold) → Retrieval (queries,
                          pool, kept, timings); the one place the modes are defined
    agent.py              takes a Retrieval; empty → refusal without the LLM
    evaluate.py, report.py   modes instead of strategies; new metrics
    cli.py                new options, `calibrate`
  questions.json          10 from task 22 + 5 new
  EVAL.md
```

## Commands

```
rag ask  "…" [--mode base|cos-filter|rerank|rewrite|rewrite+rerank]
             [--k-before 20] [--k-after 5] [--threshold T] [--show-context]
rag chat                       /rewrite on|off  /rerank on|off  /threshold T  /k-before N  /k-after N
rag check   [--k-before 20]    retrieval only: hit rank in the cosine pool and after reranking
rag calibrate                  rerank scores of relevant vs irrelevant chunks + threshold sweep
rag eval    [--modes …] [--markdown EVAL.md]   plus --rejudge / --report as in task 22
```

`--show-context` prints, for each kept chunk, the cosine rank → rerank rank, both scores,
and the rewritten queries. Chunks that were dropped are listed greyed out under the
threshold line. That shows stage 2 working in the video.

## New control questions

Five more, written from the documents (the exact wording is decided in stage 2):

- **2 answerable, worded badly on purpose**: conversational and vague, without the
  document's terms ("that speech dataset for the Turkic language — how was it put
  together?"). These are for the rewrite.
- **3 near-miss unanswerable**: on-topic and plausible, about the right document, but
  the answer is not in it (a detail the paper does not report, a rule the book does not
  give). Unlike q09 and q10, cosine search will find related chunks for these, so they test
  whether the threshold can tell "related" from "answers it".

## Evaluation

The same per-answer scoring as task 22 (keywords, judge, citations), plus:

- **pool recall**: an expected source is in the cosine top-`k-before`. This is the upper
  bound for any reranker.
- **rank before → after**: the rank of the first expected chunk in cosine order vs
  after reranking.
- **kept**: how many chunks pass the threshold; **early refusals**: answerable (bad) vs
  unanswerable (good).
- **latency split**: rewrite, embed + search, rerank, answer.

**Calibration** (`rag calibrate`, stage 2): rerank the top 20 for every question and
label each chunk relevant (it matches an expected source) or not. Then print both score
distributions and a sweep: for each threshold, how many answerable questions keep their
relevant chunk and how many unanswerable questions end up with an empty context. The
default is the threshold that keeps every relevant chunk while emptying the most
unanswerable questions. Because it is tuned on the same 15 questions it is then
evaluated on, EVAL.md says so and shows the eval at the neighbouring thresholds too.

## Stages

One branch, `task23/rerank-rewrite`, one commit per stage, one PR at the end (as in
task 22).

1. **base + reranker**: copy task 22, add `sentence-transformers`, `rerank.py`,
   `pipeline.py` with the `base` and `rerank` modes, `ask --show-context` showing
   before/after ranks, and `check` reporting pool recall and the rank before and after
   reranking (`check` had to change anyway: it looped over both strategies). No
   threshold yet (top-5 after rerank). Tests with a fake cross-encoder.
2. **questions + calibration + filter**: write the 5 new questions, add `calibrate`,
   pick the threshold, add the early refusal and the `cos-filter` mode.
3. **query rewriting**: `rewrite.py`, `search_many`, RRF, the `rewrite` and
   `rewrite+rerank` modes, and chat toggles. Tests with a mocked LLM (JSON parsing,
   fallback on bad output).
4. **evaluation**: modes in `evaluate`/`report`, the new metrics, a full run,
   `EVAL.md` with the comparison and a written reading, and the README.

## Setup you need to do

- `ollama serve` with `nomic-embed-text`
- `DEEPSEEK_API_KEY` in the environment or `task23/.env`
- the first rerank downloads `bge-reranker-base` (~1.1 GB) into the Hugging Face cache
