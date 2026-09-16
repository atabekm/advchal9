# Task 12 — Personalizing the assistant · plan

A profile is not a longer system prompt. It is a claim about the *next answer*,
and this task is built around the one thing no task in this series has done yet:
checking the claim against what came back.

[Task 11](../task11) ended with an ablation table that was careful to say what
it measured — **what reached the model**. The three layers were graded on
assembly: did the name make it into the request, did the superseded cutover get
left behind. What the model then did with any of it was never inspected, and
could not have been, because "remembered the deadline" has no shape a checker
could look for.

Preferences do have a shape. *Answer in Russian* is decidable. *At most 120
words* is arithmetic. *Never use emoji* is a regular expression. So this task
asks the question task 11 deliberately left alone:

> **what does the agent do differently because it knows this?**

## Two things called a profile

The brief says *create a user profile* and then *describe preferences — style,
format, constraints*. Those are two different objects and they behave
differently enough that flattening them into one bag is the mistake this plan
exists to avoid.

| | **descriptive** | **prescriptive** |
| --- | --- | --- |
| holds | facts about the person | instructions about the output |
| example | `role: backend engineer` | `length: terse` |
| reaches the answer by | an inference the model draws | an instruction the model obeys |
| fails | silently — it just didn't draw it | visibly — count the words |
| authored by | accumulating | deciding |

A descriptive field only affects a reply through a step nobody can see. "They
are a backend engineer" *might* mean the model skips explaining a connection
pool, or might mean nothing at all this turn. A prescriptive field affects the
reply directly, and compliance is decidable.

Both are in the schema. Only one of them can be graded, and the README says
which — that split is a finding, not an omission.

## What personalization is, stated so it can be tested

> Personalization is the part of the answer determined by **who is asking**
> rather than by what was asked.

Hold the question fixed, vary the person, and whatever changes *is* the
personalization. That is not a demo built after the fact; it is the definition
applied, which is why the grid is the centre of this task and not an appendix
to it.

It also draws the line against the two things personalization is usually
confused with:

| | describes | varies with |
| --- | --- | --- |
| persona | the assistant | nothing — the same for everyone |
| **profile** | **the user** | **the person** |
| memory | the world | the conversation, the task |

Task 11 built the first and the third. The profile was five typed fields inside
a compartment of long-term memory. This task takes that compartment out and
makes it the subject.

## The schema

Eight fields. Small enough to hold in your head, and every one of them chosen
because two different people would fill it in differently.

| field | kind | values | checked by |
| --- | --- | --- | --- |
| `name` | descriptive | string | — |
| `role` | descriptive | string | — |
| `expertise` | descriptive | novice · working · expert | — |
| `language` | format | English · Russian | script ratio |
| `length` | style | terse · normal · thorough | word count |
| `shape` | format | prose · code-first · bullets | structure of the reply |
| `examples` | format | required · optional · never | fence or example marker |
| `tone` | style | dry · neutral · warm | — |
| `forbid` | constraint | a list of strings | substring, regex, emoji range |

Four of nine are unchecked, and three of those four are the descriptive half.
That is the honest shape of the thing: **the fields that say who you are cannot
be graded, and the fields that say what you want can.** A system that reported
a compliance score over all nine would be inventing four of them.

Style, format and constraint are kept apart because they fail differently:

| kind | when ignored |
| --- | --- |
| **style** | the answer is still useful, just not yours |
| **format** | the answer is the wrong shape and has to be re-read |
| **constraint** | not a taste — a failure |

## Attachment

`compile(profile)` returns one system block. It is message zero of every
request, unconditionally — not "when relevant", not folded into the persona.
Unconditional is the whole point: a profile consulted only when the agent
thinks it matters is a profile that will be missing from exactly the turn you
remember.

```
system:  the persona                      ← the same for everyone
system:  Who you are talking to, and how they want to be answered
user/assistant × N                        ← the dialogue
user:    this turn
```

The block is rendered as sentences, not `key=value` — carried over from task 11
for the same reason it was true there: a model uses "they want answers of at
most 120 words"; a table row it may or may not decide is about the person in
front of it.

The compiled block is visible in the app, under the composer, at all times.
Personalization that can only be inferred from its effects is indistinguishable
from a model in a good mood.

## The three people

The profiles have to be **contrastive on checkable axes** or the grid has
nothing to measure. Three, deliberately pulling in different directions:

| | **A · Дина** | **B · Sam** | **C · Priya** |
| --- | --- | --- | --- |
| role | junior developer | staff backend engineer | product manager |
| expertise | novice | expert | novice |
| language | Russian | English | English |
| length | thorough | terse | normal |
| shape | prose | code-first | bullets |
| examples | required | optional | never |
| tone | warm | dry | neutral |
| forbid | — | emoji, "I'd be happy to" | code blocks, jargon |

B and C are near-opposites on every axis that can be counted, which is what
makes a difference between them attributable. A exists because a second
language is the one preference whose violation is impossible to miss on video.

## Applicability is a property of the question

