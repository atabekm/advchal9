# A state the model cannot narrate

Most agents that claim to have a state machine have a *narration*. The model
writes "moving on to execution now", everyone agrees to believe it, and nothing
anywhere can refuse. A state you cannot violate — because it does nothing — is
not a state machine. It is a caption.

So this task is built around the other arrangement:

> **The runtime owns the state. The model only proposes events, and a guard
> decides whether each one is legal.**

Every reply comes back as an envelope. The event inside it goes through
`legal(state, event)`, which either accepts it or refuses it by name, and the
refusals are on screen. A state machine that has never rejected anything has not
been tested. It has been trusted.

## Running it

Open `index.html`. No server, no build, no dependencies — the same as task 4
through task 12. Storage keys are namespaced `task13.*`.

`node test.js` runs 431 checks with no network and no key. That includes 90,000
fuzzed events against the reducer, and booting the page itself against a
shimmed DOM to run a whole task end to end through the actual buttons — which
is the only thing standing between this repo and a blank screen. It caught two
real bugs in the writing of it; see *What the tests deleted* below.

The **resuming** tab has two tables that need no key at all, because they are
counted rather than asked for. The chat and the twelve-request experiment need
a DeepSeek key.

## The one idea the rest follows from

Every request is assembled from the state. Not from the state *plus* the
dialogue — from the state. There is no scrollback in the request, and there is
no second version of `compile()` anywhere in the code for resuming.

Which means:

> **Every turn is a cold resume. Resuming is not a feature — it is the normal
> case, with the tab closed in between.**

This is what makes the brief's second bullet checkable rather than rhetorical.
If resume needed its own prompt, its own summary, its own re-explanation, then
the state was never sufficient, and the demo would be rigged. Here the machine
has no other mode to fall back on, so *pause at any stage, reload the browser,
carry on* is not a special path being exercised. It is the only path,
interrupted.

The test says it directly. Compile the request before a pause, fold the log back
from storage after one, compile again — the bytes are equal, at all three
stages, and the word "pause" appears nowhere in either.

[Task 12](../task12) put one compiled block at message zero and measured what
the model did with it. This one compiles the **whole** request from a typed
object and asks whether that object is enough.

## The three fields the brief asks for

They are three different questions and they fail three different ways.

| field | answers | example | when it is wrong |
| --- | --- | --- | --- |
| **stage** | where in the arc | `execution` | validation work happens during planning |
| **step** | which item of the plan | `s2 · active` | something already done is done again |
| **expected action** | **who may move next, and with what** | `model · attach_artifact` | the agent answers when it was your turn |

The third is the one usually missing, and it is the one that makes pause mean
anything. A machine that knows only its stage cannot tell *working* from
*waiting* — and waiting is where every pause lands.

## Pause is not a state

The tempting design is a fifth stage called `paused`. It is wrong twice: you
need an edge from every stage into it and an edge back out, and the moment you
take the first one you have thrown away *where you were*.

So pause suspends the machine, and the stage underneath is untouched.

| looks like a state | is actually |
| --- | --- |
| `paused` | a flag — the stage, the step and the slot keep their values |
| `blocked` | `expect.actor = 'user'` — waiting, not stuck |
| `failed` | `done` with `outcome: 'abandoned'` |

Four stages, exactly the four the brief names, and the arc is a **line**:

```
  planning ──▶ execution ──▶ validation ──▶ done
```

There are no back edges. Validation that finds an unmet criterion does not
bounce to planning or to execution; it records the criterion as unmet and asks
you to `accept` or `abandon`. This is a real limitation and it is not hidden:
the machine can tell you the work failed, and it cannot fix it. It is the same
choice task 12 made about its checker — an instrument that repairs what it
measures is measuring the repair.

The test holds the flag down at all three working stages: paused, the stage, the
steps and the slot are byte-for-byte what they were; `resume` is the only legal
event; and resuming restores the state exactly.

## Three parties decide different things, and never overlap

