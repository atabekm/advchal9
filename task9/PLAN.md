# Task 9 — History compression · plan

Task 8 ends with a number and no answer. Twenty turns in, the panel reads:

> the whole conversation, system prompt included, is 5,305 tokens at the end.
> Holding it for those twenty turns billed 60,706 — eleven times its own length.

and the only thing task 8 could do about it was `trim`: drop the oldest turns
until the rest fits. It ran to the end without a single error, and the compare
table said what it had cost:

> nothing failed, but by the last turn the agent was sending 25 fewer messages
> than it holds — the model could no longer see the start

That is the sentence task 9 is about. Trimming is compression with a compression
ratio of zero on everything it touches: the oldest turns do not get smaller,
they get deleted. This task keeps the same token budget and asks the model to
pay for the past in a different currency — a summary — and then measures whether
that actually bought anything.

## Base

Task 8, copied forward. Storage keys move to `task9.*`. The five layers are
unchanged and a sixth goes in between the agent and the counter:

```
app.js     the interface   draws the memory tab, runs the benchmark
                           never decides what to forget
   |
agent.js   the agent       one turn, and now sometimes two requests
                           never writes a summary itself
   |
memory.js  the compressor  what is verbatim, what is summarised, what it saved
                           never touches the DOM, never sends anything
   |
tokens.js  the counter     unchanged: estimates, calibrates, window arithmetic
   |
store.js   the store       now persists summaries beside messages
   |
api.js     the transport   now also answers a summarisation request
```

The load-bearing rule, in the same shape as task 8's: **the agent never sends
the same message at full size twice.** A message is verbatim while it is recent
and prose afterwards, and the moment of transition is a decision somebody has
to own. `memory.js` owns it.

## What goes up the wire

```
system prompt
summary            ← one system message: "Earlier in this conversation: …"
last N messages    ← verbatim, exactly as said
the new user turn
```

The summary is a **system** message, not a fabricated user or assistant turn.
Three reasons: it is not something anybody said, so attributing it to a speaker
is a lie the model will reason from; it is the only message in the payload that
the agent wrote about itself; and it must survive every future fold without
being mistaken for history that can be folded again.

It is stored separately from `messages` — its own record, its own generation
counter — which is the brief's third bullet and also the only way the ledger can
keep saying true things. The conversation on screen is still every message that
was ever said. What is *sent* is the wire above. Those two have been the same
thing since task 4, and from here they are not.

## Four answers to one question

Task 8 spread "how much of the past goes up the wire" across two fields —
`carryHistory` as a toggle and `overflowPolicy` for the emergency. Task 9 folds
them into one `memoryPolicy` with four values, because they are four answers to
the same question and comparing them is the entire task:

| policy | what is sent | prompt growth | what it costs |
| --- | --- | --- | --- |
| `none` | system + this turn | flat | the agent is amnesiac |
| `full` | everything, forever | linear per turn, quadratic in total | task 8's bill |
| `window` | system + last N | flat | task 8's `trim`: the start is gone |
| `compress` | system + summary + last N | flat, plus a slow-growing summary | a second request, now and then |

`window` is kept deliberately. It is the control. `compress` costs *more* than
`window` — the summariser is a real request and gets billed — so a comparison
that only puts `compress` next to `full` is rigged. The honest question is
whether paying `window`'s price plus a small overhead buys back the recall that
`window` threw away, and that is a question the benchmark below can actually
answer.

## When it folds

Two triggers, one code path:

- **scheduled** — when the number of messages older than the keep-window reaches
  `compressEvery` (default 10), they are folded. This is the brief's "every 10
  messages".
- **pressure** — when `plan()` says the request does not fit and the policy is
  `compress`, fold early rather than waiting for the schedule.

Folding is **rolling**: the input to generation *k* is the generation *k-1*
summary plus the messages evicted since. So a fact stated on turn 2 and still
relevant on turn 40 has been through the grinder four times, and the panel says
so — a `gen 4` badge next to it is the honest label for "this has been
paraphrased four times and nobody checked". Generation loss is not a footnote;
it is the cost of the method and it belongs on screen.

## Compression is not free, and this is where implementations lie

A summary is written by a model, in a second request, with its own prompt and
its own bill. So `memory.js` keeps the arithmetic that most demos skip:

```
saved this turn   = tokens(messages folded away) − tokens(summary)
spent to fold     = summariser prompt + summariser completion, billed
break-even        = spent ÷ saved-per-turn, in turns
```

and the panel states it as a sentence: *"folding cost 431 tokens and saves 1,840
per turn — it paid for itself on the next turn"*, or, for a four-turn
conversation, *"folding cost more than it will ever save: stop compressing"*.
A short conversation with compression on is a conversation paying for a feature
it does not need, and the app should be willing to say that about itself.

The summariser gets a cheap model of its own (`summaryModel`) and a hard output
ceiling (`summaryBudget`, default 256), because a summary with no ceiling grows
until it is the thing it replaced.

## Measuring quality without vibes

The brief says compare "response quality without compression and with
compression". Read a few replies and decide which is nicer, and you have
measured nothing. So quality here is a **recall score**, and it is graded.

The benchmark plants verifiable facts in a scripted conversation — *the dog is
called Kepler*, *the deadline is 4 March*, *the staging box is 10.2.0.7* —
buries them under enough filler turns that a keep-window of six cannot reach
them, then asks about each one at the end and greps the reply for the expected
string.

