# The agent that knows where it put things

[Task 10](../task10) ended with five ways of answering one question: how much
of this conversation goes up the wire? The window, the summary chain and the
facts block were all different answers, and they had one thing in common that
the README never said out loud — they all died at the same moment. Every one of
them lived inside a single session record. Close the conversation and the agent
forgot your name with the same indifference it forgot "sounds good to me".

That is not a memory model. It is a compression policy with good manners.

This task takes the five policies away and asks the other question instead:
**which of the things this agent knows are about the conversation at all?**
The answer is three stores with three different lifetimes, and a rule that says
out loud which one each new thing belongs to.

## Running it

Open `index.html`. No server, no build, no dependencies — the same as task 4
through task 10. Storage keys are namespaced `task11.*`.

`node test.js` runs 89 checks with no network and no key. Every claim in this
README that is a number comes from there, and the one table that does not is
labelled where it appears.

Unlike every task since task 4, **there is no offline stub**. The subject here
is what a model proposes to remember and where the rules put it; a stub
proposing candidates by regular expression would be measuring the regular
expression. So the chat needs a DeepSeek key. The inspector does not — with an
empty key field you can still read every layer, write items into them by hand,
move them between layers, retract them, and watch the log record that a person
did each one.

## The three layers

| layer | scope | lifetime | holds | dies when |
| --- | --- | --- | --- | --- |
| **short-term** | this dialogue | the session | the last few messages, verbatim | the conversation is reset |
| **working** | this task | the task | goal, constraints, open questions, decisions in flight, artifacts | the task is closed |
| **long-term** | this person | until retracted | profile, standing decisions, knowledge | someone retracts it |

That table is the entire design. Everything below is a consequence of it.

They share one interface — `put`, `all`, `block(budget)`, `snapshot`, `restore`,
`clear` — so that `agent.js` can assemble a prompt without knowing which layer
it is reading from. They do not share a policy, and refusing to unify the
policies is the point. A uniform interface over three identical stores would be
one store with a label column, which is what this task exists not to build.

**Short-term holds messages, not items.** No keys, no ranking, no extraction, no
ceiling except a count of turns. That is not an omission: the moment short-term
memory starts deciding what is worth keeping, it stops being the dialogue and
becomes a fourth store with a confusing name.

**Working is bound to a task** and evicts by kind before recency:

| kind | evicted |
| --- | --- |
| `goal` | last |
| `constraint` | |
| `open_question` | |
| `decision` | |
| `artifact` | first |

A goal is stated once, at the start, and never repeated, which makes it
simultaneously the oldest item in the layer and the one the work is least
usable without. Recency ranking gets exactly that case wrong, so recency is the
tiebreak and never the rule.

**Long-term is one global record**, shared by every conversation this browser
has ever had, with three compartments. `profile` is typed — `name`, `language`,
`tone`, `timezone`, `role` — because free keys in a profile turn it into a
second knowledge store within a week: `name`, then `user_name`, then
`what_to_call_them`, each holding a slightly different string and none of them
wrong enough to delete. `decisions` and `knowledge` take free keys.

Nothing in long-term is evicted for being old. Past sixty days an item is
flagged, still sent, still answerable, with a **still true** button beside it.
An agent that quietly forgets is worse than one that is visibly out of date,
because the second can be corrected and the first cannot even be noticed.

## The router is the demo

The brief's second requirement is the one worth building — *you explicitly
choose what is stored and where*. A model asked nicely to pick a layer does
choose, but it chooses somewhere nobody can see, differently on Tuesday, and
there is no way to be shown the rule because there was no rule.

So: seven rules, in order, first match wins, and **the number travels with the
write**.

