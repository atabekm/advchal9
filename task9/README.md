# The agent that forgets on purpose

[Task 8](../task8) ends by pricing its own memory:

> the whole conversation, system prompt included, is 5,305 tokens at the end.
> Holding it for those twenty turns billed 60,706 — eleven times its own length.

It had one answer to that, `trim`, and it ran thirty turns without a single
error. The compare table said what the silence had cost:

> nothing failed, but by the last turn the agent was sending 25 fewer messages
> than it holds — the model could no longer see the start

That is the sentence this task is about. Trimming is compression with a ratio of
zero on everything it touches: the oldest turns do not get smaller, they get
deleted. Here they get smaller instead, and then the question is whether that
bought anything, which turns out to be a question you have to actually measure.

## Running it

Open `index.html`. No server, no build, no dependencies — the same as
[task4](../task4) through task 8. Storage keys are namespaced `task9.*`.

Everything below is reproducible on the **echo** transport with no API key and
no money. That matters more here than it did in task 8: half this brief is about
response quality, and a quality comparison you can only run by spending money is
a comparison nobody runs.

## A sixth layer, and the rule that shapes it

```
app.js     the interface   draws the memory tab, runs the benchmark
                           never decides what to forget
   |
agent.js   the agent       one turn, and sometimes two requests
                           never writes a summary itself
   |
memory.js  the compressor  what stays verbatim, what becomes prose, what it saved
                           never touches the DOM, never sends anything
   |
tokens.js  the counter     unchanged from task 8
   |
store.js   the store       now persists summaries beside messages
   |
api.js     the transport   now also answers, and summarises
```

Task 8's rule was that the agent knows the size of a request before it makes
one. This one follows from it: **the agent never sends the same message at full
size twice.** A message is verbatim while it is recent and prose afterwards, and
somebody has to own the moment of transition. `memory.js` owns it.

## What goes up the wire

```
system prompt
summary            ← one system message: "Earlier in this conversation…"
last N messages    ← verbatim, exactly as said
the new user turn
```

The summary is a **system** message, never a fabricated user or assistant turn.
It is not something anybody said, so attributing it to a speaker is a lie the
model will then reason from, and it has to survive every future fold without
being mistaken for history that can be folded again.

It is stored separately from `messages`, which is the brief's third bullet and
also the only way the panel can keep saying true things. The conversation on
screen is still every message that was ever said. What is *sent* is the block
above. Those two have been the same thing since task 4 and from here they are
not.

## Four answers to one question

Task 8 spread "how much of the past goes up the wire" across a toggle
(`carryHistory`) and an emergency (`overflowPolicy`), which is why neither quite
made sense. They are four answers to one question:

| policy | what is sent | prompt growth |
| --- | --- | --- |
| `none` | system + this turn | flat, and the agent is amnesiac |
| `full` | everything, forever | linear per turn, quadratic in total |
| `window` | system + last N | flat; the start is gone |
| `compress` | system + summary + last N | flat, plus a slowly growing summary |

`overflowPolicy` survives, narrowed to what it always was: the *second*
question, asked only when the first answer still does not fit.

`window` is kept deliberately, because it is the control. `compress` costs
**more** than `window` — the summariser is a real request and it is billed — so
a comparison that only sets `compress` against `full` is rigged. Every policy
beats `full` on cost, including the one that remembers nothing.

## Measuring quality without vibes

Read a few replies, decide which is nicer, and you have measured nothing. So the
benchmark plants five verifiable facts across 21 turns — at the start, in the
middle, and late — buries them under filler deeper than the verbatim window
reaches, then asks about each one and greps the reply.

Two guards stop the score flattering itself:

**Confabulation.** Two of the questions ask about things nobody said. A
confident answer to one of those counts against the run, because a summary that
invents a plausible detail launders it into the system slot of every subsequent
request. Inventing is worse than forgetting.

**Position.** Facts are planted at three depths, and the oracle reports where
each answer came from, so the table can tell *compression preserved it* apart
from *it was never compressed in the first place*.

## Reproducible with no key, which took two changes

Task 8's stub replied to everything with a canned essay about its own token
count. You cannot grade an answer from a transport that never answers anything,
so it now decides what to be from the payload alone.

**It answers as an oracle.** Given a question, it searches exactly what it was
handed — system prompt, summary, verbatim messages — and answers if the fact is
in there, or says it cannot if it is not. It is not pretending to be
intelligent. It answers one question mechanically: *was the fact still in the
payload?* That makes the offline recall score a direct measurement of what the
memory policy preserved, with no model judgement in the loop at all. The refusal
rule is the load-bearing part: a term the question asks about that appears
nowhere in the payload is an absence, not a weak match. Without it, a question
about a cat gets answered from a sentence about a dog and the quality column
measures nothing.

