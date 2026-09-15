# Task 11 — The agent's memory model · plan

Three layers, told apart by lifetime and scope rather than by compression, and
a router that says out loud which layer a thing went into and why.

[Task 10](../task10) had five context policies and one lifetime. The window,
the summary chain and the facts all lived inside a single session record and
died with it, which made every one of them a way of answering the same
question: *how much of this conversation goes up the wire?*

This task asks a different question — *which of the things the agent knows are
about this conversation at all?* — and the answer is not a policy. It is three
stores with three different lifetimes, and a rule that decides which one each
new piece of information belongs to.

## The layers

| layer | scope | lifetime | holds | dies when |
| --- | --- | --- | --- | --- |
| short-term | this dialogue | the session | the verbatim message window | the conversation is reset |
| working | this task | the task | goal, constraints, open questions, decisions in flight, artifacts | the task is closed |
| long-term | this user | until retracted | profile, durable decisions, knowledge | someone retracts it |

The table is the whole design. Everything below is a consequence of it.

Two properties make the layers real rather than labelled:

1. **They are stored separately.** Three key namespaces in `localStorage`, not
   one record with a `layer` column. Delete `task11.profile` and the agent
   forgets your name and keeps the task; delete the task record and it forgets
   the deadline and still knows your name. The separation is demonstrable with
   the devtools open, which is the only demonstration worth anything.
2. **Every write names the layer it chose and the rule that chose it.** The
   model proposes a layer, the router decides, and both are shown. Where they
   disagree is the most interesting row on the screen.

## Base

Fresh. Nothing from task 10 is inherited except two files that had nothing to
do with memory in the first place:

- `markdown.js` — the reply renderer, unchanged since task 5
- the DeepSeek half of `api.js` — the streaming reader, the retry
  classification, the error explanations

The summary chain, the branch tree, the token ledger, the calibration and the
graded benchmark do not come across. They answered task 9's and task 10's
questions and they would be scenery here.

There is no offline stub. Every reply and every routing proposal is a live
DeepSeek call, which has three consequences the code has to be honest about:

- **Two requests per turn.** The reply, then a JSON call that proposes memory
  candidates. Both are shown, per turn, with their own cost. Extraction can be
  switched off for a turn that is obviously small talk.
- **The ablation is live and non-deterministic.** Each pass is a real
  conversation. Results are cached to storage so the comparison survives a
  reload and is not re-paid for on every glance.
- **No key means no chat, but not no app.** With an empty key field the
  composer is disabled and says why, and the inspector still works: layers can
  be read, edited and hand-written, so the memory model is demonstrable with
  no money spent.

## layers.js — one interface, three policies

```
layer.put(item)          write, with provenance
layer.get(key)
layer.all()              current items, ranked
layer.block(budget)      the payload block, under its ceiling
layer.snapshot() / .restore(state)
layer.clear()
```

The interface is uniform so that `agent.js` can assemble a prompt without
knowing which layer it is reading from. The policies behind it are not uniform,
and that is the point.

**`ShortTerm`** holds messages, not items. `put` appends, `all` returns the
last `keepTurns` pairs, and nothing is extracted, keyed or ranked — it *is* the
dialogue, and the moment it starts being clever it stops being short-term
memory and becomes a fourth thing. It never touches `localStorage` on its own;
it is saved with the session record and dies with it.

**`Working`** is bound to a task record — `{ id, goal, opened, closed }` — and
holds five kinds:

| kind | what it is | evicted |
| --- | --- | --- |
| `goal` | what the task is for | last |
| `constraint` | what the answer may not do | |
| `open_question` | asked, not yet answered | |
| `decision` | settled inside this task | |
| `artifact` | a name, path or identifier the task produced | first |

Eviction is by kind, then by age. A working layer that evicted the goal to keep
an artifact would have kept the wrong half.

There is always a working layer. Before any task is opened, its goal is `null`
and the panel calls it *unfiled*; opening a task gives the goal a value, and
closing one archives the record and starts a fresh unfiled layer. Holding
candidates in a tray until a task exists would be tidier and would also mean
the agent silently forgets things during the first minute of every session.

**`LongTerm`** is one global record, shared by every session, with three
compartments:

- `profile` — typed fields: `name`, `language`, `tone`, `timezone`, `role`.
  Typed because a profile with free keys becomes a second knowledge store
  within a week, and because the block that goes up the wire wants to read
  "the user's name is Atabek" and not "name=Atabek".
- `decisions` — free keys. Things settled that outlive the task that settled
  them.
- `knowledge` — free keys. Things that are true regardless of any task.

Every long-term item carries `source` (the message it was quoted from),
`first_seen`, `last_confirmed` and `confirmations`. Nothing is evicted by age;
`last_confirmed` is shown, and an item nobody has mentioned in months is
flagged rather than deleted, because an agent that quietly forgets is worse
than one that is visibly out of date.

## extract.js — the contract, and the one rule worth carrying over

Task 10's fact store had six rules and one of them was different in kind:

> a value that is not a verbatim span of a cited message is not a fact

That rule comes across whole. It is checked here, on write, by string
containment against the message named in `from` — not requested in a prompt,
not graded afterwards. It is the only defence against the failure mode that
makes memory worse than no memory: a sentence nobody said, sitting in the
system slot of every future request, where an invention is laundered into a
premise.

The extraction call gets one turn — what the user said, what the assistant
replied — plus the current contents of all three layers, and returns:

```json
{"candidates": [
  {"key": "deadline", "value": "11 March", "kind": "decision",
   "layer": "working", "from": "user", "op": "set"}
]}
```

`layer` is the model's *proposal*. It is recorded and then ignored by anything
that writes. The router decides.

## router.js — the explicit choice

Ordered rules, first match wins, and the match is recorded with the write:

| # | rule | fires when | layer |
| --- | --- | --- | --- |
| 1 | `retraction` | `op: "clear"` | wherever the key lives |
| 2 | `volatility` | no key, or a filler value that restates the window | *dropped* |
| 3 | `profile` | the key is a profile field, or the subject is the user | `long-term.profile` |
| 4 | `knowledge` | `kind: knowledge`, or an identifier with no tie to the task | `long-term.knowledge` |
| 5 | `task_shape` | `kind` ∈ {goal, constraint, open_question, artifact} | `working` |
| 6 | `decision` | `kind` ∈ {decision, agreement} | `working`, marked *promotable* |
| 7 | `fallback` | anything left | `working`, lowest rank |

Rule 6 is the one with an argument behind it. A decision made inside a task
belongs to the task while the task is open — it is the kind of thing that gets
revised twice before lunch, and a revision that has to be chased through the
long-term store is a revision that will be missed. When the task closes, its
decisions are offered for promotion: the ones that outlive the task move to
`long-term.decisions` with their provenance intact, and the rest are archived
with the task. That is the moment the two layers are most obviously different,
and it is the moment the promotion prompt exists to make visible.

Rule 2 is the one that keeps the layers from filling with the dialogue. Most of
what is said in a conversation is only worth remembering for the next two
turns, and short-term memory already has it. Storing it again is not
redundancy, it is a second copy that will still be there after the first one is
correctly forgotten.

Every routing decision is logged as:

```
"11 March" → working · rule 6 (decision) · model proposed long-term
```

and the disagreement column is not hidden, because the disagreements are the
evidence that a choice was made at all.

A manual override — dragging an item from one column to another in the
inspector — is recorded as `rule 0 (manual)`, so the log never claims a rule
made a choice a person made.

## Assembly — three blocks, three budgets

```
system:  the persona
system:  What I know about you            ← long-term, ≤ 160 tokens
system:  The task at hand                 ← working,   ≤ 224 tokens
user/assistant × N                        ← short-term, ≤ keepTurns pairs
user:    this turn
```

Each block is a system message, not a fabricated turn, for the reason task 9
gave and task 10 repeated: nobody said it. It is a record *about* what was
said, and giving it a speaker puts words in the user's mouth that the user will
later be told they used.

Each layer gets its own ceiling and its own eviction order, and the panel shows
what each block cost in tokens this turn. When a block truncates it says so
inside itself.

## The inspector

One panel, five tabs:

- **memory** — three columns, one per layer, every item with its value, its
  kind, its source message, the rule that routed it, and its token cost. Items
  can be edited, retracted or moved between columns by hand.
- **routing** — the decision log, newest first, including the dropped
  candidates and the rejected ones. A candidate that failed the verbatim gate
  is shown with the message it claimed to be quoting.
