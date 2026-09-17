/* The experiment: three pause points, four ways to resume from each.
 *
 * "Continuing without re-explaining" is a claim about what the next turn
 * needs, so it is measured by holding the pause point fixed and varying what
 * gets sent. The arms are graded against the same machine in every case — what
 * an arm was *told* has no bearing on what the guard will accept.
 *
 * The fixtures are logs rather than states, because a state is a fold over a
 * log and writing the fold by hand would be writing a second source of truth.
 * They are hand-written rather than produced by a live run so that the whole
 * experiment is deterministic, cheap to repeat, and testable with no network —
 * and that is honest, because a log pickled at a pause point is exactly what a
 * pause produces.
 */

const GOAL = "Write a Python function that parses a duration like '1h30m' into seconds, with tests.";

const STEPS = [
  { title: 'Fix the grammar the parser accepts and how it fails' },
  { title: 'Write parse_duration' },
  { title: 'Write the tests' },
];

const ACCEPTANCE = [
  { text: "parse_duration('1h30m') returns 5400" },
  { text: "a bare '45m' and a bare '2h' both parse" },
  { text: 'an unparseable string raises ValueError rather than returning None' },
];

const GRAMMAR = `Accepted: an optional hours part and an optional minutes part, in that
order, at least one of them present.

    <duration> ::= [<int> "h"] [<int> "m"]

Whitespace is not allowed. Anything else — an empty string, "abc", "1x",
"30m1h", a negative number — raises ValueError. Days are out of scope.`;

const FUNCTION = `def parse_duration(text: str) -> int:
    match = re.fullmatch(r"(?:(\\d+)h)?(?:(\\d+)m)?", text)
    if not match or not text:
        raise ValueError(f"not a duration: {text!r}")
    hours, minutes = match.groups()
    if hours is None and minutes is None:
        raise ValueError(f"not a duration: {text!r}")
    return int(hours or 0) * 3600 + int(minutes or 0) * 60`;

const TESTS = `def test_hours_and_minutes():
    assert parse_duration("1h30m") == 5400

def test_single_unit():
    assert parse_duration("45m") == 2700
    assert parse_duration("2h") == 7200

def test_rejects_rubbish():
    for bad in ["", "abc", "1x", "30m1h"]:
        with pytest.raises(ValueError):
            parse_duration(bad)`;

/* Three pause points down one task, so the depth of the pause is the only
 * thing that differs between the rows. */
const FIXTURES = [
  {
    id: 'planning',
    label: 'paused in planning, after a revision',
    slot: 'propose_plan',
    log: [
      { at: 1, kind: 'start', goal: GOAL },
      { at: 2, kind: 'propose_plan', say: 'Six steps, and what I would be judged on.',
        steps: [
          { title: 'Survey duration formats in the wild' },
          { title: 'Choose a grammar' },
          { title: 'Write a tokeniser' },
          { title: 'Write the parser' },
          { title: 'Write the tests' },
          { title: 'Write the docstring' },
        ],
        acceptance: ACCEPTANCE },
      { at: 3, kind: 'revise_plan',
        note: 'Too many steps, and no survey — three is enough, and a regex will do instead of a tokeniser.' },
    ],
  },
  {
    id: 'execution',
    label: 'paused mid-execution, one step closed and one question settled',
    slot: 'attach_artifact',
    log: [
      { at: 1, kind: 'start', goal: GOAL },
      { at: 2, kind: 'propose_plan', say: 'Three steps.', steps: STEPS, acceptance: ACCEPTANCE },
      { at: 3, kind: 'approve_plan' },
      { at: 4, kind: 'complete_step', step: 's1', say: 'The grammar is obvious enough, closing it.',
        rejected: 'missing-artifact', detail: 'step s1 has no artifact — attach one before completing it' },
      { at: 5, kind: 'attach_artifact', step: 's1', artifact: GRAMMAR, say: 'Written out properly.' },
      { at: 6, kind: 'complete_step', step: 's1', say: 'Grammar settled.' },
      { at: 7, kind: 'ask_user', say: 'One thing before I write it.',
        question: "Should '2d4h' parse, or are days out of scope?" },
      { at: 8, kind: 'answer', text: 'Hours and minutes only. Days are out of scope.' },
    ],
  },
  {
    id: 'validation',
    label: 'paused in validation, with every artifact attached',
    slot: 'validate',
    log: [
      { at: 1, kind: 'start', goal: GOAL },
      { at: 2, kind: 'propose_plan', say: 'Three steps.', steps: STEPS, acceptance: ACCEPTANCE },
      { at: 3, kind: 'approve_plan' },
      { at: 4, kind: 'attach_artifact', step: 's1', artifact: GRAMMAR, say: 'The grammar.' },
      { at: 5, kind: 'complete_step', step: 's1', say: 'Closing s1.' },
      { at: 6, kind: 'ask_user', say: 'One thing before I write it.',
        question: "Should '2d4h' parse, or are days out of scope?" },
      { at: 7, kind: 'answer', text: 'Hours and minutes only. Days are out of scope.' },
      { at: 8, kind: 'attach_artifact', step: 's2', artifact: FUNCTION, say: 'The parser.' },
      { at: 9, kind: 'complete_step', step: 's2', say: 'Closing s2.' },
      { at: 10, kind: 'attach_artifact', step: 's3', artifact: TESTS, say: 'The tests.' },
      { at: 11, kind: 'complete_step', step: 's3', say: 'Closing s3.' },
    ],
  },
];

