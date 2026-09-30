# Task 22 — First RAG query

Answer a question two ways: straight from the LLM, and from the LLM given the
chunks retrieved from the task 21 index. Measure the difference on 10
questions written for this corpus.

Python 3.13, `uv`. Built on a copy of task 21 (extraction, both chunkers,
Ollama `nomic-embed-text`, SQLite index). DeepSeek for generation.

## Decisions

| | choice | why |
|---|---|---|
| base | copy task 21 into `task22/` (`indexer/`, `tests/`, `docs/`), add a `rag/` package next to it | builds on top; task 21 stays as it was submitted |
| LLM | DeepSeek chat completions (`https://api.deepseek.com`), `deepseek-flash` default, `--model deepseek-v4-pro` | same as task 17; key from `DEEPSEEK_API_KEY` or `task22/.env` (gitignored) |
| retrieval | cosine top-k over the index, `--strategy struct` (default) or `fixed`, `k = 5` | struct chunks are whole sections, so the context reads better; fixed kept for comparison |
| grounding | system prompt: answer only from the numbered context, cite `[n]`, say "not in the documents" when it isn't there | makes hallucination and citation accuracy measurable |
| scoring | keyword check **and** LLM-as-judge (DeepSeek) | keywords are cheap and deterministic; the judge catches paraphrases and wrong claims |

## The pipeline

```
question ──▶ embed ("search_query: " prefix) ──▶ top-k chunks (struct | fixed)
                                                     │
        system rules + [1] source · section · pages  │
                       chunk text                    ▼
                       [2] …                  prompt ──▶ DeepSeek ──▶ answer + [n] citations
                       question
```

Without RAG the prompt is the question alone, with a plain system prompt
("answer concisely; say if you don't know").

## Layout

```
task22/
  docs/                 ← the 3 PDFs from task 21 (gitignored)
  index/index.db        ← rebuilt with `uv run indexer index` (gitignored)
  indexer/              ← copied from task 21 unchanged
  rag/
    llm.py              DeepSeek client (chat, retries, token usage)
    retrieve.py         question → top-k chunks with metadata and scores
    prompt.py           context block and system prompts for both modes
    agent.py            answer(question, mode, strategy, k) → Answer
    evalset.py          load questions.json, keyword scoring, retrieval hit
    judge.py            LLM-as-judge prompt and parsing
    cli.py              `ask`, `chat`, `eval`
  questions.json        the 10 control questions
  EVAL.md               generated comparison + a written reading of it
```

## Commands

```
rag ask  "question" [--mode rag|plain|both] [--strategy struct|fixed] [-k 5] [--show-context]
rag chat [--strategy …]           REPL; /rag on|off, /strategy fixed|struct, /k N
rag eval [--strategies struct,fixed] [--markdown EVAL.md]
```

`ask --mode both` prints the two answers side by side. That is the demo for
the video.

## Control questions (`questions.json`)

```json
{
  "id": "q03",
  "question": "How many hours of speech does the TatarTTS dataset contain?",
  "expect": "about N hours, from M speakers",
  "must_contain": [["70", "seventy"], ["hours"]],
  "sources": [{"source": "docs/1570978467.pdf", "section": "III", "pages": [2, 3]}],
  "kind": "fact"
}
```

- `must_contain`: every inner list must be matched by at least one of its
  alternatives (case-insensitive).
- `sources`: where the answer lives. An empty list means the corpus does not
  answer the question.
- Mix: about 6 **fact** lookups (numbers, names, specific claims), 2 **explain**
  questions that cover a whole section, 1 **multi** question that needs chunks from
  two places, and 1–2 **unanswerable** questions. On those, the RAG mode should
  refuse, and plain mode will likely produce a confident answer anyway.
- Spread across all three documents. The Apertium paper is the one DeepSeek is
  most likely to know already, so it shows where plain mode is enough.

## Evaluation

Per question × mode (`plain`, `rag/struct`, and `rag/fixed` if asked):

- **retrieval hit@k** (RAG only): a retrieved chunk comes from an expected
  source and overlaps its pages. Also the rank of the first hit.
- **keywords**: fraction of `must_contain` groups matched.
- **judge**: DeepSeek gets the question, expectation, and answer, and returns
  `{"verdict": "correct|partial|wrong|refused", "hallucination": bool, "reason": "…"}`.
  For unanswerable questions, `refused` counts as correct. The judge sees
  the expectation only, never which mode produced the answer.
- **citations** (RAG only): the cited `[n]` chunks include an expected source.
- tokens in/out and latency per call.

`EVAL.md`: a per-question table, totals per mode, and a short written reading
(where RAG helped, where it didn't, and retrieval misses vs. generation misses).
Raw answers go to `eval/run-<timestamp>.json` so the judge can be re-run without
calling the LLM again.

Known bias: the judge is the same model that answered. It is acceptable here
because the keyword score is a second, independent signal. The two are shown
side by side, and disagreements are listed.

## Stages

One branch, `task22/rag-query`, one commit per stage, one PR at the end.

1. **base + retrieve**: copy task 21, rebuild the index, add `rag/retrieve.py`
   and `rag ask --show-context` without the LLM (prints the chunks that would be
   sent). Tests still green.
2. **LLM + two modes**: DeepSeek client, prompts, `ask --mode rag|plain|both`,
   `chat` with the `/rag` toggle. Unit tests for prompt building with a mocked
   client.
3. **control questions**: read the three documents, write `questions.json`,
   and run the retrieval check alone (hit@k for struct vs fixed) to confirm
   every answerable question has a findable source before involving the LLM.
4. **evaluation**: keyword scoring, judge, `rag eval`, `EVAL.md`, README.

## Setup you need to do

- `ollama serve` with `nomic-embed-text` (already pulled for task 21)
- `DEEPSEEK_API_KEY` in the environment or `task22/.env`

## What the build changed

- **Retrieval runs before the LLM calls, on one thread.** `Agent.answer` takes
  precomputed `hits`, so `rag eval` embeds and searches serially (the SQLite
  connection stays on its thread) and then runs the 30 LLM calls and 30 judge calls
  in a thread pool.
- **A `rag check` command** (retrieval only, no LLM) came out of stage 3. It showed
  the q08 miss (TatarTTS takes all five slots) before any answer was generated.
- **The questions were not tuned to the index.** q05/fixed and q08 miss in retrieval,
  and they stay that way: they are findings, not bugs in the test set.
- **Page-level hit is coarse.** q04/fixed "hits" at rank 1 on the right page, but
  the chunk with the numbers is the next one. This is noted in EVAL.md and not fixed
  here (fixing it would need a character-span ground truth).
- **The judge is stricter than the keyword check, and sometimes wrong.** Its blind
  spots are listed in EVAL.md; the two scores are read side by side.
- Eval runs are committed under `eval/`, so the report can be rebuilt
  (`--report`) or re-graded (`--rejudge`) without new answers.
