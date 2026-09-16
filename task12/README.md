# A profile is a claim about the next answer

[Task 11](../task11) ended with an ablation table that was careful about what
it measured: **what reached the model**. Three layers were graded on assembly —
did the name make it into the request, did the superseded cutover get left
behind. What the model then *did* with any of it was never inspected, and could
not have been, because "remembered the deadline" has no shape a checker can
look for.

Preferences do have a shape. *Answer in Russian* is decidable. *At most 120
words* is arithmetic. *Never use emoji* is a regular expression.

So this task asks the question task 11 deliberately left alone — **what does
the agent do differently because it knows this?** — and the answer is not a
longer system prompt. It is a block that goes up with every request and a
checker that reads what came back.

## Running it

Open `index.html`. No server, no build, no dependencies — the same as task 4
through task 11. Storage keys are namespaced `task12.*`.

`node test.js` runs 235 checks with no network and no key.

There is **no offline stub**, for the reason task 11 had none: the subject is
whether a model obeys an instruction, and a stub written to obey the checkers
would be measuring the checkers. The chat, the grid and the ablation need a
DeepSeek key. The profile editor does not — with an empty key field you can
still build a profile, watch the block change under the composer, and read what
it costs.

## Two different things are called a profile

The brief says *create a user profile* and then *describe preferences — style,
format, constraints*. Those are two objects, not one.

| | **descriptive** | **prescriptive** |
| --- | --- | --- |
| holds | facts about the person | instructions about the output |
| example | `role: staff backend engineer` | `length: terse` |
| reaches the answer by | an inference the model draws | an instruction the model obeys |
| fails | silently — it just didn't draw it | visibly — count the words |
| authored by | accumulating | deciding |

A descriptive field reaches the reply through a step nobody can see. "They are
a backend engineer" *might* mean the model skips explaining a connection pool,
or might mean nothing at all this turn. A prescriptive field reaches it as an
instruction, and whether it arrived is decidable.

Both are in the schema. Only one of them can be graded, and `checkable` is a
flag on the field rather than a caveat in this file, so that nothing can
quietly compute a compliance score over a field nobody can count.

## Personalization, stated so it can be tested

> Personalization is the part of the answer determined by **who is asking**
> rather than by what was asked.

Hold the questions fixed, vary the person, and whatever changes *is* the
personalization. That is why the grid is the centre of this task rather than a
demo appended to it — it is the definition executed. It also draws the line
against the two things personalization gets confused with:

| | describes | varies with |
| --- | --- | --- |
| persona | the assistant | nothing — the same for everyone |
| **profile** | **the user** | **the person** |
| memory | the world | the conversation, the task |

Task 11 built the first and the third; the profile was five typed fields inside
a compartment of long-term memory. This task takes that compartment out and
makes it the subject.

## The schema

Nine fields, each chosen because two different people would fill it in
differently. A field everybody answers the same way personalises nothing and
costs tokens forever.

| field | kind | values | checked by |
| --- | --- | --- | --- |
| `name` | identity | text | — |
| `role` | identity | text | — |
| `expertise` | identity | novice · working · expert | — |
| `language` | format | English · Russian | script ratio, code excluded |
| `length` | style | terse · normal · thorough | word count, code excluded |
| `shape` | format | prose · code-first · bullets | structure of the reply |
| `examples` | format | required · never | a fence, or an example marker |
| `tone` | style | dry · warm | — |
| `forbid` | constraint | a list | one predicate per entry |

Four of the nine cannot be checked, and three of those four are the descriptive
half. That is the honest shape of the thing: **the fields that say who you are
cannot be graded, and the fields that say what you want can.**

Style, format and constraint are kept apart because they fail differently —
style leaves the answer useful but not yours, format leaves it the wrong shape,
and a violated constraint is not a taste, it is a failure.

### An unset field is not a default

The first draft of the schema had `length: normal` and `language: English` as
the empty profile's values. The tests caught it, and the distinction turned out
to be the one the baseline row rests on:

- `length: normal` is an **instruction** — "under 350 words" — and the model
  obeys it.
- an **unset** `length` is the question the baseline asks: what does this agent
  do when nobody has told it anything?

