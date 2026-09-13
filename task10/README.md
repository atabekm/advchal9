# The agent that keeps the point

[Task 9](../task9) bought memory with prose, and its README ended on the two
things prose could not be argued out of:

> Every fact is there and so is a quarter of the filler. An extractive
> summariser ranks sentences; it does not understand that "Fine by me." was
> never worth keeping.

and, more seriously:

> a summary sits in the system slot of every future request, where an invention
> is laundered into a premise

This task takes the summariser away. Three strategies remain, none of which asks
a model to write English about the past: keep the last N messages and delete the
rest, keep a key/value block of what was actually said, or stop treating the
conversation as a stack and make it a tree.

The switch between them is ten lines. The comparison is the task.

## Running it

Open `index.html`. No server, no build, no dependencies — the same as
[task 4](../task4) through task 9. Storage keys are namespaced `task10.*`.

Everything below is reproducible on the **echo** transport with no API key and
no money, including every number in every table.

## Three answers, and one of them is a different question

| policy | payload | growth | what it forgets |
| --- | --- | --- | --- |
| `none` | system + this turn | flat | everything |
| `full` | system + every message | linear per turn | nothing — including the things that stopped being true |
| `window` | system + last N | flat | anything older than N |
| `compress` | system + summary + last N | flat, plus a slow-growing summary | whatever the summary ceiling cut — task 9 |
| `facts` | system + facts block + last N | flat, plus a bounded block | anything that was never a fact |

`compress` is still in the table. The brief says *without a summary*, and the
only way to say that as a finding rather than as obedience is to leave task 9's
answer running in the next column.

Branching is not a row here, and pretending otherwise would be the first lie in
the task. `window` and `facts` answer *how much of the path goes up the wire*.
Branching changes *which path there is*. It composes with both — a branch is
still sent under `window` or under `facts` — and the panel says so in those
words.

Task 9 left a claim in a comment above `Compressor.select`:

> The four policies differ only here. […] adding a fifth answer later would be a
> change to one function.

It was nearly right. `facts` touches four functions — `select`, `wire`, `map`
and the counterfactual — which are the four that already knew a policy existed.
Nothing in `memory.js` has an opinion about what a fact is.

## The rule

A summary can contain a sentence nobody said. The prompt that produces it can
*ask* it not to — task 9's did, in clause three — and the asking is all you have.

A key/value store with provenance does not have to ask:

> a value that is not a verbatim span of a cited message is not a fact

It is checked on write, by string containment, in one function in `facts.js`.
Case and whitespace may differ, because they carry no information a fact depends
on, and curly quotes are folded because rejecting a fact over an apostrophe
would be absurd. Nothing else is normalised: "4th of March" does not match
"4 March", and must not — substitution is exactly what the rule exists to catch.

Whatever writes to the store — a real model, the offline stub, a test — cannot
put text in it that nobody said. So the confabulation column in the benchmark is
a consequence of a function rather than of an instruction, and that is the whole
argument for structure over prose.

Five rules stand behind it:

- **keys are canonical, and the last write wins.** Only the current value goes
  up the wire. Superseded values are kept for the panel, and this is the one
  place a strategy can beat `full`
- **a revision is checked exactly like an original.** No shortcut for updates
- **a retraction is a write.** "Forget the budget" clears the key only if the
  retracting sentence is cited and verbatim, and the key is tombstoned rather
  than deleted, so it reads as dropped on purpose rather than lost
- **the block is bounded, and says so inside itself when it truncates.** A
  silent truncation is task 9's summary losing a fact without telling anyone
- **the eviction order is the brief's own list** — goal, constraint, agreement,
  decision, identifier, preference — so a goal stated once at the start outranks
  a preference restated twice. Ranking by recency alone gets exactly that case
  wrong, and the goal is usually both the oldest thing in the conversation and
  the most important

## Extraction is O(1), which is the whole cost argument