| # | rule | fires when | layer |
| --- | --- | --- | --- |
| 1 | `retraction` | `op: "clear"` | wherever the key already is |
| 2 | `volatility` | the key names nothing, or the value carries nothing | *dropped* |
| 3 | `profile` | a profile field, and not task-shaped | `long.profile` |
| 4 | `knowledge` | `kind: knowledge`, or an identifier with no open task | `long.knowledge` |
| 5 | `task shape` | goal, constraint, open question, artifact, identifier | `working` |
| 6 | `decision` | decision, agreement | `working`, *promotable* |
| 7 | `fallback` | anything left | `working`, evicted first |
| 0 | `manual` / `promotion` | a person moved it, or a task closed | wherever they said |

Read top to bottom, each question is narrower than the one before, which is why
first-match-wins is a policy rather than an accident of ordering.

The model proposes a layer too. Its proposal is recorded and then **ignored by
everything that writes**, and where the two disagree both are on screen:

```
language    long.profile   rule 3 · profile      model said working  ✗ overruled
staging_box working        rule 5 · task shape   model said long     ✗ overruled
deadline    working        rule 6 · decision     model said long     ✗ overruled
name        long.profile   rule 3 · profile      model said long     ✓
```

The disagreements are the only evidence that a choice was made at all rather
than a default taken. Hiding them would leave a panel that can only ever agree
with itself.

### Rule 6 is the one with an argument behind it

A decision made inside a task belongs to the task while the task is open. It is
the kind of thing that gets revised twice before lunch, and a revision that has
to be chased through a permanent store is a revision that will be missed.

When the task closes, its decisions are **offered** for promotion, one at a
time, with the goal they were decided under attached. The ones that outlive the
task move to `long.decisions` with their provenance intact; the rest are
archived with it and stay readable. An agent that promoted its own decisions
would build a permanent record of every provisional thing said on a Tuesday
afternoon, which is how a long-term store becomes a place nobody trusts and
everybody works around.

### Rule 2 is the one that keeps the layers empty

Most of what is said in a conversation is worth remembering for two turns, and
short-term memory already has it. Storing it again is not redundancy — it is a
second copy that will still be there after the first one has been correctly
forgotten.

```
mood: "Sounds good to me"   dropped   rule 2 · volatility
  carries nothing the window does not already hold
it: "10.2.0.7"              dropped   rule 2 · volatility
  "it" does not name what the value is about
```

The content test runs on every kind, not only on `other`. A model that labels
"sounds good" a decision has not made it one, and a layer that accepted it
because of the label would be storing the label.

## The rule that came across whole from task 10

> a value that is not a verbatim span of a cited message is not storable

Checked on write, by string containment against the message named in `from` —
not requested in the prompt, not graded afterwards, not left to a model's good
intentions.

It matters more here than it did in task 10, because a long-term store is not
emptied at the end of the conversation. An invention that reaches it sits in the
system slot of every future request, for months, where it is indistinguishable
from something that happened.

```
deadline: "the 4th of March"    refused by the gate
  not a verbatim span of the user's message
  the user actually said: the deadline is 11 March
summary: "The user is building a memory panel for their agent"
  refused — not a verbatim span of the assistant's message
```

Case, whitespace and curly quotes are folded. Nothing else is. "4th of March"
does not match "4 March" and must not: substitution is exactly what the rule
exists to catch.

The refusals are shown with the message they claimed to be quoting, because
without that the gate is an assertion and with it anybody can check.

## Three blocks, three budgets, one order

```
system:  the persona
system:  About the person you are talking to      ← long-term, ≤ 160 tokens
system:  The task at hand — "…"                   ← working,   ≤ 224 tokens
user/assistant × N                                ← short-term, ≤ keepTurns pairs
user:    this turn
```

The order is not arbitrary. The persona first, because it is the frame
everything else is read inside. Then the person, because who is being spoken to
outranks what is being worked on. Then the task. Then, last and closest to the
reply, the things that were actually said — the position a model weights most
heavily, and short-term memory is the only layer whose contents are guaranteed
to be exactly what happened.

Each block is a **system message, not a fabricated turn**. Nobody said it. It is
a record *about* what was said, and giving it a speaker would put words in the
user's mouth that the user would then be told they had used. Each block says so
inside itself when it truncates, because a model that believes it was given
everything will answer confidently about the part it was not given.