```
recall = facts answered correctly / facts planted
```

Three runs of the same script, same transport, same model, same questions:

| run | last prompt | billed | cost | recall |
| --- | --- | --- | --- | --- |
| `full` | largest | largest | highest | the ground truth |
| `window` | small | small | low | collapses — the facts were deleted |
| `compress` | small | small + folds | low + overhead | the number that decides this task |

If `compress` lands near `full` at `window`'s price, history compression works
and the numbers say by how much. If it lands near `window`, then the summariser
is throwing the facts away and the honest thing is to publish that table too.

Two traps guard the score. **Confabulation**: some questions ask about facts
that were never stated, and a confident answer scores negative — a summariser
that invents a plausible dog is worse than one that forgets it. **Position**:
facts are planted at the start, the middle, and inside the keep-window, so the
table can separate "compression preserved it" from "it was never compressed in
the first place".

## Reproducible with no API key

Task 8's echo stub emits a canned paragraph about its own token count. That is
fine for counting and useless for recall — you cannot grade an answer from a
transport that never answers anything. Two changes make the whole comparison
runnable offline, for nothing:

**The stub becomes a context oracle.** Asked a question, it searches exactly
what it was handed — system prompt, summary, verbatim messages — and answers if
the fact is in there, and says it does not know if it is not. It is not
pretending to be intelligent. It is a mechanical answer to the only question
this task asks: *was the fact still in the payload?* That makes the recall score
offline a direct measurement of what compression preserved, with no model
judgement in the loop at all.

**The stub summarises extractively, and lossily.** Given messages to fold, it
keeps fact-carrying sentences and drops filler, with a real ceiling — so some
facts genuinely fall out, exactly as they do upstream. A stub summariser that
kept everything would score 100% forever and would be measuring nothing, which
is the same reasoning that gave the stub its own tokeniser in task 8.

Both are honest stand-ins with a stated mechanism, and both are labelled as
stand-ins wherever their numbers appear.

## What breaks

Task 8 catalogued five failures. Compression adds four of its own and they are
the point of the exercise:

- **The fold that loses the fact.** The summariser wrote 200 tokens and the one
  that mattered was not among them. Nothing errors. The agent confidently
  answers wrong three turns later. Only the benchmark catches it.
- **The fold that invents one.** The summary asserts something nobody said, and
  from then on it is in the payload of every future turn, laundered as fact by
  being in the system slot. This is strictly worse than forgetting and the
  confabulation traps exist to price it.
- **The fold that fails.** The summariser request 429s or times out. The rule:
  **nothing is evicted until a summary exists.** A failed fold leaves the
  conversation exactly as it was and the turn proceeds uncompressed. Losing
  messages to a network error is not a trade-off, it is data loss.
- **The summary that grows.** Roll it enough times with no ceiling and the
  summary becomes as long as the history it replaced, and now you are paying for
  both. `summaryBudget` plus a size chart across generations.

## Stages

### Stage 1 — `stage-1/compressor`

`memory.js`: the fold policy, the summary record and its generation chain, wire
assembly, and the savings and break-even arithmetic. Takes a `summarise`
callback rather than a transport — pure, no fetch, no DOM, testable by hand.

### Stage 2 — `stage-2/agent-compresses`

The agent takes a compressor as a dependency. `memoryPolicy` replaces
`carryHistory`; `keepRecent`, `compressEvery`, `summaryModel`, `summaryBudget`
join the schema. The summarisation request goes out as a second, clearly
labelled turn; a failed fold is non-destructive. Events: `memory:fold`,
`memory:summary`, `memory:saved`, `memory:fold-failed`. `store.js` grows a
`summaries` field, schema v2, with a migration that reads task 8 records.

### Stage 3 — `stage-3/offline-truth`

The echo stub becomes answerable: the context oracle and the lossy extractive
summariser, so both halves of the comparison run with no key and no money.

### Stage 4 — `stage-4/panel`

A memory tab: the current summary in full with its generation, the line between
what is verbatim and what is prose, tokens saved per turn, folding overhead,
break-even, and summary size across generations. The task 8 meter gains a
summary band so the composer readout keeps being true.

### Stage 5 — `stage-5/bench`

The recall benchmark: the scripted conversation with planted facts, run under
`full`, `window` and `compress`, graded, and reported in one table that carries
quality and tokens and cost side by side. Confabulation traps and fact-position
breakdown included.

### Stage 6 — `stage-6/readme`

The writing, with the numbers the benchmark actually produced — including the
ones that do not flatter the method.

## Risks

- **A rigged comparison.** The easy version puts `compress` next to `full`,
  declares a 70% saving and never mentions that `window` saves more for less.
  `window` is in every table, always.
- **Quality theatre.** "The compressed answer looks fine" is not a measurement.
  Nothing ships in the quality column that was not graded against a planted
  fact.
- **The stub flattering itself.** An oracle that answers from outside its
  payload, or a summariser that never loses anything, turns the benchmark into
  a formality. Both are built to be lossy on purpose, and both say so on screen.
- **Two requests per turn.** Folding doubles the latency of the turn it happens
  on. It runs before the user's request goes out, is announced in the status
  line, and is counted separately in the ledger so a fold is never mistaken for
  an expensive answer.
- **The panel eating the app.** Task 8's tokens tab already has six sections.
  Memory gets its own tab rather than a seventh section, and nothing goes in it
  that does not answer a bullet in the brief.
