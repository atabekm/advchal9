# Task 13 — The task state machine · plan

Most agents that claim to have a state machine have a *narration*. The model
writes "moving on to execution now", everyone agrees to believe it, and nothing
anywhere can refuse. A state you cannot violate because it does nothing is not
a state machine — it is a caption.

So the claim this task is built to make is the other one:

> **The runtime owns the state. The model only proposes events, and a guard
> decides whether each one is legal.**

Every reply comes back as an envelope. The event inside it goes through
`legal(state, event)`, which either accepts it or rejects it with a named
reason, and rejections are rendered on screen. A state machine that has never
rejected anything has not been tested; it has been trusted.

## The one idea the rest follows from

The prompt for every turn is assembled from the state. Not from the state *plus*
the dialogue — from the state. There is no scrollback in the request, and there
is no separate "resume prompt" anywhere in the code.

Which means:

> **Every turn is a cold resume. Resuming is not a feature — it is the normal
> case, with the tab closed in between.**

This is what makes the brief's second bullet checkable instead of rhetorical. If
resume needed its own prompt, its own summary, its own re-explanation, then the
state was never sufficient and the demo would be rigged. Here the machine has no
other mode to fall back on, so *pause at any stage, reload the browser, carry
on* is not a special path being exercised — it is the only path, interrupted.

[Task 12](../task12) put one compiled block at message zero and measured what
the model did with it. This task compiles the **whole** request from a typed
object and measures whether that object is enough.

## What fits in it, and what does not

It holds **tasks**, not questions. The shape it assumes is specific: the work
decomposes into steps, each step produces an artifact, and what *done* means can
be said before any of it starts.

| goal | fits | why |
| --- | --- | --- |
| write a parser with tests | yes | decomposes, produces artifacts, done is statable |
| draft the migration plan for a service | yes | same shape, the artifacts are prose |
| review three files for races | yes | steps are the files, criteria are what counts as a finding |
| what is the capital of France | **legally** | one step, one criterion, and 300 tokens of scaffolding around a three-token answer |
| let us explore whether to move off Postgres | no | the goal is recorded once and the arc is a line |
| find why this test flakes | **badly** | step 2 cannot be known until step 1 reports back |

The France row is the uncomfortable one, and it is written here rather than
engineered away. The machine has no notion of *this does not need me*, and every
event in that run would be legal. There is no triage gate, deliberately: a gate
is a model deciding whether the machine applies, which is the narrated-state
problem walking back in through a side door. This is a task machine and not a
chat, and the answer to "what about questions" is not to put them in it.

The flaking-test row is the real limitation. The plan is frozen at
`approve_plan`, and the only flex during execution is `skip_step`. An
`insert_step` event was considered and cut: letting the plan grow would cover
discovery work, and it would also mean the plan the model proposed is no longer
a stable object for the experiment to compare against. Fixed plan, named
limitation.

## The three fields the brief asks for

They are three different questions and they fail in three different ways.

| field | answers | example | when it's wrong |
| --- | --- | --- | --- |
| **stage** | where in the arc | `execution` | the agent does validation work during planning |
| **step** | which item of the plan | `3 of 6 · active` | the agent redoes something already done |
| **expected action** | **who may move next, and with what** | `model · attach_artifact` | the agent answers when it was the user's turn |

The third is the one that is usually missing, and it is the one that makes pause
meaningful. A machine that knows only its stage cannot tell "working" from
"waiting" — and *waiting* is where every pause lands.

## Pause is not a state

The tempting design is a fifth stage called `paused`. It is wrong twice over:
you need an edge from every stage into it and an edge back out, and the moment
you take the first one you have thrown away *where you were*.

So pause suspends the machine; the stage underneath is untouched.

| looks like a state | is actually |
| --- | --- |
| `paused` | a flag on the machine — the stage keeps its value |
| `blocked` | `expect.actor = 'user'` — the machine is waiting, not stuck |
| `failed` | `done` with `outcome: 'abandoned'` |