| what | decided by | when |
| --- | --- | --- |
| **the stage set** — that there are four, and which | **code** | build time; neither model nor user can add one |
| **which stage you are in** | **the reducer** | derived from events, never requested |
| the steps | model proposes → user approves or revises | at planning |
| the acceptance criteria | model proposes → user approves | at planning, frozen after |
| which step is active | the reducer, via `cursor` | on `complete_step` / `skip_step` |
| who moves next | the reducer, via `expect` | after every accepted event |

Two rows carry most of the design.

**Stage changes are derived, not requested.** There is no `go_to_validation`
event. Validation is entered because the last step closed. The model can
influence the stage only by doing work that causes it, which closes off the
whole class of an agent declaring itself finished. A test asserts that no event
kind names a stage, and that no event is legal in `done`.

**The user ratifies; the user does not author.** Approve a plan or send it back
with a note, answer a question, accept or abandon. Hand-authoring the steps
would stop the experiment measuring the agent and start it measuring the person.

## Planning cannot close without saying what done means

The planning stage will not accept a plan that is only steps. Steps and
acceptance criteria arrive in one event or the plan is refused, by name, with
`missing-acceptance`:

```
✗ propose_plan · missing-acceptance
  a plan has to say what would count as done, and it has to say it now —
  before any work exists to judge
```

Without that rule, validation is the model agreeing with itself about a standard
it invented after seeing the work — which is the failure that makes most
"validation" stages worthless. The criteria are frozen at approval and nothing
afterwards can revise them, which is stated in the prompt so the model knows to
write ones it is willing to be held to.

## The events, and the closed set of refusals

| event | actor | legal when | does |
| --- | --- | --- | --- |
| `start` | user | nothing has begun | records the goal, opens planning |
| `propose_plan` | model | planning | sets steps **and** criteria |
| `approve_plan` | user | a plan exists | opens execution on step 1 |
| `revise_plan` | user | a plan exists | throws it away; the note becomes a decision |
| `attach_artifact` | model | a step is active | stores the work on that step |
| `complete_step` | model | the active step has an artifact | advances; the last one opens validation |
| `skip_step` | model | a step is active | requires a reason |
| `ask_user` | model | any working stage | flips the slot to you; the machine blocks |
| `answer` | user | the slot is yours | recorded as a **decision**; the slot is restored |
| `validate` | model | validation | a verdict and evidence per criterion |
| `accept` / `abandon` | user | validation | closes the machine with an outcome |
| `pause` / `resume` | user | any working stage | the flag, in the log, where it happened |

Twelve refusal reasons, and they are a closed set: `wrong-stage`, `wrong-actor`,
`wrong-kind`, `paused`, `terminal`, `malformed`, `unknown-step`, `wrong-step`,
`missing-artifact`, `missing-acceptance`, `unknown-criterion`,
`incomplete-verdicts`.

Closed is a claim, so a test enforces it from both sides: every reason must be
provoked by a scenario in the suite, and nothing may be refused for a reason
outside the set. The fuzz then walks 90,000 random events — half drawn from what
is legal right now, so the walk reaches validation and `done` rather than dying
in planning — and asserts that no sequence throws, none breaks an invariant, and
none produces an unknown reason.

## One retry, and it is counted

When the guard refuses, the refusal is rendered with its reason and the model
gets **one** more attempt with that reason appended to the same state block:

```
YOUR LAST EVENT WAS REJECTED
  kind:   complete_step
  reason: missing-artifact — step s1 has no artifact — attach one before completing it

  Read the state above again and emit one event that the machine accepts.
  This is your second and last attempt this turn.
```

One, not unbounded. Unbounded auto-repair would make the app feel better and the
evidence worthless: you could no longer tell a machine the model obeys from one
it fights. After the second refusal the turn goes back to you.

The engine also runs on a leash — **six consecutive model turns**, then it stops
whatever the machine wants and offers a *continue* button. Runaway is the
default failure of anything that continues itself, and the fix is one integer. A
test drives a four-step plan at it and watches the leash catch after three steps.

## What the state carries, and what it drops