A fold read the entire history. That is why it cost O(n) and could only be
afforded every ten messages. Extraction is handed **one turn and the current key
list** — nothing else, and specifically not the conversation:

```
Known facts:
demo = 4 March
database = SQLite

Turn 11.
The user said:
Change of plan — the demo moved to 11 March.
The assistant replied:
Noted — I will move the staging refresh to match.
```

It costs the same on turn two and on turn two hundred, which is what makes
"after every user message" something other than a slogan. The key list is not
decoration: it is how a revision finds the key it is revising, and without it a
store ends up holding `demo` and `first_demo` and believing both.

It runs *after* the turn is answered and remembered, not before. A fact cites
its message by index, so it may only be written once that message has one —
otherwise a turn that died at the transport would leave the store quoting a
message the conversation never kept. And before the transport answers, half the
turn does not exist yet.

And like a fold, it cannot cost a message. A 429 leaves the previous block
standing, the turn goes out with a staler set of facts, and the log says so.

## Both halves of the dialogue

The brief asks for a block holding the important data **of the dialogue** —
goals, constraints, preferences, decisions, agreements — and an agreement is
two-sided by definition. Half of what gets settled in a requirements
conversation is settled in the reply: the date the agent commits to, the number
it worked out, the wording both sides then treat as agreed. A store that reads
only the user's half keeps half of an agreement and calls it the agreement.

Reading the reply reopens the risk this file exists to close — a sentence the
model invented, quoted back to it later as something established. It is closed
again by provenance rather than by omission:

- every fact records **which of the two messages** it came from, and the
  extractor may only choose between those two. The quote is checked against the
  one it named, with no falling back to the other: "it is in one of them
  somewhere" is not provenance
- the block **marks** what the agent settled, and the header says so once:
  `* ready_two = have it ready two days before the demo`. A model reading its
  own block can tell "you committed to this" from "the user told you this"
- the contract forbids taking anything the reply was merely offering, guessing
  at, or asking about, and **a quotation is not a statement**: a reply that
  repeats the user has said nothing of its own

That last rule was not in the first version and the benchmark found it within a
minute. The stub echoes the user's message back under a `>` marker, so
"Agreed: you write the schema" arrived in the reply and was filed as something
the *agent* had settled. The verbatim rule cannot catch it — the words really
are in both messages — so the fix is at the same level as the rule: a value that
also appears in the user's half of the turn is an acknowledgement, and
acknowledgements are not stored.

The cost is real. Reading both halves put the extraction bill up by about half
again, because a reply is usually longer than the message that prompted it.

## What the benchmark says

Sixteen messages of requirements gathering — a goal, constraints, preferences,
decisions, agreements — with two of them revising something stated earlier and
one that plants nothing by itself: it hands the agent a piece of work, and what
is worth remembering afterwards is in the *reply*. Then nine questions about
what was said and two about things nobody said.

One rule governs every question, and it is what keeps this a measurement of
memory rather than of vocabulary: **a question shares a content word with the
sentence that planted the fact and with the value the store ends up holding.**
The stub's oracle matches terms, so a question phrased to match only the key, or
only the sentence, would quietly hand the round to one side.

| policy | recall | start | mid | late | revised | stale | invented | last prompt | billed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | 7/9 | 2/2 | 3/3 | 2/2 | **0/2** | **2** | clean | 1,565 | 23,892 |
| `window` | 0/9 | 0/2 | 0/3 | 0/2 | 0/2 | — | clean | 258 | 7,589 |
| `compress` | 6/9 | 2/2 | **2/3** | 2/2 | **0/2** | **2** | clean | 635 | 17,755 |
| `facts` | **9/9** | 2/2 | 3/3 | 2/2 | **2/2** | — | clean | 327 | **33,492** |

### The revised column is the task