Four stages, exactly as the brief names them, and the arc is a **line**:

```
  planning ──▶ execution ──▶ validation ──▶ done
```

No back edges. Validation that finds an unmet criterion does not bounce to
planning or to execution; it records the criterion as unmet and asks the user to
`accept` or `abandon`. This is a real limitation and the README will say so: the
machine can tell you the work failed, and it cannot fix it. It is the same
choice task 12 made about its checker — a measuring instrument that repairs what
it measures is measuring the repair.

## State

```js
{
  goal:       'the request, verbatim, recorded once',
  stage:      'execution',
  steps:      [ { id, title, status, artifact, note } ],   // pending·active·done·skipped
  cursor:     2,                                            // which step is active
  acceptance: [ { id, text, verdict, evidence } ],          // unknown·met·unmet
  decisions:  [ { at, text } ],                             // settled — never re-asked
  expect:     { actor: 'model', kind: 'attach_artifact', why: '…' },
  paused:     false,
  outcome:    null,
}
```

`decisions` exists because "without re-explaining" has to mean something
specific. It is the list of things the user already settled, and a resumed agent
that asks about one of them has failed a check that can be run automatically.

`acceptance` exists because **planning must pre-register what done means.**
The planning stage cannot close without it. Without that rule, validation is the
model agreeing with itself about a standard it invented after seeing the work —
which is the failure mode that makes most "validation" stages worthless.

## State is a fold, not an object

Nothing mutates the state. Events are appended to a log, and
`reduce(log) → state`. Persistence is the log; a reload folds it again and lands
on the same screen.

This is not architecture for its own sake. It buys three things this task needs:

- **pause/resume is free and provable** — resuming is replaying, and the replay
  is in front of you
- **the log is the video** — the pause shows up in it, timestamped, between two
  events, with whatever the model tried to do next
- **the tests can fuzz it** — throw random event streams at the reducer and
  assert that no sequence, legal or illegal, produces an invariant violation or
  a throw

`invariants(state)` is a real function, not a comment: at most one step active,
`cursor` agrees with the statuses, `acceptance` non-empty once past planning,
`expect` non-null unless terminal. It runs after every apply, in the app and in
the tests.

## Events, and who may emit them

| event | actor | legal when | does |
| --- | --- | --- | --- |
| `start` | user | no state | records the goal, opens planning |
| `propose_plan` | model | planning | sets `steps` **and** `acceptance` |
| `approve_plan` | user | plan proposed | opens execution on step 1 |
| `revise_plan` | user | plan proposed | back to the model with a note |
| `attach_artifact` | model | a step is active | stores the work on that step |
| `complete_step` | model | active step has an artifact | advances; last step opens validation |
| `skip_step` | model | a step is active | requires a reason |
| `ask_user` | model | any non-terminal stage | flips `expect` to the user — the machine blocks |
| `answer` | user | `expect.actor = 'user'` | recorded as a **decision**; `expect` restored |
| `validate` | model | validation | a verdict + evidence per acceptance criterion |
| `accept` / `abandon` | user | validation | closes the machine with an outcome |
| `pause` / `resume` | user | anywhere | the flag, in the log, where it happened |

Rejection reasons are a **closed set** of twelve — `wrong-stage`,
`wrong-actor`, `wrong-kind`, `paused`, `terminal`, `malformed`, `unknown-step`,
`wrong-step`, `missing-artifact`, `missing-acceptance`, `unknown-criterion`,
`incomplete-verdicts` — so the README has rows to print and the tests have exact
strings to assert. A thirteenth, `no-active-step`, was written and then deleted:
execution always has exactly one active step, so nothing could ever reach it.
The test that says *every reason is provoked by a scenario above* is what found
it, and that test is the reason the set stays closed rather than merely being
called closed.

## Who decides what

"Stage" and "step" are settled by different parties, and they never overlap.