**It summarises extractively, and lossily.** It ranks sentences by how much fact
they carry and keeps them until a real ceiling stops it. Facts fall out because
the budget ran out, which is exactly why they fall out upstream. A stub
summariser that kept everything would score perfectly forever, which is the same
reasoning that gave the stub its own tokeniser in task 8.

It also stopped writing essays. An assistant whose every reply is six paragraphs
about itself is not a stand-in for a conversation, it is the loudest thing in
it — and a summariser asked to compress that spends its whole ceiling on the
stub rather than on what was said to it.

## The comparison the brief asks for

Three policies, the same 21-turn conversation, the same five facts, the same two
traps. 1.6 seconds, offline, free:

| policy | recall | start | mid | late | traps | last prompt | billed | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | **5/5** | 2/2 | 2/2 | 1/1 | clean | 1,783 | 27,944 | $0.0047 |
| `window` | **0/5** | 0/2 | 0/2 | 0/1 | clean | 255 | 8,252 | $0.0018 |
| `compress` | **5/5** | 2/2 | 2/2 | 1/1 | clean | 637 | 18,765 | $0.0037 |

Under `compress`, four of the five came back from the summary and one from the
verbatim window. Across the run the agent sent 12,937 prompt tokens where `full`
would have sent 26,339 — **50.9% less** — and paid 3,375 tokens for the four
summaries that made it possible, leaving it about 10,000 tokens ahead.

And the caveat that keeps this table honest: `window` deletes a message the
moment it falls past the keep count, while `compress` keeps it until the next
fold. At `keepRecent 6` and `compressEvery 10` that is up to **16** messages
verbatim against **6**. Some of what looks like compression working is simply a
larger window, which is exactly why the panel prints where each fact survived.

## Compression is not free, and this is where implementations lie

A summary is written by a model, in a second request, with its own bill. So the
panel keeps the arithmetic most demonstrations skip:

```
the latest fold cost        967 tokens
and saves per turn          366 tokens
so it pays for itself in    3 turns
turns since it was made     5 turns — paid off
the run, net of folding     10,027 tokens ahead
```

Those are two different questions and reporting either under the other's name is
how a panel contradicts itself. *Has this fold earned its keep* is about one fold
and the turns since it. *Is compression winning* is about the whole run. An
earlier version computed the first by charging one fold for the cost of all four,
and reported a conversation as losing money while the counterfactual two
sections above said it had saved half its tokens.

Turn the same numbers on a four-turn conversation and the panel says the other
thing:

```
the latest fold cost        425 tokens
and saves per turn           41 tokens
so it pays for itself in     11 turns
turns since it was made      1 turn — 10 turns to go
```

A short conversation with compression switched on is paying for a feature it does
not need, and the app should be willing to say that about itself.

## The ceiling is the quality dial

`summaryBudget` is the single most consequential setting here, and it is
measurable rather than a matter of taste:

| summary ceiling | recall | summary size | total billed |
| --- | --- | --- | --- |
| 64 | **1/5** | 42 tokens | 16,474 |
| 128 | **3/5** | 103 tokens | 17,930 |
| 256 | **5/5** | 167 tokens | 18,765 |
| 512 | **5/5** | 167 tokens | 18,765 |

Recall is bought with summary size, up to the point where the summariser runs
out of facts worth keeping and the ceiling stops binding. Between 64 and 256
tokens, 2,300 tokens of extra spend across the run buys four facts back.

## Folding more often is worse, in both directions

| fold every | recall | last prompt | folds | spent folding | total billed |
| --- | --- | --- | --- | --- | --- |
| 4 messages | 5/5 | 428 | 12 | 8,159 | 21,738 |
| 10 messages | 5/5 | 637 | 4 | 3,375 | **18,765** |
| 20 messages | 5/5 | 637 | 2 | 2,198 | 19,578 |

Folding every four messages gives the smallest prompts and the **largest** bill,
because twelve summariser requests cost more than the prompt tokens they save.
Folding every twenty spends the least on summarising and still bills more,
because the backlog sits in the payload at full price while it waits. The brief
suggests every ten, and on this conversation every ten happens to win.

## What breaks

Task 8 catalogued five failures. Compression brings four of its own, and all
four were found by running the thing rather than by planning it.

### The fold that loses the fact

