# Task 10 — Context strategies, without a summary · plan

Task 9 bought memory with prose. Every ten messages it paid a model to write
English about the past, and the README ended on what that prose still could not
do:

> Every fact is there and so is a quarter of the filler. An extractive
> summariser ranks sentences; it does not understand that "Fine by me." was
> never worth keeping.

and on the failure mode underneath it:

> a summary sits in the system slot of every future request, where an invention
> is laundered into a premise

This task takes the summariser away. Three strategies remain, none of which asks
a model to describe the conversation: keep the last N and delete the rest, keep
a key/value block of what was actually said, or stop treating the context as a
stack at all and make it a tree. The brief asks for a switch between them and a
comparison. The comparison is the task; the switch is ten lines.

## Base

Task 9, copied forward. Storage keys move to `task10.*`. The six layers stand,
and two files join them — both pure, both on the compressor's side of the line
that keeps DOM and transport out:

```
app.js      the interface   the context tab, the branch switcher, the benchmark
                            never decides what a fact is
   |
agent.js    the agent       one turn, and now sometimes two requests again
                            never writes a fact itself
   |
memory.js   the selector    what goes up the wire, now under five policies
   |                        never touches the DOM, never sends anything
   |- facts.js  the fact store   keys, the verbatim rule, revisions, the ceiling
   |- branch.js the tree         checkpoints, forks, path resolution, switching
   |
tokens.js   the counter     unchanged
store.js    the store       v3: branches and facts beside messages
api.js      the transport   now also answers an extraction request
markdown.js the renderer    unchanged
```

Task 9 left a claim in a comment above `Compressor.select`:

> The four policies differ only here. […] adding a fifth answer later would be a
> change to one function.

Task 10 is the test of that claim. `facts` is the fifth answer and it goes in
that function, or the claim was wrong and the README says so.

## What goes up the wire

| policy | payload | growth | what it forgets |
| --- | --- | --- | --- |
| `none` | system + this turn | flat | everything |
| `full` | system + every message | linear per turn | nothing — including the things that stopped being true |
| `window` | system + last N | flat | anything older than N |
| `compress` | system + summary + last N | flat, plus a slow-growing summary | whatever the summary ceiling cut — task 9 |
| `facts` | system + facts block + last N | flat, plus a bounded block | anything that was never a fact |

`compress` stays in the table. The brief says *without summary*, and the only
way to say that as a finding rather than as obedience is to leave task 9's
answer running in the next column.

Branching is not a row here, and pretending otherwise would be the first lie in
the task. Window and facts answer *how much of the path do we send*. Branching
changes *which path there is*. It composes with the other two — a branch is
still sent under `window` or `facts` — and the panel says so in those words.

## facts.js — six rules, one of which is the whole idea

**1. A value that is not a verbatim span of a message is not a fact.**

Every write cites the message it came from, and the store checks it:

```js
store.write({ key: 'deadline', value: '11 March', source: { index: 22 } })
```

If `11 March` does not occur in message 22 — whitespace collapsed and case
folded for the comparison, never substituted — the write is rejected and counted
as `not-verbatim`. Nothing else in the pipeline can put text in the facts block.

This is the structural version of the plea task 9's summary prompt had to make
in English ("nothing that was not said"). A summariser can only be *asked* not
to invent. A key/value store with provenance *cannot*, and the difference shows
up in the confabulation column.

**2. Keys are canonical, and last write wins.**

`deadline`, `db`, `units`, `budget`. A second write supersedes the first, the
old value moves to `history` with the turn it died on, and only the current
value goes up the wire. This is the one place a strategy can beat `full`: a
conversation that contains both "4 March" and "the demo moved to 11 March"
sends `full` two answers and no way to rank them.

**3. A revision is checked exactly like an original.** No shortcut for updates.

**4. A retraction is a write.** "Forget the budget" clears the key if the
retracting sentence is cited and verbatim. The key is tombstoned, not deleted,
so the panel can show that it was dropped on purpose.

**5. The block is bounded.** `factsBudget` tokens, ranked by last-confirmed
turn, truncated, and the truncation stated inside the block —
`[4 further facts did not fit the 192-token ceiling]`. Task 9's third finding
was a summary growing into the thing it replaced; a fact store with no ceiling
does the same thing more slowly.