`full` has forgotten nothing. It is holding both "First demo is 4 March" and
"Change of plan — the demo moved to 11 March", and it answers **4 March**,
confidently. `compress` inherits the same problem through the summary, which
ranks both sentences as facts and keeps both.

`facts` is the only one that knows which of the two is current, and not because
it is cleverer: because a key/value store has to decide at write time. The other
three never decide at all. Perfect recall is not what is interesting about that
row — `full` would match it on a conversation with no revisions in it. What is
interesting is that the strategy that sends a fifth as much is also the only one
that is *right*.

### The key that is about nothing

One more door, added after the benchmark had stopped finding things and a
person testing the app went looking:

> The budget will not go above 12000 euros. That is firm.

The first sentence matched no shape. The second matched the catch-all with
*That* as its subject, and the store gained `that = firm` — quotable, genuinely
said, and about nothing. By the time anyone reads it back there is no way to
find out what "that" was.

The verbatim rule cannot catch this, because it is not an invention. It needs a
rule of its own, and it now has one at the same door: **a key must name what the
value is about**, and a key whose every part is a pronoun or a filler word names
nothing. `no_cloud` survives because "cloud" is a thing; `that_one` does not,
and the number of words in it has nothing to do with the difference.

The fix in the stub is one clause: the key derivation used to fall back to the
raw words when a phrase had no content words left in it, which is exactly the
case where the phrase is naming nothing. Now it returns no key, and a sentence
with no subject worth having stores nothing at all. That is the correct outcome
for a store whose only job is to be right: nothing beats a wrong fact.

The benchmark did not move by a single answer. That is the point — this was junk
that nothing was measuring, sitting in the payload of every future request.

### The one `compress` lost

The mid column is 2/3 for `compress` and 3/3 for everything that can see the
reply. The question it missed — *when will it be ready?* — is answered by a
sentence the **agent** said, and task 9's summariser scores by role: a user
sentence gets +3 and an assistant sentence gets nothing, on the reasoning that
the user states things and the assistant restates them. That was a fair rule
for a summary of what the user had said. It is the wrong rule for a record of
what was agreed, and it silently drops every commitment the agent made.

One caveat, stated rather than buried: the stub's oracle has no notion of which
of two sentences is more recent, so it answers a question about the demo from
whichever line scores better — and the shorter, earlier one wins. A real model
might well spot the word "moved". The point is not that a model cannot resolve a
contradiction; it is that under `facts` there is no contradiction in the payload
to resolve.

### And the column that does not flatter it

`facts` is the most expensive row on the table. Twenty-seven extraction requests
cost 23,579 tokens — more than the window they save, and more in total than
sending the entire conversation every turn. Reading the reply as well as the
message is part of that: it put the bill up by about half again, because a reply
is usually longer than what prompted it.

That is not a rounding error, and it is not hidden anywhere in the panel: the
cost section says *so it never catches up* in red when the per-turn charge
exceeds the per-turn saving.

The crossover does exist. Sixty turns of the same conversation:

| turn | `full` billed | `facts` billed |
| --- | --- | --- |
| 10 | 4,156 | 12,031 |
| 20 | 15,033 | 24,903 |
| **36** | **46,000** | **45,900** |
| 40 | 57,175 | 50,647 |
| 60 | 126,517 | 76,391 |

Turn 36 is where the two lines cross, and by turn 60 `full` costs two-thirds
more — because `full`'s per-turn prompt grows without limit while `facts` stays
flat at ~340 tokens. Under 36 turns this strategy is a way of spending money to
be right about revisions; past 40 it is both cheaper and right.

The crossover has moved twice, and both moves are the same lesson. It was turn
25 when extraction read only the user's message, turn 33 once it read the reply
as well, and turn 36 after one four-line clause was added to the contract — a
clause that cost 2,300 tokens across a 27-turn conversation without changing a
single answer.