const ARMS = [
  { id: 'transcript', label: 'transcript',
    note: 'the dialogue those events would have been, in full — what everyone does today' },
  { id: 'state', label: 'state',
    note: 'compile(state) and nothing else — no dialogue anywhere in the request' },
  { id: 'again', label: 'state again',
    note: 'the identical request, a second time — whatever differs here is the model disagreeing with itself' },
  { id: 'goal', label: 'goal only',
    note: 'the original sentence and nothing else — the floor' },
];

/* ------------------------------------------------------- what each arm sends */

/* The transcript is the same events told as a conversation, including the ones
 * the guard refused — because a real dialogue carries its failures, and
 * pretending otherwise would flatter the arm this task is arguing against. */
function transcriptMessages(fixture) {
  const messages = [{ role: 'system', content: Protocol.RULES }];
  for (const entry of fixture.log) {
    const spec = Machine.EVENTS[entry.kind] || {};
    if (spec.actor === 'model' || entry.rejected) {
      const { at, say, rejected, detail, ...event } = entry;
      messages.push({ role: 'assistant', content: JSON.stringify({ say: say || '', event }) });
      if (entry.rejected) {
        messages.push({ role: 'user', content: `REJECTED — ${entry.rejected}: ${entry.detail}` });
      }
      continue;
    }
    if (entry.kind === 'start') messages.push({ role: 'user', content: `THE GOAL\n  ${entry.goal}` });
    else if (entry.kind === 'approve_plan') messages.push({ role: 'user', content: 'Approved. Go ahead.' });
    else if (entry.kind === 'revise_plan') messages.push({ role: 'user', content: entry.note });
    else if (entry.kind === 'answer') messages.push({ role: 'user', content: entry.text });
  }
  messages.push({ role: 'user', content: 'Continue. Emit the next event.' });
  return messages;
}

function goalMessages(fixture) {
  return [
    { role: 'system', content: Protocol.RULES },
    { role: 'user', content: `THE GOAL\n  ${GOAL}\n\nContinue. Emit the next event.` },
  ];
}

function messagesFor(arm, fixture, state, rejection) {
  if (arm === 'transcript') {
    const messages = transcriptMessages(fixture);
    if (!rejection) return messages;
    return [...messages, { role: 'user', content: Protocol.nudge(rejection) }];
  }
  if (arm === 'goal') {
    const messages = goalMessages(fixture);
    if (!rejection) return messages;
    return [...messages, { role: 'user', content: Protocol.nudge(rejection) }];
  }
  return Protocol.messages(state, { rejection });
}