So every choice field has an unset state, no value list contains a "no opinion"
member, and a profile of entirely unset fields compiles to the empty string
rather than to a block that says nothing. `no profile` has to mean *no block*,
or the baseline is a comparison between two prompts with one of them
pretending.

### A constraint is a pair

The sentence that asks for it, and the predicate that decides whether it was
kept. **If the predicate cannot be written, the thing is not a constraint — it
is a hope with a confident name.**

Which is why the ban catalogue is closed. "Never use jargon" is not a
constraint. "Never use these ten words" is, and the ten words go into the
prompt, so the model is refusing something it was actually shown:

```
- Never include code blocks; never use any of these words: idempotent,
  sharding, backpressure, eventual consistency, connection pool, p99,
  throughput, ACID, quorum, replication lag.
```

The editor still accepts free text. Anything outside the catalogue reaches the
block and is reported as **unchecked** rather than passing quietly.

## Attachment

`compile(profile)` produces one block. It is message zero of every request,
after the persona and before anything anybody said.

```
system:  the persona                     ← the same for everyone
system:  Who you are talking to, and how they want to be answered
user/assistant × N                       ← the conversation
user:    this turn
```

**Unconditionally.** A profile the agent consults when it judges the moment
relevant will be missing from exactly the turn you remember, and "it usually
uses your name" is a mood, not a property.

It is a system message, not a fabricated user turn. Nobody said it; giving it a
speaker would put words in the user's mouth that the user could then be told
they had used.

**The persona is deliberately empty of anything a preference could
contradict** — "You are an assistant answering questions about software", and
nothing about how it writes. A persona that said "be concise and use examples"
would be a profile with no owner: the baseline would already be personalised,
and any difference between two rows could be blamed on which one happened to
agree with it.

The compiled block is on screen under the composer at all times, with its token
count. Personalization you can only infer from its effects is indistinguishable
from a model in a good mood.

## The three people

Contrastive on every axis a checker can count, because a difference between two
people that has two possible explanations has none.

| | **A · Дина** | **B · Sam** | **C · Priya** |
| --- | --- | --- | --- |
| role | junior developer | staff backend engineer | product manager |
| expertise | novice | expert | novice |
| language | Russian | English | English |
| length | thorough | terse | normal |
| shape | prose | code-first | bullets |
| examples | required | *unset* | never |
| tone | warm | dry | *unset* |
| forbid | — | emoji, pleasantries | code, jargon |
| **block** | **116 tokens** | **127 tokens** | **143 tokens** |

Language is held constant between Sam and Priya on purpose. If it varied too,
every difference between their answers would have a second explanation and
neither could be attributed to anything. Дина is the one who changes it,
because a reply in the wrong language is the one violation nobody can miss,
including on video.

Sam's block, in full:

```
Who you are talking to, and how they want to be answered.

The person:
They are called Sam. They work as a staff backend engineer. They are an
expert — skip the basics.

How they want the answer:
- Answer in English.
- Keep it short: at most 120 words, not counting code.
- Lead with code: the answer opens with a code block, explanation after it.
- Keep the tone dry and matter-of-fact.
- Never use emoji; never open with a pleasantry such as "I'd be happy to" or
  "Great question".
```

Sentences, not `key=value`. Carried from task 11 for the reason that was true
there: a model uses "at most 120 words"; a table row it may or may not decide
is about the person in front of it.

## The checkers

Four rules, and each of them exists because the obvious implementation gets it
wrong in a flattering direction.

**A verdict is three-valued** — `pass`, `fail`, `n/a` — with a fourth,
`unchecked`, for the fields nobody can grade. Two-valued compliance forces
every unaskable question into one of the two answers and it always lands on the
generous one.

**Applicability is a property of the question, not the reply.** The lazy
implementation asks the *reply* whether it contains code and marks `shape:
code-first` as `n/a` when it does not — which scores a model that ignored the
preference entirely as compliant. That is the exact failure the checker exists
to catch. So a reply with no code **fails** code-first, and only a question that
declared in advance that it cannot exercise a field yields `n/a`:

```js
{ id: 'slipped',
  text: 'How should I tell the team that the launch date has slipped?',
  cannotApply: ['shape:code-first'],
  why: 'there is no code in this answer for anything to lead with' }
```