**81% of every extraction request is the same instruction resent.** The contract
is 726 tokens and the average extraction is 901. Every rule written into it is
paid for on every turn for the rest of the conversation, which is a strange
property for a prompt to have and the strongest argument in this whole task for
caching it: the transport already reports `cacheHitTokens`, and nothing here
populates it. That is the obvious thing to
fix next, and it does not need a new idea — it needs prompt caching, which the
transport already reports a column for (`cacheHitTokens`) and which this task
never populates.

## Branching, and what it is instead of

Up to here a conversation has been a stack: every message lands on top of the
last, and the only way to try a second version of turn eleven is to destroy the
first. That is a strange restriction to have inherited, because the thing people
do with a requirements conversation is argue about a fork in it — ship in March
with less, or ship in April with all of it — and a stack makes that argument
happen twice, in two chats, with the first ten messages retyped.

A branch owns only the messages it added and reads its parent for everything
before the fork. The benchmark forks one conversation twice off a single
checkpoint and tells each branch the opposite of the other:

| branch | when is the demo? | which database? | leaked |
| --- | --- | --- | --- |
| `march` | 11 March | Postgres | nothing |
| `april` | 4 March | SQLite | nothing |

Two branches of one conversation holding contradictory values at the same time,
and neither of them is wrong. A summary cannot do that — there is one summary
and it says one thing. A key/value store can, because forking it is a matter of
rewinding it.

Rewinding is exact rather than approximate: every version of every fact records
the message index it was written at, so *what did this fact say back there* is a
lookup. A fact with no version before the cut did not exist yet and is dropped.
Handing a fork the **current** facts is the most natural mistake available here,
and it is the one the leak column exists to catch.

The summary chain cannot be rewound — prose does not come apart again — so a
fold reaching past the fork point is dropped rather than inherited. A summary
covering messages this branch will never have is a description of somebody
else's conversation.

What a branch costs:

> The second branch's next turn cost 317 tokens because it reads 20 messages it
> never had to be told; the same turn in a fresh conversation costs 65 tokens
> and knows none of them.

Branching is not a cheaper conversation. It is a second one that starts where
the first stopped being agreed, and the 252-token difference is what a person
would otherwise pay by retyping ten messages — or, more likely, by not bothering
and losing the comparison.

## What broke

Five things, and four of them were found by running the thing rather than by
planning it.

### The extractor that answered the questions

The benchmark asks "which database are we using?" and the extractor read it as a
statement: `database = we using`, which overwrote the answer with the question.
"What is the lab phone number?" became a fact about a phone number nobody has —
confabulation arriving through the one door that was supposed to be shut.

The verbatim rule cannot catch either. Every word of both is in the message.
**A question is a request, not a statement**, and it is now rule 8 of the
contract and a skip in the stub.

### The store that believed two things at once

"Scratch SQLite, we are going with Postgres" names the key nowhere. What it
names is the *value* being replaced. A rule-based extractor derives the key from
the subject, gets `postgres`, and the store ends up holding `database = SQLite`
and `postgres = Postgres` — which is not a revised decision, it is two decisions
and no way to tell which one is live.

The fix is the same rule from the other direction: **a sentence that names a
known value revises whichever key currently holds it.** A model reading the same
key list does this unprompted; a rule needs telling.

### The checkpoint that landed at zero

`tree.mark(14)` put the checkpoint at message 0, silently, because the tree only
knows what it has been told and it had been told nothing — the live conversation
was still in the agent. Both forks then landed at 14 and the checkpoint they
were supposed to share pointed somewhere else.

Every function that touches the tree now settles first, and the one that only
draws it deliberately does not: the head row's counts come from the agent
instead, because a render that committed on the way past would be a write hiding
in a draw.

### The tree that could come back as a cycle

Restoring assigns parents. A record where two branches name each other is a
`path()` that never returns. The tree is now rebuilt parent-first, orphans are
reattached to the root with a note saying so, and a head that is not in the tree
falls back to it. A conversation that comes back with a branch missing is a bad
day; one that comes back with a cycle in it is a hung tab.