**6. A failed extraction never costs a message.** Extraction is additive to the
window, never a reason to trim harder. If the request fails, the turn goes out
with the previous facts block and the log says so — task 9's rule about folds,
unchanged.

Record shape:

```js
{ key: 'deadline', value: '11 March',
  source: { index: 22, turn: 12 }, first: 4, confirmed: 12,
  history: [{ value: '4 March', turn: 4, until: 12 }] }
```

## The extraction turn, and why it is cheaper than a fold

It runs after the user's message and before the answer, as a second labelled
request, counted separately in the ledger — the shape task 9 built for folds.

What it is given is the difference that matters. A fold read the entire history,
so it cost O(n) and could only be afforded every ten messages. Extraction is
given **the new user message and the current key/value list** — nothing else.
That is O(1) in the length of the conversation, which is what makes "after every
user message" affordable at all. It also means the extractor cannot rewrite a
fact it cannot see the source of.

Out comes strict JSON, which is parsed, verbatim-checked against rule 1 and
applied:

```json
{ "facts": [ { "key": "deadline", "value": "11 March", "op": "set" } ] }
```

Every turn paying for a second request is still a real cost, and it is the first
number in the compare table rather than a footnote in it.

## branch.js — the tree

```js
{ id, name, parent, forkIndex, messages: [], facts: {}, created, note }
```

The resolved path of a branch is its parent's path up to `forkIndex`, then its
own messages. The prefix is stored once and shared; a branch owns only what it
added.

- a **checkpoint** is a named index on a branch, so that "two branches from one
  place" is one checkpoint with two children rather than two coincidences
- `fork(checkpoint, name)` snapshots the facts as of that index into the child
- switching sets `head`, and the map, the meter, the facts table and the
  composer all re-read from the resolved path
- **a branch never mutates its parent** — copy-on-write for messages by
  construction, for facts by the snapshot

The property worth building it for: two branches of one conversation hold
contradictory facts at the same time and neither is wrong. Branch A's deadline
is 11 March, branch B's is 4 March, and a leak in either direction is a bug the
benchmark scores.

## The scenario — one script, every strategy

The brief asks for requirements gathering over 10–15 messages, which is a better
script than task 9's planted trivia because the things it plants are the things
the brief says facts are for: a goal, constraints, preferences, decisions,
agreements. Fifteen user messages:

| # | kind | said |
| --- | --- | --- |
| 1 | goal | an internal tool for tracking lab samples |
| 2 | constraint | runs offline in the building, no cloud |
| 3 | decision | first demo is 4 March |
| 4 | filler | |
| 5 | preference | metric units in every report |
| 6 | decision | storage is SQLite |
| 7 | filler | |
| 8 | agreement | you write the schema, I write the import script |
| 9 | constraint | budget 12000 euros, hard |
| 10 | filler | ← the checkpoint |
| 11 | **revision** | the demo moved to 11 March |
| 12 | identifier | staging is 10.2.0.7 |
| 13 | filler | |
| 14 | **revision** | scratch SQLite, Postgres |
| 15 | preference | reports go to the lab manager, nobody else |

Then three question sets, graded by string match, no vibes:

- **recall** — planted early, middle and late, so "the strategy kept it" can be
  told apart from "it was never out of the window"
- **revision** — "when is the demo?", "which database?". The stale answer is
  *wrong*, and it is the only column where `full` can lose
- **traps** — the lab's phone number, what we decided about the mobile app.
  Nobody said either. A confident answer scores against the run

Branch run: fork at message 10, A continues 11–15 as above, B goes the other way
(demo stays on 4 March with scope cut, SQLite stays). Ask the same two questions
in both. Correct is two different answers and no leakage.

## The compare table

| run | last prompt | extraction/fold | billed | recall | stale | invented |
| --- | --- | --- | --- | --- | --- | --- |
| `full` | largest | none | largest | the ground truth | the column it can lose | |
| `window` | small | none | smallest | collapses — deleted | n/a, it sees neither | |
| `compress` | small | O(n), every 10 | small + folds | task 9's number | | can invent |
| `facts` | small | O(1), every turn | small + extractions | the number this task turns on | should be zero | cannot, by rule 1 |

