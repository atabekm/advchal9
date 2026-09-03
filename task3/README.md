# DeepSeek CLI — four ways to reason

Task 1 asked DeepSeek a question. Task 2 controlled the shape of the answer.
Task 3 asks the *same question four different ways* and checks which way was
right:

| Method | What the model is given |
| --- | --- |
| `direct` | the problem, and nothing else |
| `steps` | the problem, plus `"Solve this step by step."` |
| `meta` | a prompt it wrote for itself, then the problem under that prompt |
| `experts` | three personas answering independently, then a chair reading all three |

Four methods, but **seven graded rows** — each expert is scored on its own as
well as through the chair, because the interesting failure is one expert being
right and the chair following the other two.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env    # then paste your key into .env
```

Get a key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).

## Usage

```bash
python main.py                          # the problems, and how to run them
python main.py --problem trap           # four methods, one problem, streamed
python main.py --problem all            # every problem, in parallel
python main.py --problem trap --runs 5  # five runs, scored k/5
python main.py "your question"          # your own problem, ungraded
python main.py "your question" --expected 42
python main.py --problem trap --show-prompts     # the exact messages sent
python main.py --problem trap --method direct --method experts
```

One problem streams as it arrives; a sweep runs in parallel and prints only the
tables, because eight interleaved streams are unreadable. Every run is saved to
`runs/<timestamp>.json` with the raw responses, so nothing below has to be
taken on trust.

## The problems

Four problems, each with an answer **computed in `problems.py`, never typed
in** — a hand-written ground truth is exactly as fallible as the model it
grades, and silently so. (Writing the trap, my own first answer was wrong.)

| Problem | Answer | Computed by | What it is for |
| --- | --- | --- | --- |
| `trap` | 3 | breadth-first search | one word of a famous puzzle changed |
| `count` | 4001 | enumeration over 1..10000 | several steps, no trap |
| `logic` | tea | brute force over 576 worlds | nothing to recall, must be searched |
| `easy` | 6 | Legendre's formula | **control** |

`trap` is the classic wolf/goat/cabbage crossing with one alteration: **the
boat carries two items, not one.** Recall says 7. Reading says 3.

The control is the load-bearing one. Without it, four methods all scoring 4/4
reads as a null result. With it, you can say the methods are *indistinguishable
on easy problems and two points apart on `trap`* — which is a finding, and the
one this task actually produced.

## Observed results

`deepseek-chat`, one run per method, all four problems — the real output:

```
────── summary: 4 problems ───────────────────────────────────────────
  method                trap   count   logic    easy    score   tokens
  direct                   ✗       ✓       ✓       ✓      3/4     2123
  steps                    ✗       ✓       ✓       ✓      3/4     1946
  meta                     ✓       ✓       ✓       ✓      4/4     2427
  experts:analyst          ✓       ✓       ✓       ✓      4/4     3834
  experts:engineer         ✓       ✓       ✓       ✓      4/4     4522
  experts:critic           ✓       ✓       ✓       ✓      4/4     3386
  experts:chair            ✓       ✓       ✓       ✓      4/4    12874
```

**Only one column discriminates.** `count`, `logic` and `easy` are solved by
every method including the bare one, so three quarters of this table is a
ceiling effect. That is not a wasted run — it is the answer to "are the answers
different?" for most problems, which is *no* — but it does mean the entire
verdict rests on the `trap` column, and one run per method makes that column a
coin flip.

So the same problem, five runs each:

```
────── comparison: trap ──────────────────────────────────────────────
  ground truth: 3   (breadth-first search; the capacity-1 classic needs 7)
  method                  answer    ok   tokens  calls    time
  direct                   3/5/7   3/5     3370      5   27.7s
  steps                      3/7   3/5     3346      5   26.6s
  meta                       3/7   3/5     4483     10   39.4s
  experts:analyst              3   5/5     5563      5   45.2s
  experts:engineer             3   5/5     6436      5   51.7s
  experts:critic               3   5/5     3160      5   29.2s
  experts:chair                3   5/5    16384     20  140.0s
```

The `answer` column is every distinct answer that method gave across its five
runs, and it is the more honest half of the table:

```
direct             3 5 3 7 3      steps            3 3 7 3 7
meta               3 3 3 7 7      every expert     3 3 3 3 3
```

`direct`, `steps` and `meta` are not *worse* so much as **unstable** — each one
gets it right three times in five and lands somewhere else the other two. Every
persona is 5/5, unanimous, with no spread at all.

## Are the answers different? Which was most accurate?

**Different: only where the problem is hard enough to separate them.** On three
of four problems all seven rows agree, character for character in the extracted
answer. Prompting technique bought nothing, because nothing was going wrong.

**Most accurate: the expert personas, at 5/5 — but the cheapest one won.**

```
experts:critic     632 tokens/run     5/5      ← cheapest, and perfect
direct             674 tokens/run     3/5
steps              669 tokens/run     3/5
meta               896 tokens/run     3/5
experts:analyst   1112 tokens/run     5/5
experts:engineer  1287 tokens/run     5/5
experts:chair     3276 tokens/run     5/5
```

The critic persona costs **6% fewer tokens than asking directly** and goes from
3/5 to 5/5. It is not more accurate because it thinks longer — it thinks
*less*, because "assume the obvious answer is wrong, find what this resembles
and how it differs" points the model straight at the altered constraint instead
of walking the whole search.

And the chair — the expensive part, the four-call panel — bought **nothing**.
It scores exactly what its cheapest member already scored, at 5.2× the tokens.
It never had to overrule anyone, because the panel never disagreed. On a
problem where the experts split, the chair would earn its keep; on this one it
is a synthesis of three identical answers.

That is the result in one line: **a well-chosen stance beat both more
instructions and more agents, and cost less than either.**

## The two failures worth reading

**`steps` solved it and kept going.** Its own listed sequence has everything
across by crossing 3, and then it adds four more to reach the answer it
remembers:

```
1. Take W and C over          ← all three are across here
2. Return alone
3. Take G over
4. Bring G back
5. Take W and C over
6. Return alone
7. Take G over