### And one from the arithmetic

The panel's break-even for extraction is not the summary's break-even with a
different label. A fold is one payment that keeps paying, so the question is
*how many turns until this fold has paid for itself*. Extraction is a standing
charge, so the question is *does the per-turn saving exceed the per-turn charge
at all* — and if it does not, there is no number of turns that fixes it. The two
say opposite things about the same conversation at turn ten, and shipping the
first one under the second one's name is how a panel ends up contradicting
itself on its own screen.

## What facts do not fix

The block after fifteen messages reads:

```
Facts established in this conversation (verbatim, from what was said) — lines marked * are ones you settled yourself, the rest are the user's:
goal = an internal tool for tracking lab samples
budget = 12000 euros
run_offline = run offline in the building
database = Postgres
demo = 11 March
* ready_two = have it ready two days before the demo
agreement = you write the schema
staging_box = 10.2.0.7
metric_units = metric units in every report
reports = the lab manager
```

Ten facts, 127 tokens, every one of them quotable back to a message, and one of
them quotable back to a message the agent wrote. And:

- `agreement = you write the schema` lost the other half of the sentence — "I
  write the import script" — to the clause-cutting rule that keeps values short
- `run_offline` and `ready_two` are keys derived from verb phrases, and no model
  would have chosen either
- "The budget will not go above 12000 euros" matches no shape at all, so the
  budget is on the floor. Since the pronoun guard, the sentence after it no
  longer compensates by storing something wrong
- "It has to run offline in the building — **no cloud**" kept the first clause
  and dropped the emphasis

A rule-based extractor is not the interesting case; it is the *conservative*
case, and it is the one that can run offline. A real model on the other end of
the same request does better at all three, and the plumbing does not change —
`facts.js` hands its contract to whatever transport is attached and checks what
comes back against the message it was quoting.

The panel names the extractor next to the refusal count for exactly this reason.
Zero refusals from the stub says nothing about what a real model would propose.

## What is remembered and what is not

Task 7 drew a line between the conversation, which survives a restart, and the
statistics, which do not, because they measure a run. Task 9 put the summary on
the conversation's side. This task puts two more things there.

| | survives a restart | why |
| --- | --- | --- |
| messages | **yes** | it is the conversation |
| the branch tree and the head | **yes** | it *is* the conversation now |
| facts, with provenance and revision history | **yes** | the other half of it |
| the summary chain and the cut point | **yes** | task 9's other half |
| the ledger, the chart, the refusal counts | no | they measure this run |
| the calibration | **yes** | it is what the estimator has learned |

`store.js` is at v3. `messages` stays exactly what it always was — the head
branch's resolved conversation — so a v3 record is still a readable conversation
to anything that has never heard of a branch, and the tree sits beside it rather
than instead of it. A v2 record loads as one branch, which is what every
conversation was until this task.

A restored conversation now says:

```
20 messages back in memory · 9 facts about them · saved 4 minutes ago
```

## Layout

- `index.html`, `styles.css` — the page
- `facts.js` — the fact store: the verbatim rule, who said it, canonical keys,
  revisions and their history, retraction, the ceiling and its eviction order,
  the extraction contract, and rewinding to a message index
- `branch.js` — the tree: checkpoints, forks, path resolution, switching, and
  the copy-on-write rules that keep a branch out of its parent
- `memory.js` — the five policies, wire assembly, the counterfactual; task 9's
  summary chain, still running as the control
- `api.js` — the transports; the stub answers, summarises, extracts, and enforces
  the two limits a real endpoint does
- `tokens.js` — unchanged since task 8
- `store.js` — v3: branches beside messages, facts beside summaries
- `agent.js` — extracts after it remembers, counts before it sends
- `app.js` — the context tab, the branch switcher, the benchmark; not one line
  of what-is-a-fact
- `markdown.js` — the renderer for replies, carried over from task 5
