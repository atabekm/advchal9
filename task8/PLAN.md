# Task 8 — Tokens · plan

Task 7 taught the agent to remember. It ends with a conversation that survives
the process holding it, and with a stats bar that says `restored · 6 messages in
memory · no turns this run`.

That line is the opening of task 8. A restored conversation is not free storage.
It is six messages that will be resent, in full, on the next turn and on every
turn after it — and nothing in task 7 says what that costs.

## The idea

Task 7 has four layers. Task 8 adds a fifth and gives it the same treatment: one
job, one rule, and no knowledge of anyone else's job.

```
app.js     the interface   draws the meter, runs the lab
                           never counts anything itself
   |
agent.js   the agent       counts before it sends, decides what to do about it
                           never draws, never guesses at prices
   |
tokens.js  the counter     estimates, calibrates, does window arithmetic
                           never touches the DOM, never sends anything
   |
store.js   the store       unchanged from task 7
   |
api.js     the transport   usage in, cost out
```

The rule that matters: **the agent must know the size of a request before it
makes one.** Everything else follows. If the count only arrives with the reply,
then the only way to find out that a request was too big is to be told so by
somebody who charges for the privilege.

## The three numbers the brief asks for

| | where it comes from | estimate or fact |
| --- | --- | --- |
| the current request | `counter.plan()` before the send | estimate, corrected |
| the whole history | the same, summed per message | estimate, corrected |
| the model's reply | `usage.completion_tokens` | fact |

Only one of the three can be known before the request exists, and it is the one
that does not matter yet. That asymmetry is the point of the panel: two numbers
are predictions the estimator will be judged on, and the third is the bill.

## The estimator, and the honesty problem

There is no tokeniser in the browser and no count-tokens endpoint on this API, so
the count before the send is a heuristic: characters per token, by script, with
per-message framing added. It will be wrong.

So it apologises and improves. Every turn hands `usage.prompt_tokens` back to the
counter, which compares it against what it predicted and keeps the ratio. Two
samples in, the correction is worth having; the panel shows the drift either way.

The offline stub gets its own tokeniser — a word-boundary split, deliberately not
the estimator — so that calibration has something real to learn from with no key
and no bill. If the stub counted the way the estimator predicts, the readout
would always say 0.0% and would be theatre.

## What the window is for

Every model gets a context window and an output ceiling, taken from the real
ones: a million tokens of context, 384K of output. That puts the edge four
megabytes of typing away, so the table also carries `stub-16k` — a 16,384-token
window with a name, marked as not a model, refused by the agent on any live
transport, and there so the edge is reachable in a demo rather than in an
afternoon.

The arithmetic that decides a request:

```
system + history + this message + priming   = prompt
prompt + max_tokens                          = what the window has to hold
```

Reserving the reply is the part that is easy to forget and impossible to skip:
the model needs room to answer inside the same window, so a request that fits by
itself can still be refused.

## What breaks, three ways

The brief asks what happens at the limit. There are three defensible answers and
the config picks one, because they fail in genuinely different places:

- **trim** — drop the oldest turns until it fits. Nothing fails. The model
  quietly stops being able to see the start of the conversation.
- **refuse** — stop before the request. Costs nothing, sends nothing, and is the
  only one of the three that treats the arithmetic as authoritative.
- **send** — let the endpoint say no. A 400, the request wasted, and the exact
  wording a real API uses.

## Stages

### Stage 1 — `stage-1/counter`

`tokens.js`: model table, script-aware estimator, calibration, message ledger,
`plan()`, `fit()`, cost and projection. Pure functions and two small classes; no
DOM, no fetch. `api.js` gives up its price table to it.

### Stage 2 — `stage-2/agent-counts`

The agent takes a counter as a dependency, plans before every send, emits
`tokens:preflight` and `tokens:settled`, and records a per-turn ledger. New
config: `carryHistory`, `historyCap`, `overflowPolicy`. `ContextOverflowError`
for the refusal path.

### Stage 3 — `stage-3/limits`

The echo transport enforces the window and the output ceiling, with the wording
a real endpoint uses, so every failure in stage 2 is reachable offline.

### Stage 4 — `stage-4/panel`

The tokens tab: live meter, per-message ledger, growth chart, per-turn table,
calibration readout, projection. A token count under every bubble and under the
composer as you type.

### Stage 5 — `stage-5/lab`

Three scripted conversations — short, long, and one that does not fit — run
against the current transport and compared in one table.

### Stage 6 — `stage-6/thinking`

Reasoning is on by default on this API at high effort, and declining it means
saying so explicitly, so it becomes a config field (`off / low / high / max`)
where `off` sends `{"type": "disabled"}` rather than sending nothing. The stub
reasons on the same switch rather than on a model name. Reasoning is drawn as its own band
in the chart and totalled under the turn table, because it is output that is
billed, spends the answer's ceiling, and is never shown.

### Stage 7 — `stage-7/readme`

The writing, with the numbers the lab actually produced.

## Risks

- **The panel eating the app.** Six sections in one tab is already a lot. Nothing
  gets added that does not answer a question in the brief.
- **The estimate being taken for a fact.** Every predicted number in the UI is
  shown next to the billed one the moment the billed one exists.
- **The lab costing money.** It defaults to the offline transport and asks
  before spending anything on a live one.
- **Counting becoming the bottleneck.** A conversation is recounted on every
  keystroke; message counts are cached by text, which is safe because a message
  never changes after it is said.