Artifacts are quoted in full, because step 3 usually needs step 2's output and
validation needs all of it. What the state does not carry is the **talking**:
the prose around each artifact, the envelopes, every attempt the guard refused,
and a settled question reduced to one line.

```
ALREADY SETTLED — do not ask about any of this again
  · Should '2d4h' parse, or are days out of scope? — Hours and minutes only.
```

That list is also what makes *re-explaining* measurable rather than impressionistic:
there is an explicit record of what the person settled, so a resumed agent asking
about one of them is a fact you can test for.

## The measurement, and the prediction it refuted

Three pause points down one task — paused in planning after a revision, paused
mid-execution with one step closed and one question settled, paused in
validation with every artifact attached — each resumed four ways:

| arm | what goes up |
| --- | --- |
| transcript | the dialogue those events would have been, in full |
| **state** | `compile(state)` and nothing else |
| state again | the identical request, a second time — the noise floor |
| goal only | the original sentence and nothing else |

The plan predicted the state would be a fraction of the transcript. **It is
not.** Counted with no model asked and no key needed:

| pause point | work | state | its scaffold | transcript | its talk | state ÷ transcript |
| --- | --- | --- | --- | --- | --- | --- |
| planning | 48 | 162 | 114 | 185 | 137 | ×0.88 |
| execution | 178 | 328 | 150 | 360 | 182 | ×0.91 |
| validation | 359 | 588 | 229 | 578 | 219 | **×1.02** |

Work is the substance — artifacts, titles, criteria, what was settled. Both arms
carry every token of it and neither can drop any. What is left over is what each
one pays on top, and a state's scaffold costs about what a tidy transcript's
talk costs. At the deepest pause the state is the *dearer* of the two.

So the compression claim is withdrawn. What replaces it is structural rather
than incidental, and it is the stronger claim:

> **The state is a function of the machine, so anything that happens without
> moving the machine costs it nothing at all.**

A transcript has no such property. Every refused attempt stays in it forever.
Walking the same fixtures forward through rounds of a model getting it wrong:

| pause point | arm | 0 | 1 | 2 | 4 | 8 refusals | per refusal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| planning | state | 162 | 162 | 162 | 162 | 162 | **flat** |
| | transcript | 185 | 235 | 285 | 385 | 585 | +50 |
| execution | state | 328 | 328 | 328 | 328 | 328 | **flat** |
| | transcript | 360 | 410 | 460 | 560 | 760 | +50 |
| validation | state | 588 | 588 | 588 | 588 | 588 | **flat** |
| | transcript | 578 | 628 | 678 | 778 | 978 | +50 |

The state line is flat by construction, not by tuning. One refusal is enough to
put the transcript ahead at every pause point, and refusals are the commonest
thing that happens in a real run — that is what the guard is *for*. That is what
a state machine buys, and it is not what anyone advertises.

## What the twelve requests grade

Every arm is graded against the same machine. What an arm was *told* has no
bearing on what the guard will accept.

| check | decided by |
| --- | --- |
| **legal** | the guard, on the true state |
| **no redo** | arithmetic — did it act on a step already closed, or re-plan a plan that exists |
| **no re-ask** | *a heuristic* — word overlap against `decisions` |
| **tokens** | the API's own usage block |
| **retries** | how many refusals before a legal event |

The floor arm fails by emitting the wrong *kind* of event for the open slot,
which is a guard refusal rather than a judgement call. That is what makes "it
re-explained itself" a decidable fact here instead of an impression.

The re-ask check is the one heuristic in the repo and it is labelled as one
everywhere it appears. It has no stemming and no meaning: a test shows it
catching *"Is 2d4h in or out?"* and missing *"Do longer units than an hour
belong here?"*, which reopens exactly the same settled point.

The transcript arm carries the refused attempts and the model's prose, because a
real dialogue does. Building the arm this task argues against out of a tidier
conversation than actually happens would be rigging the comparison.

## The honest ceiling