| what | decided by | when |
| --- | --- | --- |
| **the stage set** — that there are four, and which | **code** | build time; neither model nor user can add one |
| **which stage you are in** | **the reducer** | derived from events, never requested |
| the steps | model proposes → user approves or revises | at planning |
| the acceptance criteria | model proposes → user approves | at planning, frozen afterwards |
| which step is active | the reducer, via `cursor` | on `complete_step` / `skip_step` |
| who moves next | the reducer, via `expect` | after every accepted event |

Two lines in that table carry most of the design.

**Stage changes are derived, not requested.** There is no `go_to_validation`
event. Validation is entered because the last step completed. The model can
influence the stage only by doing work that causes it, which closes off the
entire class of an agent declaring itself finished.

**The user ratifies; the user does not author.** Approve a plan or send it back
with a note, answer a question, accept or abandon. Hand-authoring the steps
would stop the experiment measuring the agent and start it measuring the person.

## The envelope, and one retry

```json
{ "say": "prose for the human",
  "event": { "kind": "complete_step", "step": "s3" } }
```

The prompt tells the model which event kinds are legal *right now*, because the
legal set is a function of state — that is the difference between a rule the
model is told about and a rule it is inside of.

When the guard rejects, the rejection is rendered with its reason, and the model
gets **one** more attempt with that reason fed back. Then it stops and hands the
turn to the user.

One, and counted. Unbounded auto-repair would make the app feel better and the
evidence worthless: you could no longer tell a machine the model obeys from one
it fights. The retry rate is a number the README prints.

## How a turn runs, and what "execution" actually means

The app is a turn engine. One turn:

```
compile(state) ──▶ one request ──▶ parse envelope ──▶ legal(state, event)?
                                                          │
                        ┌─── rejected ──▶ retry once ─────┤
                        │                                 │
                        └─── accepted ──▶ apply ──▶ append ──▶ persist
                                                          │
                                       expect.actor === 'model' ? loop : stop
```

| stage | requests | what the work *is* |
| --- | --- | --- |
| planning | 1 | the model emits steps and criteria, then stops and waits |
| execution | 2 per step — `attach_artifact`, `complete_step` | the model **writes text** |
| validation | 1 | the model reads its own artifacts against the frozen criteria |
| done | 0 | — |

A four-step task is about ten requests.

`execution` is a flattering word for it and the README will say so plainly:
**nothing runs.** No tool is called, no code is executed, no file is touched.
The artifact is text the model produced. Machine-checked acceptance criteria
were considered — a predicate the runtime evaluates against the artifact, in the
spirit of task 12's `check.js` — and cut, because it makes the subject of the
task *checking* rather than *state*. Every criterion is prose, every verdict is
the model's, and validation is self-assessment whose only real constraint is
that the standard was frozen before the work existed.

The loop auto-continues while `expect.actor === 'model'`, which is what makes it
an agent rather than a form. It runs on a leash: **six consecutive model turns**,
then it hands back regardless. Runaway is the default failure of anything that
continues itself, and the fix is one integer.

## The measurement: three ways to resume

The brief says *continuing without re-explaining*. That is a claim about what
the next turn needs, so it is measured by holding the pause point fixed and
varying what gets sent.

| arm | what goes up | expected |
| --- | --- | --- |
| **transcript** | the reconstructed dialogue | the control — what everyone does today |
| **state** | the compiled state, nothing else | the claim — same next action, a fraction of the tokens |
| **state again** | the same request, a second time | the noise floor, carried from task 12 |
| **goal only** | the original request and nothing else | the floor — should visibly re-ask and redo |

Three fixtures — paused in planning, mid-execution, in validation — × four
columns = **twelve requests**.

The fixtures are hand-written states, not states arrived at by a live run. That
makes the experiment deterministic, cheap to re-run, and usable by `test.js`
with no network — and it is honest, because a state pickled at a pause point is
exactly what a pause produces.

Every cell is graded on things that are decidable:

