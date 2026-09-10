# The agent that counts

[Task 7](../task7) ends with a conversation that survives the process holding
it, and with a stats bar that says, after a reload:

> restored · 6 messages in memory · no turns this run

That line was written as a boast about memory. Read it again with a bill in
hand and it is a warning: those six messages are about to be resent, in full, on
the next turn, and on every turn after that, and nobody has said what it costs.

This is that sentence with the numbers filled in.

## Running it

Open `index.html`. No server, no build, no dependencies — same as
[task4](../task4) through [task7](../task7).

Everything below is reproducible on the **echo** transport with no API key and
no money: the offline stub enforces a real context window and a real output
ceiling, and does its own tokenising so the calibration has something honest to
learn from. The storage keys are namespaced `task8.*`.

## A fifth layer, and the rule that shapes it

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

The load-bearing rule: **the agent knows the size of a request before it makes
one.** Task 7's agent found out how big a request was by being told afterwards,
by the party that charges for it. Everything interesting here comes from moving
that number to before the send — a refusal that costs nothing, a meter that
moves while you type, a projection of a conversation you have not had yet.

`api.js` gave up its price table on the way. Context windows and prices are
model facts, not transport facts; the transport bills, and the counter knows the
tariff.

## The three numbers the brief asks for

| | where it comes from | estimate or fact |
| --- | --- | --- |
| **the current request** | `counter.plan()`, before anything is sent | estimate, corrected |
| **the whole history** | the same, per message, summed | estimate, corrected |
| **the model's reply** | `usage.completion_tokens` | fact |

Two of the three are predictions and one is a bill, and the panel never lets you
forget which is which. Under the composer, before you have sent anything:

```
this message ≈ 22 tokens · request 4,167 + 800 reserved · 0.5% of 1,000,000 · $0.001105
```

Under the reply, once the bill exists:

```
263 tokens out · 63 in (guessed 61, -3.2%) · $0.000167 · $0.000167 this run
```

The `-3.2%` is the estimator being marked against the truth, in public, every
turn. With thinking on, the same line names the part of the bill you did not
get to read:

```
468 tokens out (192 of them thinking, which you are paying for) · 247 in
(guessed 241, -2.4%) · $0.000318 · $0.000485 this run
```

## Why the estimate apologises

There is no tokeniser in the browser and no count-tokens endpoint on this API,
so the number before the send is a heuristic: characters per token by script —
about 3.9 for English, 2.1 for Cyrillic and Greek, 1 for CJK — plus four tokens
of framing per message and three to prime the reply.

That is a guess, but the shape of it is not. The same sentence, three ways:

| | characters | tokens |
| --- | --- | --- |
| The quick brown fox jumps over the lazy dog every single morning. | 65 | 17 |
| Быстрая коричневая лиса перепрыгивает через ленивую собаку каждое утро. | 71 | 32 |
| 素早い茶色のキツネが毎朝怠け者の犬を飛び越えます。 | 25 | 24 |

Nearly twice the bill for the same thought in Russian, and the composer says
`mostly cyrillic · ~2.1 chars per token` while you type it. So the counter treats every reply as a marking scheme: `plan()` said the
prompt would be *n*, `usage.prompt_tokens` says it was *m*, and the ratio
becomes a correction on the next prediction. Two turns in it is usually within a
couple of percent, and the estimate-vs-bill section shows the drift whether or
not you look.

The offline stub was given its own tokeniser, a word-boundary split rather than
a character-ratio, specifically so that this is not theatre. If echo counted the
way the estimator predicts, the readout would say 0.0% forever and would be
measuring nothing.

## Two real models, and one that is not

`deepseek-flash` and `deepseek-v4-pro` are what the API accepts. Both hold a
million tokens of context and will write up to 384K of it back, and pro is being
retired into flash. That is a problem for a page about limits: after seventeen
turns of deliberately long messages the meter reads

```
17,118 of 1,000,000 · 1.7% · 982,882 free
```

The edge is real and it is about four megabytes of typing away.

So the table has a third entry, `stub-16k`, and it is not a model. It is a
16,384-token window with a name, it exists for the offline transport, and the
agent will not let it near a real endpoint:

> stub-16k is not a real model — it is a small window kept for the offline
> transport. The API would refuse it. Switch model, or switch transport.

A fake limit that says so is a demonstration. A fake limit that does not is a
lie, and the first version of this table — invented model names carrying
invented windows and stale prices — was closer to the second than I would like.

## What the window has to hold

```
system + history + this message + priming = prompt
prompt + max_tokens                       = what the window has to hold
```

Reserving the reply is the step that is easy to skip and impossible to do
without: the answer has to fit in the same window as the question. A request
that fits comfortably on its own can still be refused because of room set aside
for a reply that has not been written.

The meter draws exactly that, in order, and turns red when the total passes the
line — including the case where the line is *inside* the bar.