Nothing runs. `execution` is a flattering word for *the model wrote text*: no
tool is called, no code is executed, no file is touched. Validation is the same
model reading its own artifacts back, and the only thing keeping that from being
circular is that the standard was frozen before the work existed. That is a real
constraint and it is not independence.

Which means the guard constrains **shape, not truth**. Every event in a run can
be legal and the work can still be wrong:

```
a1  parse_duration('1h30m') returns 5400            met    — test_basic asserts 5400
a2  a bare '45m' and a bare '2h' both parse         met    — test_single_unit covers both
a3  an unparseable string raises ValueError         unmet  — it returns None on "abc"
```

Legal at every step, and two criteria short. Mechanical acceptance criteria — a
predicate the runtime evaluates, in the spirit of task 12's `check.js` — were
considered and cut, because they would make the subject of this task *checking*
rather than *state*.

## What the tests deleted

Two things the suite removed rather than confirmed, which is the reason to write
tests that can disagree with you.

**A dead refusal reason.** `no-active-step` was in the closed set and was
unreachable: execution always has exactly one active step, so nothing could ever
produce it. The test asserting that every reason is provoked by a scenario found
it, and the set is now twelve.

**A name collision across two files.** `protocol.js` and `store.js` both
declared `parse()`. That is the exact bug that shipped a blank screen in task 12,
so the check now derives the script list from `index.html` — not from a list
written in the test — and compares every top-level name across every pair of
files.

A third thing was not a bug but was worse: three waits in the page test were
satisfied by the word "done" inside the empty-plan placeholder, so they were
passing *before the model had replied at all*. Counting step rows is the reading
that a sentence cannot accidentally satisfy.

The execution slot changed too. It offers `attach_artifact`, `complete_step` and
`skip_step` together rather than only the one that fits, so a model trying to
close an empty step is told `missing-artifact — attach one before completing it`,
which says what to do next, instead of `wrong-kind`, which does not. The slot is
narrower than the payload guard on purpose.

## What it costs

The static rules are 471 tokens and are identical on every request of every run,
which is what a prompt cache is for. The state block is 162 to 588 tokens at the
three pause points. A clean three-step task is eight requests: one plan, two per
step, one validation — plus whatever the guard sends back.

## Where this is weakest

- **Nothing executes.** The ceiling above. `execution` means the model wrote
  text, and validation is that same model reading it back.
- **The arc is a line.** Validation that fails cannot send the work back. It is
  recorded and you choose; the machine cannot finish a task it got wrong.
- **The plan is frozen at approval.** Work where step 2 cannot be known until
  step 1 reports back is out of scope. `insert_step` was considered and cut: a
  plan that grows is no longer a stable object for the experiment to compare
  against.
- **The re-ask check is a heuristic** and misses paraphrases, demonstrably.
- **Three fixtures.** The repeat arm measures the model's variance; one repeat
  cannot characterise it. Every conclusion is about this run.
- **The transcript arm is reconstructed**, not recorded. It is the same events
  rendered as a conversation — tidier than a real one, which biases the token
  comparison *against* the state, which is the direction to be wrong in.
- **There is no triage gate.** Ask this machine for the capital of France and it
  will plan it, execute it and validate it, every event legal. It is a task
  machine, not a chat, and it cannot tell you a goal is too small for it.

## What was deliberately not built

No tool execution or sandbox. No replanning, no `insert_step`, no mechanical
acceptance criteria, no triage gate. No memory layers and no profile — tasks 11
and 12 built those, and the only thing that persists here is the log.

## Layout

- `index.html`, `styles.css` — the page; three tabs
- `machine.js` — stages, events, guards, the reducer, the invariants
- `protocol.js` — `compile(state)`, the envelope, the refusal reasons
- `store.js` — the log in `localStorage`, export, import
- `resume.js` — the fixtures, the four arms, the grading, the two counted tables
- `api.js` — the DeepSeek transport, carried from task 12
- `app.js` — the turn engine and the three tabs
- `markdown.js` — the reply renderer, carried from task 5
- `test.js` — 431 checks, no network and no key