| check | how |
| --- | --- |
| **legal** | the envelope parsed and the guard accepted it for the open slot |
| **no redo** | it did not act on a step already `done` |
| **no re-ask** | it did not ask about anything in `decisions` — *heuristic, and labelled as one* |
| **tokens** | prompt tokens, from the API's own usage block |
| **retries** | rejections before a legal event |

The headline was meant to be one ratio: tokens(state) ÷ tokens(transcript),
with `legal` and `no redo` holding in both.

*Measured, with no model asked and no key needed: the state is **not** a
fraction of the transcript. At the three pause points it is ×0.88, ×0.91 and
×1.02 of one. The scaffold a state pays for — the headers, the statuses, the
standing, the slot — costs about what the talk around a tidy transcript costs,
and both arms carry every token of the actual work because neither can drop
any of it.*

*So the compression claim is withdrawn. What replaces it is stronger, because
it is structural rather than incidental: the state is a function of the
machine, so anything that happens without moving the machine costs it nothing
at all. Eight refused attempts add zero tokens to the state and about fifty
each to the transcript. The state line is flat by construction. That, and not
a ratio, is what a state machine buys, and the page prints the curve.*

## What is deliberately not built

- **No tool execution.** Steps produce text artifacts. A sandbox is a second
  subject, and every claim here is about the state, not about the work.
- **No replanning.** The arc is a line. Named as a limitation, not hidden.
- **No growing the plan.** No `insert_step`; the plan is what was approved.
- **No mechanical acceptance criteria.** The model judges every one of them.
- **No triage gate.** The machine cannot tell you a goal is too small for it.
- **No memory layers, no profile.** Tasks 11 and 12 built those. The only thing
  that persists here is the log.
- **No multi-agent anything.** One model, one machine, one log.

## Where this will be weakest, predicted now

- **The guard constrains shape, not truth.** Nothing stops the model attaching a
  useless artifact and legally calling the step done. Validation is the only
  check on that, and it is the same model. This is the honest ceiling of the
  whole design and it belongs in the README in those words.
- **"No re-ask" is a heuristic.** Question marks and overlap with `decisions`.
  It will miss a paraphrase.
- **The transcript arm is reconstructed.** A real dialogue would be longer and
  messier, so the token ratio understates the saving — biased against the claim,
  which is the direction to be wrong in.
- **The ratio is not a constant, and the state is not flat.** Artifacts are
  quoted in full, because step 3 usually needs step 2's output and validation
  needs all of it, so the state grows with the work. What it does not carry is
  the *talking* — the prose around each artifact, the superseded attempts, the
  rejected events, and a settled question reduced to one line. The saving is
  the talking, not the work, and the number is a property of the pause point.
- **Nothing executes.** "Execution" is the model writing text, and validation is
  the same model reading it back. The frozen standard is the only thing making
  that better than a vibe, and it is not independence.
- **Three fixtures is a small sample.** The repeat column measures the noise; it
  cannot characterise it.

## Stages

| # | stage | ships |
| --- | --- | --- |
| 1 | the machine | stages, events, guards, `apply`, `reduce`, `invariants`, the fuzz |
| 2 | the protocol | `compile(state)`, the envelope, parse + validate, the closed rejection set, the one retry |
| 3 | the run | the app, pause, survives a reload, the log tab with export/import |
| 4 | the resume experiment | three fixtures, four columns, the grading, the ratio |
| 5 | the writing | README |

## Layout

- `index.html`, `styles.css` — the page; three tabs
- `machine.js` — stages, events, guards, the reducer, the invariants
- `protocol.js` — `compile(state)`, the envelope, the rejection reasons
- `store.js` — the log in `localStorage`, snapshot, export, import
- `resume.js` — the fixtures, the four arms, the grading
- `api.js` — the DeepSeek transport, carried from task 12
- `app.js` — the task tab, the log tab, the experiment tab
- `markdown.js` — the reply renderer, carried from task 5
- `test.js` — checks with no network and no key, including booting the page
  against a shimmed DOM, which is the one thing standing between this repo and
  a blank screen