- **task** — the current task, its goal, its age, the close-and-promote flow,
  and the archive of closed tasks.
- **wire** — exactly what went up on the last turn, block by block, with the
  token cost of each.
- **ablation** — the comparison.

## Verification

The brief asks two questions. Each gets an answer that is a screenshot, not a
claim.

**What lands in each layer?** The memory tab, after a scripted conversation
that deliberately mixes the three: a name and a language preference (profile),
a deadline and two constraints (working), a decision that outlives the task
(promoted on close), and four turns of small talk (dropped by rule 2, and the
routing tab says so).

**How does it affect the answers?** The ablation. The same scripted
conversation, run four times:

| run | long-term | working | short-term |
| --- | --- | --- | --- |
| all | on | on | on |
| no long-term | off | on | on |
| no working | on | off | on |
| short only | off | off | on |

Then the same five questions at the end of each run — *what am I called? what
is the deadline? what did we decide about the database? what language do I
want this in? what are we actually building?* — and the four answer sets side
by side. Results are cached so the table survives a reload.

The second demonstration is cheaper and harder to argue with: **open a new
conversation.** The agent greets you by name, in your language, and knows
nothing whatsoever about yesterday's deadline. One screenshot, two layers
proven.

## Layout

- `index.html`, `styles.css` — the page
- `markdown.js` — carried over from task 5
- `layers.js` — the three stores
- `store.js` — persistence: three namespaces, three lifetimes
- `extract.js` — the extraction contract and the verbatim gate
- `router.js` — the rules and the decision log
- `api.js` — the DeepSeek transport, chat and extraction
- `agent.js` — the turn: assemble, send, extract, route, write
- `ablation.js` — one memory, four configurations, five questions
- `app.js` — the chat and the inspector; not one line of what-is-a-layer
- `test.js` — the rules and the assembly, checked with no network and no key

## Stages

One branch, one commit each.

### Stage 1 — the three layers
`layers.js`, `store.js`. The stores, their interfaces, their eviction orders,
three key namespaces, snapshot and restore. No UI, no model. Proven by deleting
one key and observing exactly what is lost.

### Stage 2 — the router
`extract.js`, `router.js`. The extraction contract, the verbatim gate, the
seven rules, the decision log. Still no model: the router is a pure function
from candidates to writes and is tested by hand-built candidates.

### Stage 3 — assembly
`api.js`, `agent.js`. The DeepSeek transport, the three-block prompt, the turn
loop, the second request per turn. First working chat.

### Stage 4 — the inspector
`index.html`, `styles.css`, `app.js`. The chat pane, the five tabs, manual
overrides, per-block token costs.

### Stage 5 — promotion and decay
Task open and close, promotion of surviving decisions, retraction,
`last_confirmed`, the stale flag, the cross-session demonstration.

### Stage 6 — the ablation
Layer switches, the scripted run, the five questions, the cached comparison
table.

### Stage 7 — the writing
`README.md`. What landed in each layer, what the router dropped and why, the
ablation, and the places the model proposed a layer the rules overruled.

The stages landed as planned, with three changes worth naming. Rule 4's "an
identifier with no tie to the task" became the simplest form of that test —
*is a task open at all* — because every richer version was a similarity
measure pretending to be a rule. The ablation's probes are asked in a fresh
conversation rather than at the end of the scripted one, because probes asked
in sequence can be answered from each other's replies and the column would
then be measuring the transcript. And `test.js` was not in the plan: once
`plan()` was split from `commit()` so the rules could be exercised without a
model, writing the checks was cheaper than not writing them.

## Risks

- **The router is rules over a model's opinion, and the model's opinion is
  often better.** Mitigated by showing both and letting a person override
  either. The point of the task is an *explicit* choice, not a correct one, and
  a rule that can be seen being wrong is still better evidence than a model
  that is quietly right.
- **Two requests per turn doubles the latency.** Extraction runs after the
  reply is streamed, so the user is never waiting on it; it lands in the panel
  a second later.
- **The verbatim gate rejects good facts.** It will. Task 10 measured this and
  the rejected column is kept here for the same reason: a rejection is visible
  and a confabulation is not.
- **The profile is global and the demo machine is shared.** Everything is in
  `localStorage` under `task11.*` and there is a button that deletes all three
  namespaces at once.