The plan had the question declare what it *could* exercise. That is the wrong
way round — an allowlist means a field added to the schema later is silently
`n/a` everywhere, and a check that quietly stops running is worse than one that
runs in the wrong place, because the second is visible. The declaration is also
per field **and value**: a bullet list can be produced for any question, so
Priya is still graded on the question where Sam is excused.

**A prohibition is always applicable.** You can always not do something. Only
requirements can be impossible to meet, which is why the `n/a` list is one
entry long and that entry is a requirement.

**The check counts what the prompt said.** The block promises "at most 120
words, not counting code" and the checker strips fenced code before counting.
If the two disagreed, a failure would mean the model disobeyed an instruction
it was never given — and a code-first answer would be punished for the
preference that asked for it.

One more, which only shows up in the numbers: **an unstated field is absent,
not passing.** A row of passes earned by saying nothing is how a compliance
score becomes a number that only goes up.

Violations are shown beside the reply with the rule they broke, and the turn is
**not asked again**. The checker stays a measuring instrument rather than a
control loop: a score achieved on the second attempt is a fact about the retry.

## The grid

```
                     Q1    Q2    Q3    Q4
  no profile          ·     ·     ·     ·     ← baseline: no block at all
  Дина                ·     ·     ·     ·
  Sam                 ·     ·     ·     ·
  Sam, again          ·     ·     ·     ·     ← the noise floor
  Priya               ·     ·     ·     ·
```

Twenty requests. Each cell holds the answer in full and a verdict per stated,
checkable field.

Two of the five rows are not profiles, and they are the two that make the
other three mean anything.

**The baseline** sends no block. Without it there are three answers that differ
from each other and no way to say what the default was, or which direction any
profile moved it.

**The repeat row** is the same profile and the same question in a second
request. Whatever differs there is the model disagreeing with itself. A verdict
the repeat could not reproduce is marked `?` and **dropped from the
denominator** — a denominator that quietly includes the coin-flips is a
denominator that makes every profile look about the same.

One repeat cannot characterise the variance. It can catch a field that is a
pure coin-flip, which is enough to stop the worst conclusion, and the
alternative — running the whole grid five times — costs five times as much to
learn something the transcript underneath each cell already suggests.

The four questions:

| | | exercises |
| --- | --- | --- |
| Q1 | How do I stop one client from hammering my API? | everything, code included |
| Q2 | Postgres or MongoDB for a new service that stores orders? | an opinion; code optional |
| Q3 | Why is it a bad idea to keep user sessions in server memory? | where `expertise` should show, and nothing can check it |
| Q4 | How should I tell the team that the launch date has slipped? | `shape: code-first` is `n/a` here, by declaration |

Q3 is the interesting one to read rather than to score. Дина and Priya are both
`novice` and Sam is `expert`; the answers should differ in what they assume,
and no checker in this repo can tell you whether they did.

There is a test that no question may contain a word Priya's jargon ban
forbids. The first draft of Q3 was "what is a connection pool?" — which is on
the list. She would have failed that cell every single run, and the column
would have been about the question rather than about her.

## The ablation — what it takes into account automatically

The grid shows that profiles produce different answers. It does not show which
*parts* of a profile did the producing, and a profile is a standing cost: every
line is in the system block of every request, forever. **A field that changes
nothing is not neutral. It is rent.**

So: one profile, one field dropped, the same questions re-asked — and the new
reply is graded against the **whole** profile, not the stripped one. That is
the whole trick. Grading against the stripped profile produces no verdict at
all for the field that was removed, because nothing was asked. The question is
not "did it obey an instruction it wasn't given", it is "would it have done
this anyway".

| outcome | means |
| --- | --- |
| **load-bearing** | obeyed when asked, broken when dropped — it is being taken into account |
| **free** | obeyed either way — the model does this anyway and the line is rent |
| **ignored** | not obeyed even when asked for |
| **unstable** | the two whole-profile runs disagreed; nothing is concluded |

Twelve requests: the whole profile twice (its own noise floor), then each
checkable field dropped in turn, across two questions. Sam's four ablatable
fields and what each costs him per request:

| dropped | tokens |
| --- | --- |
| `language: English` | 5 |
| `length: terse` | 14 |
| `shape: code-first` | 20 |
| `forbid: emoji, pleasantries` | 25 |

`language` is the row to watch. Both ablation questions are asked in English,
so a model that would answer in English regardless makes that line **free** —
five tokens on every request, forever, buying nothing. It is included precisely
because at least one field is expected to be free-riding, and a table where
every row confirms the design is a table that could not have surprised anyone.

**Only checkable fields are dropped.** Spending two requests to remove `tone:
dry` would buy a pair of answers nobody can adjudicate, and a comparison with
no verdict gets settled by whoever reads it last. The panel names the four
fields it left out rather than omitting them silently.

## What this repo has not measured

**Every table above is a fact about the code, not about a model.** The token
counts come from `node test.js`; the grid and ablation shapes come from the
harness; the outcomes come from nowhere, because **this repo has never been run
against a key.**

That is the same position task 11 was in, and the compensation is the same: 235
checks that run with no network, covering the schema, the block, all four
checkers, the applicability rules, the noise-floor arithmetic and the run loop
end to end against a fake transport.

The fake transport is the one exception to the no-stub rule and it is worth
being exact about. It returns a canned string per request. Its only job is to
prove the loop wires up — twenty cells in the right order with the right
profiles, one dead request not taking the run down, the repeat row compared
against the row it repeats. The moment a fake started *trying* to obey the
preferences, the grid would be measuring the fake.

So: run it with a key, and the numbers in the panel are yours. The numbers in
this file are the ones that hold without one.

## What it costs

One request per turn. The profile block is the only thing this task adds to it:
116–143 tokens, on every request, in the position that caches best. A grid run
is 20 requests and an ablation 12.

There is no cost tab, because there is no second call to account for. Task 11
needed one — a turn there was a reply plus an extraction. A turn here is a
reply.

## Where this is weakest

- **The thresholds are arbitrary.** 120 words for terse, 250 for thorough, 5
  bullets. They are fixed, documented and put into the prompt verbatim, which
  makes the comparisons valid and the absolute values meaningless.
- **Language detection is a script ratio.** It separates Russian from English
  and would not survive a third language sharing an alphabet.
- **Four fields cannot be checked at all**, including everything descriptive.
  They are shown as unchecked and excluded from every denominator, which is
  honest and is also a quarter of the profile that nothing here can say
  anything about.
- **The example marker is a word list.** "For example", "например", or a code
  fence. An example given without announcing itself is missed, and a sentence
  containing "such as" that gives no example is counted.
- **One repeat is not a variance estimate.** It catches a coin-flip and nothing
  finer, and every conclusion is about the run that produced it.
- **The ablation drops a field, not a sentence.** Removing `forbid` removes the
  whole ban line, so the two bans in it are reported separately but priced
  together.
- **No inferred preferences.** Every field has one provenance: a person typed
  it. An agent that noticed "actually, shorter please" and proposed a change
  would be a better assistant, and it would also be task 11's extraction
  pipeline, its candidate list, its promotion UI and its verbatim gate,
  imported to answer a question the brief does not ask.

## What was deliberately not built

Task 11 was 6,000 lines because three stores with three different policies, a
seven-rule router and an extraction contract are three subjects in one app.
This is 3,181, and the difference is not compression.

- **No memory layers.** The profile persists; the conversation does not. That
  is the entire link to task 11's model and it is one `localStorage` key.
- **No preference inference.** See above.
- **No repair loop.** A violated constraint is reported, not re-asked.
- **No cost tab.** One request per turn.

## Layout

- `index.html`, `styles.css` — the page; one colour per person, used in all three tabs
- `profile.js` — the schema, the three people, `compile()`, and the assembly
- `check.js` — one predicate per checkable field; three-valued verdicts
- `grid.js` — the questions, the five rows, the noise floor, the ablation
- `api.js` — the DeepSeek transport, slimmed from task 11 to one entry point
- `app.js` — the chat, the editor, the two tables; not one line of what-a-profile-is
- `markdown.js` — the reply renderer, carried from task 5
- `test.js` — 235 checks, no network, no key, no dependencies