## What lands in each layer

The brief's first question, answered by a transcript. This is the seven-turn
script in `ablation.js`, routed by the rules with no human intervention:

| said | key | value | landed | rule |
| --- | --- | --- | --- | --- |
| "Call me Atabek — I'm a backend engineer…" | `name` | Atabek | `long.profile` | 3 |
| | `role` | backend engineer | `long.profile` | 3 |
| "We're migrating the billing service to Postgres" | `goal` | migrating the billing service to Postgres | `working` | 5 |
| "Hard constraint: no downtime" | `downtime` | no downtime | `working` | 5 |
| "Let's put the cutover on 4 March" | `cutover` | 4 March | `working` | 6 |
| "Actually, make that 11 March" | `cutover` | 11 March | `working` | 6 |
| "We'll use Postgres 16, not 15" | `pg_version` | Postgres 16 | `working` | 6 |
| "Great, thanks. Sounds good to me." | `mood` | Sounds good to me | **nothing** | 2 |

`cutover` appears twice in the log and once in the block. Only the current value
goes up the wire; the superseded one is kept for the panel and is what makes the
difference between a list that looks duplicated and one that shows a decision
changing.

## How it affects the answers

The ablation builds that memory **once**, then hands the same snapshot — the
same items, the same values, the same provenance — to four probe runs that
differ only in which layers are allowed into the request. A difference in the
answers therefore cannot be a difference in what was remembered. It can only be
a difference in what was sent.

The probes are asked in a **new conversation**, with short-term empty. That is
not a handicap invented to make the other layers look good; it is the situation
the entire task is about. Coming back tomorrow is when the difference between a
dialogue, a task and a person stops being a diagram.

| question | everything | no long-term | no working | dialogue only |
| --- | --- | --- | --- | --- |
| What are you supposed to call me? | ✓ | ✗ | ✓ | ✗ |
| What do I do for a living? | ✓ | ✗ | ✓ | ✗ |
| What are we working on? | ✓ | ✓ | ✗ | ✗ |
| When is the cutover? | ✓ | ✓ | ✗ | ✗ |
| Which Postgres version did we settle on? | ✓ | ✓ | ✗ | ✗ |
| **answered** | **5/5** | **3/5** | **2/5** | **0/5** |

**This table is from `node test.js`, not from a live run.** The transport there
does not imitate a model: it answers by reading back the memory blocks it was
handed. So the table is a fact about the assembly — what reached the model — and
not about how well any particular model uses what it is given. It is
deterministic, it costs nothing, and any other pattern in it would be a bug.

The live ablation is the button in the panel. It is about 34 requests, it runs
against DeepSeek, and it will not match this table exactly, because a real model
sometimes answers from a guess and sometimes refuses to answer from a fact. The
answers are printed in full underneath the verdicts for that reason: a score
with no transcript under it is a number asking to be trusted.

Two of the four columns are worth reading twice.

**"no working" still knows your name.** That is the column that shows the
profile is not a nicety. It survives the task being unplugged because it was
never part of the task.

**The cutover question is graded twice.** An answer of "4 March" is not scored
as a miss; it is scored as `stale`, because an agent that says 4 March has not
forgotten the cutover — it has remembered a superseded value, and those are
different failures that deserve different names.

## The demonstration that needs no table

Open a new conversation. The agent greets you by name and knows nothing about
yesterday's deadline.

```
1 thing came back from earlier conversations, including that you are
called Atabek. This conversation is empty; that store is not.
```

Verified end to end in the promotion harness by handing a second page load the
first one's `localStorage`: the promoted decision returns, the closed task does
not, the dialogue does not.

## Stored separately, and here is the proof

Three key namespaces, not one record with a `layer` column:

| layer | namespace | records |
| --- | --- | --- |
| short-term | `task11.dialogue.*` | one per conversation |
| working | `task11.task.*` | one per task, open or archived |
| long-term | `task11.profile` | exactly one, for everyone |