That makes 7 crossings.
```

"Step by step" made the reasoning *visible* without making it *correct*. The
steps are individually fine; they are marching toward a conclusion that was
fixed before the first one was written. This is the sharpest thing in the whole
task: a legible chain of thought is not a checked one, and the format that
makes an error easy to spot is not the format that prevents it.

**`meta` wrote the right prompt and then ignored it.** Every self-generated
prompt flagged the changed capacity, including the ones that went on to fail:

> The boat can hold the farmer plus at most **two** of the three items (so
> either 1 item, 2 items, or the farmer alone).

That is the model correctly identifying, in advance, the exact fact it is about
to fall for — bolded, in a prompt it wrote for itself, in a run it then got
wrong. Knowing what matters and not being caught by it are separate abilities,
and only the second one is what a good prompt buys you.

## Grading: an extractor, not a judge

Responses are prose, ground truths are values, so something has to bridge them.
The split is deliberate:

```
model    reads the response, reports what answer it stated
python   compares that value to the ground truth
```

The extractor **never sees the ground truth** and is never asked whether an
answer is correct. Hand a model both and ask "is this right?" and it will
happily rationalise a match — accept a response that mentions 3 in passing and
concludes 7. Extraction is the one job it is genuinely better at than code;
comparison is the one that has to be deterministic.

An earlier draft did the extraction with a regex, and that was worse for a
non-obvious reason: heuristics like "the last number in the text" misfire more
often on long responses than short ones, and the expert panel writes the long
ones. **A grader whose error rate tracks response length manufactures exactly
the method difference this task is trying to measure.** An LLM reads a one-line
answer and a five-paragraph answer the same way.

Every extraction is logged next to its raw response in `runs/*.json`, and each
failure above was read by hand before being written up. The `6` and `5` that
`direct` and `steps` scored are not misgrades — those responses really did box
those numbers.

## Why the personas are stances, not job titles

A panel of "mathematician, physicist, economist" cannot be pointed at a river
crossing. A panel defined by *how it approaches a problem* can be pointed at
anything:

| Persona | Stance |
| --- | --- |
| Analyst | understand it exactly as written — quote every condition, note what differs from the usual shape |
| Engineer | construct it mechanically — enumerate, simulate, compute; never recall |
| Critic | assume the obvious answer is wrong; name the likely mistake, then avoid it |

Because the trio is fixed across all four problems, a difference between rows
is a difference between *methods* rather than between panels tuned per problem.
And the critic's brief ends with *"if you check carefully and find no trap, say
so plainly — do not invent one"*, which is what keeps it useful on `easy`: a
persona that manufactures a problem on the control question is overfitted to
the trap.

The three run **independently**, on the problem alone. Letting the critic read
the other two first would sharpen its critique but make its row incomparable to
theirs — it would be answering a strictly easier question. Cross-reading is the
chair's job, and the chair is scored separately so you can see whether it
helped.

## What the prompts do and do not contain

None of the four methods asks for a particular answer format. A "state your
answer on the last line" instruction would make grading trivial, but `direct`
is meant to be the request with *no* additional instructions, and a formatting
rule added to all four to keep them fair is still an instruction that was not
there before. The extractor exists so these prompts can stay as bare as the
task describes. `--show-prompts` prints every message exactly as sent.

## Layout

- `main.py` — CLI, the two display modes, the tables, the saved transcripts
- `methods.py` — the four methods, the three personas, the chair
- `problems.py` — the problems, and the code that computes their answers
- `grading.py` — answer extraction and the comparison
- `deepseek_client.py` — HTTP calls, error handling, response metrics
- `runs/` — every run behind every number above

## Changes from task 2

- `deepseek_client.py` — unchanged except for `complete()`, one entry point
  that streams or buffers depending on whether a chunk callback was passed.
  Seven rows times four problems is a lot of calls to write twice.
- `controls.py` is gone; `methods.py`, `problems.py` and `grading.py` are new.
- `--model` still works, but note that `deepseek-reasoner` reasons before
  answering whatever it is asked, which collapses `direct` into `steps` and
  makes the first two rows of every table the same experiment.