## A short conversation, a long one, and one that does not fit

The lab at the bottom of the tokens tab runs all three against the current
transport, each in its own session. On echo:

| run | turns | last prompt | billed | cost | last turn |
| --- | --- | --- | --- | --- | --- |
| short | 3 | 597 | 2,015 | $0.000739 | 1.3× the first |
| long | 20 | 5,305 | 60,706 | $0.0120 | 4.6× the first |
| overflow | 30 | 14,736 | 330,705 | $0.0540 | 8.1× the first |

The long run is the one to sit with:

| turn | prompt | reply | that turn | spent so far |
| --- | --- | --- | --- | --- |
| t1 | 120 | 326 | $0.000214 | $0.0002 |
| t5 | 1,194 | 325 | $0.000374 | $0.0015 |
| t10 | 2,577 | 330 | $0.000585 | $0.0040 |
| t20 | 5,305 | 325 | $0.000991 | $0.0120 |

The reply column does not move. The prompt column grows by about the size of one
exchange every turn, because every turn resends everything said before it. So
the cost of a turn grows linearly and the money spent grows with the square of
the turn count, and by turn 20 a single answer costs 4.6 times what the same
answer cost at the start.

The number that makes it concrete: **the whole conversation, system prompt
included, is 5,305 tokens at the end. Holding it for those twenty turns billed
60,706 — eleven times its own length.**

Turn off `carry history` in the config tab and the prompt column goes flat
immediately. That is the whole trade, in one toggle: memory is the thing you are
paying for.

## What breaks

Five ways, in three places: the window, the output ceiling, and the gap between
them where a reply is supposed to appear.

### At the window

Three defensible answers, and `on overflow` in the config picks one. They fail
in genuinely different places, which is why all three are kept.

**trim** — drop the oldest turns until it fits. Thirty turns, no errors, no red
text, and this in the compare table:

> nothing failed, but by the last turn the agent was sending 25 fewer messages
> than it holds — the model could no longer see the start

Nothing broke. The agent simply became a different agent, quietly, mid-
conversation. The ledger greys out the messages that would be left behind and
the debug log records every `memory:trim`, because a silent failure that is
written down somewhere is a different thing from a silent failure.

**refuse** — stop before the request:

> This request does not fit. 16006 prompt tokens plus 800 reserved for the
> reply is 16806, and stub-16k holds 16384. Over by 422.

Nothing was sent, nothing was billed, nothing entered the conversation, and the
banner offers the three ways out: drop the oldest turns, halve the reply
ceiling, or start again.

**send** — let the endpoint be the one to say no:

> This model's maximum context length is 16384 tokens. However, you requested
> 17056 tokens (16256 in the messages, 800 in the completion). Please reduce the
> length of the messages or completion.

A 400 and a wasted round trip on turn 19. The meter had been red for a turn and
a half by then, which is the entire argument for counting first: without it,
turn 18 looks exactly like turn 3 right up until the conversation stops
working.

### The ceiling, from the other end

There is a fourth break that has nothing to do with the window. Set `max tokens`
to 40 and the reply stops in the middle of a word: `finish_reason: length`, 37
tokens written, 76 characters. It is not an error, no exception is raised, and
the only evidence is a field in the usage block — so the turn row is marked with
a ✂ and the reply carries `cut off at the 40-token ceiling` underneath it.

### The reply that never starts

The fifth one was found by using the thing rather than by planning it, which is
why it is worth writing down.

Edit the system prompt, delete *“Answer in at most three short paragraphs”*, ask
a question. The reasoning pane fills up. Then nothing.

That instruction had been doing two jobs and only advertising one. It capped the
answer, and it kept the chain of thought short — and on a reasoning model the
chain of thought is spent out of the same `max_tokens` budget as the answer.
Without it the model thought its way through the entire 800-token ceiling and
was cut off before writing a single token of content. The stream ends
`finish_reason: length`, `content` empty, and the turn cost real money for a
reply that does not exist.

The first version of this page printed `(empty reply)` and moved on, which was
wrong twice over. It described the least interesting possible cause — the model
said nothing — when the truth was that the ceiling had been spent on reasoning.
And underneath, the agent pushed `{ role: 'assistant', content: '' }` into the
conversation, where it would be persisted, resent on every subsequent turn, and
billed for framing tokens forever while carrying nothing back.

Both are fixed, and the fix is a distinction the agent now makes explicitly:

```
turn:end        failed · 0.34s · 4 in memory
tokens:starved  800 tokens written, 800 of them reasoning, none of them
                content · 800-token ceiling · $0.000420 for nothing
```

> The 800-token ceiling was spent on reasoning before the answer started: 800
> tokens written, 800 of them thinking, none of them content. You were billed
> 920 tokens for it — $0.000420. The thinking itself is still above, and nothing
> was added to the conversation.   `Raise the ceiling to 1,600 and ask again`
> `Put the question back`

