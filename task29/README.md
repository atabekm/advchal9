# Task 29: optimizing a local LLM for one task

The task is task 27's RAG **answer step**. The model gets 5 retrieved passages and a question,
and replies with JSON: an answer with `[n]` markers, word-for-word quotes that back it, or
`"status": "unknown"` with a clarifying question when the passages don't answer it. It ran on
`qwen3:8b` as pulled, through Ollama 0.33.2, on an M1 Pro with 32 GB.

The optimization started from Ollama's defaults and changed one thing at a time: thinking,
temperature, output cap, context window, prompt template, quantization, model size and KV cache.
It ends as **`qwen3-rag`**, a model built from a [`Modelfile`](Modelfile): `qwen3:4b` with the
tuned prompt and parameters baked in.

## Result

| | before: `qwen3:8b`, Ollama defaults | after: `qwen3-rag` |
|---|---:|---:|
| fully correct answers (21 questions) | 56% | **67%** |
| quotes that really are in the cited passage | 79% | **98%** |
| facts found in the answer (answerable questions) | **86%** | 79% |
| "I don't know" when it should (6 questions) | 67% | 67% |
| valid answer JSON | 98% | 95% |
| median time per answer | 29.0 s | **9.5 s** |
| time to first token (prefill) | 6.5 s | **3.7 s** |
| generation speed | 22 tok/s | **40 tok/s** |
| whole eval set, one pass | 628 s | **218 s** |
| memory (Ollama's allocation, `/api/ps`) | 9.2 GB | **3.6 GB** |
| context window | 32,768 (Ollama's pick) | 8,192 |

It's 3× faster and uses 2.5× less memory, and it's at least as accurate. The baseline finds more facts
because it thinks: it spends ~480 tokens reasoning before every answer. But it pays for
that with paraphrased or "..."-shortened quotes that fail verification, and with twice the time.

```bash
ollama pull qwen3:4b
uv run bench modelfile && ollama create qwen3-rag -f Modelfile
curl -s localhost:11434/api/chat -d '{"model": "qwen3-rag", "think": false, "stream": false,
  "messages": [{"role": "user", "content": "Passages:\n\n[1] ...\n\nQuestion: ..."}]}'
```

`think: false` and the JSON schema ([`TUNED_SCHEMA`](opt/prompts.py)) are fields of each request,
so they can't go into a Modelfile. The client still sends them.

## Watching it: `bench demo`

One question through several variants (default: `baseline` and `qwen3-rag`), streamed live:

```bash
uv run bench demo q04                       # an eval question: frozen passages, scored against the expected answer
uv run bench demo q09 baseline 4b tuned-think
uv run bench demo "How many speakers recorded the TatarTTS dataset?"   # any question: retrieved live first
```

For each variant, every model is unloaded first, so each one starts cold as in the benchmark.
The reply streams in, with qwen3's thinking dimmed and then the JSON. After it come the parsed
answer, each quote ✓/✗ against its passage, the timings (load, prefill, tokens/s) and what
`ollama ps` reports (memory, context). A comparison table closes the run. Nothing is saved:
`results/` only changes with `bench run`.

## How it's measured

- **Fixed passages.** [`bench freeze`](opt/freeze.py) retrieves once per question (task 27's
  rerank mode: nomic-embed-text cosine top 20 → bge cross-encoder → top 5, no LLM rewrite) into
  `contexts.json`. Every variant answers from the same passages, so only the generation changes.
  The unanswerable questions get passages too: the model has to say "I don't know" itself.
- **21 questions** ([`questions.json`](questions.json)): task 27's 10 plus 13 new ones across
  the three documents. They include arithmetic from Gutless's formulas, a weight in kilograms
  for a formula in pounds, three questions the corpus doesn't answer, and one ambiguous one.
  Two were dropped because no model could answer them from their passages: q08 (multi-document,
  needs task 27's query rewrite) and q25 (its chunk ends just before the answer). Retrieval
  isn't what is being compared here.
- **Rule-based scoring, no LLM judge** ([`opt/score.py`](opt/score.py)):
  - The reply must parse as task 27's answer JSON (`cited.parse`).
  - The answer must contain the expected facts (`must_contain`).
  - Every quote must match its passage at ≥ 90% (task 27's `verify`).
  - A cited passage must be from the expected document and page.
  - For unanswerable questions, the status must be `unknown`.

  "Correct" means all of these hold. The score is 0.5 × facts + 0.25 × quotes + 0.25 × source.
- **Single attempt.** Task 27 retries once with the error. Here, the first reply is what counts.
- **Speed and memory** come from Ollama's own timings (load, prefill, generation) and `/api/ps`.
  Each variant starts with all models unloaded. Variants that sample (temperature 0.6) ran 3
  times and greedy ones once. Speed is taken from the first pass only: on a repeat,
  llama-server's prompt cache skips the prefill (0.05 s instead of ~6.5 s).

## All variants

`uv run bench report` (full per-question grid: `--per-question`):

| variant | change | correct | facts | quotes ✓ | IDK right | valid JSON | median s | gen tok/s | memory GB | ctx |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | Ollama defaults, naive prompt | 56% | 86% | 79% | 67% | 98% | 29.0 | 22.1 | 9.2 | 32768 |
| no-think | thinking off | 54% | 68% | 91% | 67% | 95% | 14.3 | 22.1 | 9.6 | 32768 |
| temp0 | + temperature 0 | 52% | 68% | 91% | 67% | 95% | 14.9 | 22.3 | 9.6 | 32768 |
| cap | + num_predict 1024 | 52% | 68% | 91% | 67% | 95% | 14.9 | 22.3 | 9.6 | 32768 |
| ctx4k | num_ctx 4096 | 52% | 68% | 91% | 67% | 95% | 14.6 | 22.2 | **5.5** | 4096 |
| ctx8k | num_ctx 8192 | 52% | 68% | 91% | 67% | 95% | 14.8 | 22.4 | 6.2 | 8192 |
| ctx16k | num_ctx 16384 (task 27) | 52% | 68% | 91% | 67% | 95% | 14.9 | 22.3 | 7.3 | 16384 |
| task27 | task 27's prompt, JSON mode | 62% | 75% | 100% | 67% | 95% | 14.4 | 22.0 | 6.2 | 8192 |
| tuned | tuned prompt + JSON schema | 57% | 74% | 97% | 67% | 95% | 16.7 | 22.7 | 5.8 | 8192 |
| tuned-rules | + a rule per remaining failure | 62% | 72% | 100% | 67% | 95% | 18.8 | 22.3 | 6.2 | 8192 |
| tuned-check | + a "check" field before the JSON | 62% | 73% | 92% | 67% | 95% | 15.8 | 22.3 | 6.2 | 8192 |
| tuned-think | tuned, thinking on | 57% | 73% | 87% | **83%** | 90% | 32.1 | 22.0 | 6.2¹ | 8192 |
| q8 | tuned on Q8_0 (8.9 GB weights) | 62% | 76% | 95% | 67% | 95% | 18.4 | 19.4 | 9.6 | 8192 |
| **4b** | tuned on `qwen3:4b` Q4_K_M | **67%** | **79%** | 98% | 67% | 95% | **9.5** | **40.1** | **3.6** | 8192 |
| 4b-think | `qwen3:4b`, thinking on | 52% | 53% | 100% | 83% | 67% | 94.8 | 37.0 | 3.5 | 8192 |
| kv-q8 | tuned, KV cache q8_0 + flash attention | 57% | 63% | 97% | 67% | 95% | 17.6 | 20.2 | 5.7 | 8192 |
| **qwen3-rag** | Modelfile: `qwen3:4b` + tuned prompt + parameters | **67%** | **79%** | 98% | 67% | 95% | **9.5** | **39.9** | **3.6** | 8192 |

¹ `/api/ps` came back empty for this run. It's the same model and context as `tuned`. Its
prefill was also partly served from the prompt cache, so its time is if anything understated.

### Parameters

- **Thinking** is the biggest cost. It doubles the time per answer (~480 tokens of reasoning, then
  the answer). In exchange it finds more facts (86% vs 68%) and does the arithmetic right
  (220 lb at 25% fat → 165 g of protein, 3/3). But it also paraphrases quotes more (79% verified
  vs 91%). With the tuned prompt, thinking is the only setting that recognized the ambiguous
  "What did the evaluation show?" and asked which evaluation was meant. On `qwen3:4b` it's
  unusable: 7 of 21 answers hit the 4096-token cap mid-thought (~17k characters) with no JSON.
- **Temperature 0** costs nothing in quality and makes runs reproducible: one greedy pass instead of
  three samples. At 0.6 the same question flips between right and wrong (q04 1/3, q06 1/3, q23 1/3).
- **`num_predict` 1024** changed nothing here: without thinking no answer came near it. It's a
  safety net against a runaway generation, not a speed-up.
- **Context window**: identical answers from 4k to 32k, because the prompts are ~1.6–3.3k tokens.
  The cost is memory: Ollama picked 32,768 by itself (9.6 GB), 8,192 takes 6.2 GB and 4,096 takes 5.5 GB.
  Speed is the same: the KV cache is allocated up front, but attention only covers the tokens in use.
  The final model uses 8k, which leaves room for the longest prompt plus the 1024-token cap.
  4k would cut it close.

### Prompt template

- **naive → task 27's prompt** fixed the format failures. The naive prompt with thinking off gave
  invalid JSON on q20 and missed q06. Verified quotes went from 91% to 100% and correct answers
  from 52% to 62%.
- **The tuned prompt** asks for the citations *first* (the JSON schema puts `citations` before
  `answer`), so the model copies the quotes and then writes the answer from them. It also has
  one worked example and an explicit unit-conversion step. A JSON schema in `format`, instead of
  free JSON mode, constrains the decoding to the four fields and the two status values.
- **More rules made it worse, or no better.** `tuned-rules` adds a rule for each remaining failure:
  - a value for a neighbouring table row is not the answer;
  - "the evaluation" without saying which one means ask;
  - write the calculation out.
  
  `tuned-check` adds a reasoning field before the JSON (the trick that fixed task 27's condense
  step). Neither fixed the failures it targeted, and each broke something else. Adding one sentence
  (about `[7]`-style references) to the tuned prompt moved q04 and q23 under greedy decoding. So
  on 21 questions, differences of ±2 between prompts are noise. Only these effects are clear:
  - structured prompts beat the naive one;
  - quotes are verified 97–100% of the time instead of 79–91%;
  - the format failures go away.
- **Still failing everywhere** (prompt-proof on these models):
  - q11 copies the paper's own reference `[7]` into the answer, and the parser rejects it. Task 27's
    retry fixes this in the app.
  - q31 reports Kazakh–*Turkish*'s BLEU 0.17 as Kazakh–Tatar's.
  - q16 picks one evaluation, unless thinking is on.
  - q26 and q28 give partial explanations that leave out a key term (the language model, Piper).
  - q23 mostly multiplies kilograms by the pounds formula. It was right under `tuned-check` and `q8`,
    which is noise in the conversion step, not a fix.

### Quantization and model size

- **Q8_0** (8.9 GB of weights instead of 5.2) gave no measurable quality gain (62% vs 57–62%) and
  generated 12% slower (19.4 tok/s): generation on Apple silicon is memory-bandwidth bound, and
  there are more bytes per token. It needs 9.6 GB.
- **`qwen3:4b`** (Q4_K_M, 2.5 GB) was as accurate as the 8B on this task, or better: 67%, best facts,
  98% verified quotes. It's twice as fast at generation (40 tok/s) and 1.7× faster at prefill
  (558 tok/s), and needs 3.6 GB. The task is copying and summarizing short passages. A smaller
  model does that just as well, and the 8B's extra knowledge doesn't help when the answer
  must come from the passages.
- **KV cache q8_0** (a second `ollama serve` with `OLLAMA_KV_CACHE_TYPE=q8_0`; flash
  attention is already `auto` in this build) saves almost nothing at 8k context (5.8 → 5.7 GB).
  The cache is small next to the weights at this size. It was slower (20 tok/s), and facts fell to 63%.
  It would matter for long contexts, not here.

## Run

```bash
ollama pull qwen3:8b && ollama pull qwen3:8b-q8_0 && ollama pull qwen3:4b && ollama pull nomic-embed-text
cp ../task27/index/index.db index/ && cp ../task27/docs/*.pdf docs/     # task 27's corpus and index

uv run bench freeze                     # retrieve once → contexts.json (downloads the reranker once)
uv run bench list                       # the variants
uv run bench run                        # all of them → results/<variant>.json (~2 h)
uv run bench run 4b qwen3-rag -q q22    # some variants, some questions
uv run bench report --per-question
uv run bench rescore                    # after an edit to questions.json or the scorer, without rerunning the model
uv run bench modelfile && ollama create qwen3-rag -f Modelfile
uv run pytest -q

# the kv-q8 variant needs a second server:
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 ollama serve
```

Speed numbers need a quiet machine. Two runs taken while a browser was busy dropped to 13 tok/s
(and in one case 0.3 tok/s), and a `llama-server` start timed out, so they were rerun.

## Files

- `opt/variants.py`: every configuration compared, and the Modelfile generator
- `opt/prompts.py`: the naive, task 27 and tuned templates (three versions), and the JSON schemas
- `opt/ollama.py`: `/api/chat` (plain or streamed) with options, `think`, `format` and Ollama's timings; `/api/ps`; unloading
- `opt/bench.py`: runs a variant over the frozen passages and saves every reply with its scores and timings
- `opt/score.py`: the rule-based checks
- `opt/report.py`: the tables above
- `opt/demo.py`: `bench demo`, one question streamed through several variants
- `opt/freeze.py`: one-time retrieval
- copied from task 27: `cited.py` (answer JSON parser), `verify.py` (quote check),
  `evalset.py`, `rerank.py`, `embed.py`, and the `Hit` record in `hits.py`
- `results/`: the saved runs, including the raw replies
- `Modelfile`: `qwen3-rag`