The trap, written down before the checker is built:

*Code-first* cannot apply to a question with no code in the answer. The lazy
implementation asks the **reply** whether it contains code, and marks the field
`n/a` when it does not. That scores a model which ignored the preference
entirely as compliant — the exact failure the checker exists to catch.

So applicability is declared by the **question**, in the question set, before
any answer exists:

```js
{ text: 'How do I stop my API being hammered by one client?',
  applies: ['language', 'length', 'shape', 'examples', 'forbid'] }
```

A verdict is three-valued — `pass`, `fail`, `n/a` — and `n/a` is only ever
reached because the question said so.

Four questions, chosen to exercise the fields and to leave one gap on purpose:

1. rate-limiting an API — code applies, jargon applies
2. Postgres or MongoDB for a new service — an opinion, code optional
3. what a connection pool is — the one where `expertise` should show, and
   nothing can check it
4. how to tell the team a deadline slipped — **no code is possible**, so
   `shape: code-first` is `n/a` by declaration and `examples` still is not

## The grid

```
                     Q1    Q2    Q3    Q4
  no profile          ·     ·     ·     ·     ← baseline
  A · Дина            ·     ·     ·     ·
  B · Sam             ·     ·     ·     ·
  B · Sam (again)     ·     ·     ·     ·     ← noise floor
  C · Priya           ·     ·     ·     ·
```

Twenty requests. Each cell holds the answer in full and a verdict per applicable
field.

Two of those rows are not decoration.

**The baseline** is the profile block omitted entirely. Without it there are
three answers that differ from each other and no way to say what the default
was or which direction each profile moved it.

**The repeat row** is the same profile, the same question, a second request.
Whatever differs between those two cells is the model's own variance, and it
sets the bar that A-vs-B has to clear before it means anything. It is one extra
row and it is the difference between a measurement and an anecdote. A field
that disagrees with itself in the repeat row is reported as **unstable** and its
cross-profile differences are not counted.

## The ablation — what it takes into account automatically

The brief's second question. Same machinery, one notch differently: take profile
B, drop **one field**, re-ask, and check whether *that field's own checker*
flips.

| dropped | expected |
| --- | --- |
| `length: terse` | the terse check fails |
| `shape: code-first` | code stops leading |
| `forbid: emoji` | emoji may return |
| `language: English` | nothing — the question was already English |

A field whose removal changes nothing was never being taken into account, and
is paying rent in the system block of every request forever. The last row is
there because at least one field is expected to be free-riding, and a table
where every row confirms the design would be a table that could not have
surprised anyone.

Six fields × two questions = twelve requests. A full run — grid plus ablation —
is about thirty-two.

## What is deliberately not built

Task 11 was large because three stores with three different policies, a
seven-rule router and an extraction contract are three subjects in one app.
None of them is required here.

- **No memory layers.** The profile persists; the conversation does not. That
  is the entire link to task 11's model, it is one `localStorage` key, and it
  is a sentence rather than a subsystem.
- **No inference of preferences.** Every field has one provenance: a person
  typed it. Inferring preferences from the dialogue means a second request per
  turn, a candidate list, a promotion UI and a gate — task 11's weight, imported
  wholesale, to answer a question the brief does not ask.
- **No repair loop.** A violated constraint is shown beside the reply with the
  rule it broke, and the turn is not re-asked. The checker stays a measuring
  instrument. Failures on screen are worth more here than a score that was
  achieved on the second attempt.
- **No cost tab.** One request per turn, and the profile block is the only thing
  this task adds to it. Its token count is printed beside it and that is the
  whole cost story.

## Where this will be weakest, predicted now

- **The thresholds are arbitrary.** `terse ≤ 120 words` is a constant. It is
  fixed, documented and applied identically to every row, which makes
  comparisons valid and the absolute numbers meaningless.
- **Language detection is a script ratio.** It separates Russian from English
  and would not survive a third language sharing an alphabet.
- **Four fields cannot be checked at all**, including everything descriptive.
  The grid prints their cells as `—` rather than guessing.
- **Twenty cells is a small sample.** The repeat row measures the noise but one
  repeat cannot characterise it. Every conclusion is about this run.

## Stages

| # | stage | ships |
| --- | --- | --- |
| 1 | the profile | schema, the three people, `compile()`, tests |
| 2 | the chat | the block on every request, the editor, the switcher |
| 3 | the checkers | pass, fail, and not applicable |
| 4 | the grid | twenty cells, a baseline and a noise floor |
| 5 | the ablation | which fields earn their tokens |
| 6 | the writing | README |

## Layout

- `index.html`, `styles.css` — the page; chat and profile side by side
- `profile.js` — the schema, the three people, and `compile()`
- `check.js` — one predicate per checkable field, three-valued
- `grid.js` — the grid, the baseline, the noise floor, the ablation
- `api.js` — the DeepSeek transport, slimmed from task 11
- `app.js` — the chat, the editor, the two tabs
- `markdown.js` — the reply renderer, carried from task 5
- `test.js` — checks with no network and no key