/* ------------------------------------------------------------- the grading */

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'does', 'should', 'would', 'or',
  'and', 'to', 'of', 'in', 'for', 'it', 'be', 'i', 'you', 'we', 'that', 'this', 'with', 'on',
  'what', 'which', 'how', 'can', 'if', 'as', 'at', 'by', 'from', 'not', 'any']);

function words(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9']+/g)?.filter((word) => !STOPWORDS.has(word)) || []);
}

function overlap(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/* A heuristic, and the only one here. Everything else in this file is decided
 * by the guard or by arithmetic; this is a word-overlap test against what the
 * person already settled, and it will miss a paraphrase that shares no words. */
function reAsk(state, event) {
  if (!event || event.kind !== 'ask_user') return null;
  for (const decision of state.decisions) {
    const against = [decision.question, decision.text].filter(Boolean).join(' ');
    if (overlap(event.question, against) >= 0.4) return decision;
  }
  return null;
}

function redo(state, event) {
  if (!event) return null;
  if (event.kind === 'propose_plan' && state.steps.length) {
    return `re-planned ${state.steps.length} steps that already exist`;
  }
  if (['attach_artifact', 'complete_step', 'skip_step'].includes(event.kind)) {
    const step = Machine.byId(state.steps, event.step);
    if (step && (step.status === 'done' || step.status === 'skipped')) {
      return `acted on ${step.id}, which is already ${step.status}`;
    }
  }
  return null;
}

function grade(state, parsed) {
  if (!parsed.ok) {
    return { legal: false, why: `${parsed.reason} — ${parsed.detail}`, redo: null, reAsk: null, kind: null };
  }
  const verdict = Machine.legal(state, parsed.event);
  const repeated = redo(state, parsed.event);
  const asked = reAsk(state, parsed.event);
  return {
    kind: parsed.event.kind,
    legal: verdict.ok,
    why: verdict.ok ? '' : `${verdict.reason} — ${verdict.detail}`,
    redo: repeated,
    reAsk: asked ? asked.text : null,
  };
}


/* ------------------------------------------------------------- the anatomy */

/* What each arm is actually paying for, counted with no network at all.
 *
 * "Work" is the substance: the artifacts, the step titles, the criteria, and
 * what the person settled. Both arms carry every token of it and neither can
 * drop any. What is left over is what each one pays on top — the transcript
 * pays for talk (everything said around the work, every envelope, and every
 * attempt the guard refused), and the state pays for scaffold (the headers,
 * the statuses, the standing and the slot).
 *
 * This is the number that says when the two diverge, and it needs no key.
 */
function anatomy(fixture) {
  const state = Machine.reduce(fixture.log);
  const work = [
    ...state.steps.map((step) => `${step.title}\n${step.artifact || ''}${step.note || ''}`),
    ...state.acceptance.map((criterion) => criterion.text),
    ...state.decisions.map((decision) => decision.text),
    state.goal,
  ].reduce((total, text) => total + Protocol.estimate(text), 0);

  const stateTokens = Protocol.compile(state).stateTokens;
  const transcriptTokens = Protocol.estimate(
    transcriptMessages(fixture).filter((m) => m.role !== 'system').map((m) => m.content).join('\n'));

  return {
    fixture: fixture.id,
    work,
    state: { total: stateTokens, scaffold: stateTokens - work },
    transcript: { total: transcriptTokens, talk: transcriptTokens - work },
    ratio: transcriptTokens ? stateTokens / transcriptTokens : null,
  };
}


/* The state is a function of the machine, so anything that happens without
 * moving the machine costs it nothing at all. A transcript has no such
 * property: every refused attempt stays in it forever.
 *
 * So this walks a fixture forward through rounds of a model getting it wrong —
 * the commonest thing that happens in a real run, and the thing the guard
 * exists to catch — and prices both arms at each round. The state line is
 * flat by construction. What the curve gives is the number of refusals at
 * which the two cross, which is the honest form of the compression claim.
 */
function noiseCurve(fixture, rounds = 8) {
  const curve = [];
  const log = [...fixture.log];
  for (let round = 0; round <= rounds; round += 1) {
    const measured = anatomy({ ...fixture, log: [...log] });
    curve.push({ round, state: measured.state.total, transcript: measured.transcript.total });
    log.push({
      at: 900 + round,
      kind: 'complete_step',
      step: 's1',
      say: 'That step looks finished to me, so I am closing it and moving on to the next one.',
      rejected: 'wrong-step',
      detail: 'step s1 is not active — s2 is',
    });
  }
  return curve;
}

/* ------------------------------------------------------------- the runner */

async function ask({ send, arm, fixture, state, model, temperature, signal }) {
  const cell = {
    fixture: fixture.id, arm: arm.id, tokens: 0, retries: 0,
    say: '', kind: null, legal: false, why: '', redo: null, reAsk: null, error: null,
  };
  let rejection = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = messagesFor(arm.id, fixture, state, rejection);
    let reply;
    try {
      reply = await send({ model, messages, temperature, maxTokens: 2200, stream: false, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      cell.error = error.message;
      return cell;
    }
    if (attempt === 0) {
      cell.tokens = (reply.usage && reply.usage.promptTokens)
        || Protocol.estimate(messages.map((m) => m.content).join('\n'));
    }
    const parsed = Protocol.parse(reply.text);
    const graded = grade(state, parsed);
    Object.assign(cell, graded, { say: parsed.say || reply.text.slice(0, 200) });
    if (graded.legal) return cell;
    cell.retries = attempt + 1;
    rejection = { kind: graded.kind, reason: parsed.ok ? Machine.legal(state, parsed.event).reason : parsed.reason,
      detail: graded.why };
  }
  return cell;
}

function summarise(cells) {
  const rows = FIXTURES.map((fixture) => {
    const byArm = {};
    for (const cell of cells.filter((c) => c.fixture === fixture.id)) byArm[cell.arm] = cell;
    const ratio = byArm.transcript && byArm.state && byArm.transcript.tokens
      ? byArm.state.tokens / byArm.transcript.tokens
      : null;
    const stable = byArm.state && byArm.again ? byArm.state.kind === byArm.again.kind : null;
    return { fixture: fixture.id, label: fixture.label, byArm, ratio, stable };
  });

  const ratios = rows.map((row) => row.ratio).filter((r) => r != null).sort((a, b) => a - b);
  const clean = (cell) => cell && cell.legal && !cell.redo && !cell.reAsk;
  return {
    rows,
    median: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null,
    stateClean: cells.filter((c) => c.arm === 'state' && clean(c)).length,
    transcriptClean: cells.filter((c) => c.arm === 'transcript' && clean(c)).length,
    goalClean: cells.filter((c) => c.arm === 'goal' && clean(c)).length,
    unstable: rows.filter((row) => row.stable === false).map((row) => row.fixture),
  };
}

async function run({ send, model, temperature = 0, onCell, signal } = {}) {
  const cells = [];
  for (const fixture of FIXTURES) {
    const state = Machine.reduce(fixture.log);
    for (const arm of ARMS) {
      const cell = await ask({ send, arm, fixture, state, model, temperature, signal });
      cells.push(cell);
      if (onCell) onCell(cell, cells.length, FIXTURES.length * ARMS.length);
    }
  }
  return { cells, summary: summarise(cells) };
}

const Resume = {
  GOAL,
  FIXTURES,
  ARMS,
  stateOf: (fixture) => Machine.reduce(fixture.log),
  transcriptMessages,
  goalMessages,
  messagesFor,
  grade,
  redo,
  reAsk,
  overlap,
  summarise,
  anatomy,
  noiseCurve,
  ask,
  run,
  requests: FIXTURES.length * ARMS.length,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Resume;