The money is counted, because it was spent. The turn is not counted, because it
produced no answer. The reasoning stays on screen, because it is the only thing
you got. And the conversation is untouched, which is task 6's rule — a failed
question never enters history — finally applied to the case where the request
succeeded and the *reply* failed.

It is reproducible without a key, because a failure you can only see by spending
money is a failure nobody demonstrates. Set `thinking` to `high` and ask
anything: the stub thinks out of the same ceiling it answers from, and thinks
longer when nothing in the system prompt asks it not to.

| thinking | system prompt | finish | completion | of which thinking | remembered |
| --- | --- | --- | --- | --- | --- |
| `off` | *…at most three short paragraphs* | `stop` | 256 | 0 | yes |
| `low` | the same | `stop` | 456 | 192 | yes |
| `high` | the same | `length` | 798 | 576 | yes, truncated |
| `high` | that clause deleted | `length` | 800 | 800 | **no** |

Read the last two rows together. Same effort, same ceiling; one sentence of the
system prompt deleted, and the turn goes from a truncated answer to a receipt.

## Thinking is output you never see

Thinking on this API is **on by default, at high effort**, and turning it off
means saying `"thinking": {"type": "disabled"}` out loud. Omitting the parameter
does not decline the feature; it accepts the most expensive setting there is.

That is the real explanation for the failure two sections up. It was not a
reasoning model being selected by accident — every request this app has ever
sent, all the way back through task 4, was a thinking request, because none of
them mentioned thinking at all. The brevity clause in the system prompt had been
holding the cost down, and deleting one sentence removed the only brake on a
feature nobody had knowingly switched on.

So the `thinking` field is `off / low / high / max`, and `off` is an
instruction rather than a silence. The debug tab shows which of the two shapes
went out:

```
"thinking": { "type": "disabled" }
"thinking": { "type": "enabled" }, "reasoning_effort": "high"
```

It belongs in a page about tokens because it is not a style preference. Thinking
is billed at output rates and drawn from the same `max_tokens` ceiling as the
answer, so turning it up does three things at once: it raises the bill, it
shrinks the answer, and past a point it removes the answer entirely. None of
that is visible in a reply, which is the problem — so the chart draws it as its
own band on top of each bar, and the turn table carries the total underneath:

> 1,509 output tokens, 992 of them reasoning (66%) — billed as output, spent
> from the same ceiling as the answer, and never shown to you.

What does *not* happen: the reasoning is never written into history. Only
`content` is kept, so you are not charged to resend last turn's thoughts on
every subsequent turn. (If this ever grows tool calls, that changes — DeepSeek
requires `reasoning_content` to be passed back consistently once any assistant
message in the history carries it.)

## The refusal fires one turn early, and that is the lesson

Run the overflow lab twice, once on `refuse` and once on `send`. The agent
refuses on turn 18. The endpoint refuses on turn 19.

They disagree because the estimator was running about 4% high, and 4% of a
16,000-token window is a turn's worth of headroom. An estimate that runs high
throws away requests that would have fit; one that runs low walks into the 400
it was supposed to prevent. Neither is safe, which is why the correction factor
exists, why the drift is on screen next to every prediction, and why the
`refuse` path names the exact numbers rather than saying the request was too
big.

## Where this is heading

The projection section extrapolates from the turns actually taken: growth per
turn, the price of the next ten, and the turn at which the window fills.

> prompt growth  +868 tokens per turn
> this turn vs the first  5.8× the price
> 10 more turns  18,910-token prompt · $0.0367 total
> window fills at  turn 19 — 6 turns from now

Six turns of notice is not much, and it is six turns more than task 7 had.

## What is remembered and what is not

Task 7 drew a line between the conversation, which survives a restart, and the
stats, which do not, because they measure a run. Tokens land on both sides of
that line and the line does not move:

| | survives a restart | why |
| --- | --- | --- |
| messages, and therefore the token count of memory | **yes** | it is the conversation |
| the turn ledger, the chart, the spend | **no** | they measure this run |
| the calibration | **yes** | it is what the estimator has learned, and it was expensive |

So a restored conversation now reads:

```
restored · 8 messages ≈ 2,140 tokens in memory · billed again on the next turn
```

which is the honest version of the line task 7 ended on.

## Layout

- `index.html`, `styles.css` — the page
- `tokens.js` — the model table, the estimator, calibration, window arithmetic,
  the per-turn ledger and the projection
- `api.js` — the transports; the stub enforces the same two limits the real one
  does
- `store.js` — unchanged from task 7
- `agent.js` — counts before it sends, and decides what to do when the answer is
  no
- `app.js` — the meter, the ledger, the chart, the lab; not one line of token
  arithmetic
- `markdown.js` — the renderer for replies, carried over from task 5