Plus a branch table: the two branches' answers side by side, the leak count, and
the prompt cost of branch B's first turn against the alternative — a fresh
session that has to be told all ten messages again.

## Reproducible with no API key

Same rule as task 9: half this brief is response quality, and a quality
comparison that needs a paid key is a comparison nobody runs. The echo stub
gains a deterministic extractor — pattern-matched key/value candidates, cited
and verbatim by construction — and its oracle learns to read a facts block and
to prefer a current value over a superseded one. Both halves say on screen which
extractor produced the numbers, because a stub that never invents anything makes
the confabulation column meaningless and the panel should admit that.

## What survives a restart

| | survives | why |
| --- | --- | --- |
| messages | yes | it is the conversation |
| the branch tree and the head | yes | it *is* the conversation now |
| facts, with provenance and history | yes | the other half of it |
| the ledger, rejected-write counts, the chart | no | they measure this run |

`store.js` goes to v3. A v2 record is not corrupt, it is older: it loads as a
single `main` branch with no facts.

## Stages

One branch, one commit per stage.

### Stage 1 — the fact store

`facts.js`: the store, the verbatim rule, revisions and history, retraction,
the ceiling and its eviction order, snapshot/restore. Pure — no transport, no
DOM, no idea what a message is beyond the text it was handed.

### Stage 2 — the fifth answer

`memory.js` gains `facts` inside `select()` and a facts block in `wire()`. The
agent runs the extraction request after every user message, labelled and counted
separately; a failed extraction is non-destructive. Config: `factsBudget`,
`factsModel`. Events: `facts:extract`, `facts:write`, `facts:rejected`,
`facts:failed`.

### Stage 3 — the tree

`branch.js` and `store.js` v3: checkpoints, forks, path resolution, switching,
copy-on-write facts, and the v2 migration.

### Stage 4 — offline truth

The stub's extractor, and the oracle taught to read a facts block and to rank a
current value over a superseded one.

### Stage 5 — the context tab

The memory tab becomes the context tab: the strategy switch, the map of what
goes up the wire, the facts table with provenance and revision history, the
branch tree with its switcher, and the rejected-write counter. The meter gains a
facts band so the composer readout keeps being true.

### Stage 6 — the benchmark

The requirements script under `full`, `window`, `compress` and `facts`; recall,
staleness and confabulation graded; the branch run and its leak test; one table
carrying quality and tokens and cost together.

### Stage 7 — the writing

The writing, with the numbers the benchmark produced, including the ones that do
not flatter facts.

### Stage 8 — both halves of the dialogue

Extraction reads the turn, not the message. The brief's block holds the
important data *of the dialogue*, and an agreement is two-sided: half of what
gets settled is settled in the reply. The risk that reopens — a sentence the
model invented, quoted back to it later as established — is closed by provenance
instead of by omission: a role on every fact, a mark in the block, a contract
clause against taking anything the reply was only offering, and the rule that a
quotation is not a statement.

### Stage 9 — the key that is about nothing

A second door beside the verbatim rule, failing in the opposite direction: a
value genuinely said, filed under a key that is about nothing. `that = firm`.
The rule is that a key must name what the value is about, enforced in the store
and stated in the contract, and the stub stops falling back to noise words when
a phrase has no content words left in it.

## Risks

- **Facts costing more than they save.** A request per user message against a
  fold per ten. If the billed column says facts lost, that is the finding and it
  goes in the first paragraph, not the last.
- **A rigged comparison.** `window` is in every table and so is `compress`.
  "Without summary" has to be measured against the summary to mean anything.
- **The stub flattering the verbatim rule.** A stub extractor that invents
  nothing proves nothing about a real model. The rejected-write counter is on
  screen for exactly this, and the panel names the extractor beside it.
- **Branching as decoration.** A branch switcher that only changes what is drawn
  is a UI feature, not a context strategy. It earns the third slot by changing
  the payload, and the leak test is the proof.
- **Key drift.** An extractor free to name its own keys writes `deadline`,
  `due_date` and `demo date` for one fact and the store holds three. Keys are
  normalised and the key list goes out with every extraction request so the
  model is choosing from a menu, not inventing one.
- **The panel eating the app.** One tab, not a seventh section; nothing in it
  that does not answer a bullet in the brief.