The memory tab draws them as three bars with a delete button each. Delete
`task11.profile` and the agent forgets your name and keeps the deadline; delete
the task record and it forgets the deadline and still knows your name. Nothing
else in the app has to be consulted to know that, and nothing else in the app
could have made it true.

One record with a `layer` column would have been less code. It would also have
made every sentence in that paragraph a claim about a `WHERE` clause.

`task11.ablation` is a fourth key and is deliberately not in that table. It is a
measurement, not a memory — it survives a reload so the comparison does not have
to be re-paid for, and nothing reads it back into a request.

## What it costs

A turn is **two requests**: the reply, and then a JSON call that proposes what
to remember about it. Both are billed, and both are shown per turn in the wire
tab, in this shape:

```
1 · the reply        <in> in · <out> out   $…
2 · the extraction   <in> in · <out> out   $…
it proposed          3 candidates
the turn cost        $…
```

No numbers are printed here because none have been measured — this repo has
never been run against a key. What can be said without measuring: the extraction
request carries one turn plus the list of keys already stored, so it is smaller
than the reply request, and it produces a few dozen tokens of JSON rather than
a few hundred of prose. It is a real fraction of every turn and not a rounding
error, which is why there is a switch in the composer to turn it off for a turn
that is obviously small talk — the honest alternative to a heuristic deciding
for you and being wrong about the one sentence that mattered.

The extraction runs **after** the reply is streamed. The user is never waiting
on it. It is also allowed to fail: a turn that was said and not remembered is a
turn that happened, while a turn that was remembered and not said never existed,
so every failure is returned as a reason rather than thrown, and the reason is
shown beside the turn it belongs to. That is the only way anybody would notice
memory had quietly stopped working.

## Where this is weakest

- **The rules are rules, and the model's opinion is often better.** Rule 5
  sends `staging_box: 10.2.0.7` into working memory because a task is open,
  where the model wanted long-term knowledge; when the task closes, that IP
  goes with it. Both readings are defensible. The app shows the disagreement
  and lets you move it by hand, and the point of the brief is an *explicit*
  choice rather than a correct one — but a rule that can be seen being wrong is
  still a rule that is sometimes wrong.
- **The verbatim gate refuses good facts.** It refuses every paraphrase,
  including the accurate ones. Task 10 measured this and the rejected column is
  kept here for the same reason: a rejection is visible and a confabulation is
  not.
- **The profile is typed, and five fields is a guess.** A candidate keyed
  `favourite_colour` with `kind: profile` is not thrown away — it becomes
  knowledge about the person, with a note saying why — but the line between the
  two compartments is drawn by a constant at the top of `layers.js`.
- **Eviction from long-term has no good rule.** Everything in it was, by
  construction, judged worth keeping forever. Least-recently-confirmed is the
  least bad, and it drops the item loudly into the retracted list rather than
  into nothing.
- **There is no stub, so nothing here is free.** Task 10 could prove every
  number in its README with the network unplugged. This one cannot, and the
  compensation — 89 checks that run with no key — covers the rules and the
  assembly but says nothing about what a model proposes.

## Layout

- `index.html`, `styles.css` — the page; one colour per layer, used in all five tabs
- `layers.js` — the three stores: their interfaces, their different policies,
  the eviction orders, the block rendering and the budgets
- `store.js` — persistence: three namespaces, three lifetimes, and the delete
  buttons that make the separation checkable
- `extract.js` — the extraction contract, and the verbatim gate
- `router.js` — the seven rules, the decision log, manual overrides, promotion
- `api.js` — the DeepSeek transport: `send` for the reply, `json` for the
  extraction
- `agent.js` — assembly in four parts, and a turn that is two requests
- `ablation.js` — one memory, four configurations, five questions
- `app.js` — the chat and the inspector; not one line of what-is-a-layer
- `markdown.js` — the reply renderer, carried over from task 5
- `test.js` — 89 checks, no network, no key, no dependencies