At a 64-token ceiling the summariser writes 42 tokens and four of the five facts
are not among them. Nothing errors, no red text appears, and the agent answers
confidently and wrongly eight turns later. The only thing that catches it is the
benchmark. This is the failure mode that makes "response quality" worth
measuring instead of eyeballing.

### The summary that cannot learn

The first rolling summaries came out looking fine and were quietly broken. The
previous summary is *already compressed*, so every sentence in it is dense and
scores well; competing on score alone against fresh messages, it won the entire
ceiling. Nothing said after the first fold was ever recorded again. The summary
had stopped being a memory and become a monument to the opening.

The fix is a split budget — the already-compressed half is capped at 60%, the
rest is reserved for what is new — and the general statement of it is that **a
memory which cannot take in anything new is not a memory.**

### The summary that grows into what it replaced

Roll a summary enough times with no ceiling and it converges on the length of
the history it stands in for, and then you are paying for both. The generations
table exists to show whether the `out` column has stopped climbing:

| gen | folded | in | out | saves/turn | why |
| --- | --- | --- | --- | --- | --- |
| 1 | 10 msgs | 301 | 95 | 206 | schedule |
| 2 | 10 msgs | 417 | 145 | 272 | schedule |
| 3 | 10 msgs | 510 | 167 | 343 | schedule |
| 4 | 10 msgs | 533 | **167** | 366 | schedule |

It flattens at 167 because the ceiling makes it, and the saving per turn keeps
climbing because the history it replaces keeps growing while the summary does
not. That gap is the entire mechanism, in one table.

### The fold that fails

The summariser 429s, times out, or comes back empty. The rule is absolute:
**nothing is evicted until a summary exists to stand in for it.** A failed fold
leaves the conversation byte-for-byte as it was, the turn goes out uncompressed
and more expensively, and the log says so. Tested by pointing the agent at a
summariser that throws on every call: eight turns completed, four folds failed,
sixteen messages still held, nothing lost. Losing messages to a network error is
not a trade-off, it is data loss.

### And one from underneath

Every output ceiling in task 8 was behaving like half of itself. The stub's
tokeniser folded a per-text framing token into its count — correct for a whole
message, wrong for a fragment — and the streaming loop calls it once per word.
Summaries were being cut off at half the ceiling they were given. Split into
`echoTokens` (the tokeniser) and `echoTokenize` (one message).

## What compression does not fix

The summary that comes out of a 21-turn run still reads like this:

```
- Before we start: my dog is called Kepler.
- Also worth noting, the project deadline is 4 March.
- Thanks, that is roughly what I expected.
- No news at this end.
- Fine by me.
- The staging box lives at 10.2.0.7.
- I prefer metric units in every report.
- [7 further sentences did not fit the 256-token ceiling and were dropped]
```

Every fact is there and so is a quarter of the filler. An extractive summariser
ranks sentences; it does not understand that "Fine by me." was never worth
keeping. A real model on the other end of the same `summarise` call does better,
and the interesting part is that the plumbing does not change — `memory.js` hands
its prompt to whatever transport is attached and counts what comes back.

## What is remembered and what is not

Task 7 drew a line between the conversation, which survives a restart, and the
statistics, which do not, because they measure a run. Task 8 put tokens on both
sides of it. The summary lands on the conversation's side:

| | survives a restart | why |
| --- | --- | --- |
| messages | **yes** | it is the conversation |
| the summary chain and the cut point | **yes** | it is the other half of the conversation |
| the turn ledger, the chart, the spend | no | they measure this run |
| the calibration | **yes** | it is what the estimator has learned |

A conversation restored without its summary quietly goes back to full price; a
summary restored without its cut point sends the folded messages twice. So
`store.js` is at v2, with `memory` beside `messages`, validated the way messages
are — it is the one field where a shrug would be expensive, since a tampered
summary lands in the system slot of every future request. A v1 record is not
corrupt, it is older: it loads with no memory, which reads as *nothing folded
yet*.

So a restored conversation now reads:

```
restored · 26 messages in memory · 10 of them as a 75-token summary ·
632 sent where full would send 836
```

which is the compressed version of the line task 8 ended on.

## Layout

- `index.html`, `styles.css` — the page
- `memory.js` — the fold policy, the summary chain, wire assembly, the savings
  and break-even arithmetic
- `api.js` — the transports; the stub answers, summarises, and enforces the same
  two limits a real endpoint does
- `tokens.js` — unchanged from task 8
- `store.js` — v2: summaries beside messages
- `agent.js` — folds before it counts, counts before it sends
- `app.js` — the memory tab and the benchmark; not one line of fold arithmetic
- `markdown.js` — the renderer for replies, carried over from task 5
