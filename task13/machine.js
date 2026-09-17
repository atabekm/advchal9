// The machine. Stages, events, guards, the reducer, the invariants.
//
// Nothing here knows about the network, the DOM, or a model. The state is a
// fold over a log of events, and the only way state changes is an event that
// a guard has accepted. An event the guard rejects is still recorded — that is
// what the rejection panel reads — but it does not move the machine.

const STAGES = ['planning', 'execution', 'validation', 'done'];
const STEP_STATUS = ['pending', 'active', 'done', 'skipped'];
const VERDICTS = ['unknown', 'met', 'unmet'];

// A closed set. Every rejection the machine can issue is one of these, so the
// README has rows to print and the tests have exact strings to assert.
const REJECTIONS = {
  'wrong-stage': 'the event does not belong to the stage the machine is in',
  'wrong-actor': 'it is the other party’s turn to move',
  'wrong-kind': 'not the event the open slot is waiting for',
  'paused': 'the machine is paused, and only resume is legal',
  'terminal': 'the machine is closed',
  'malformed': 'the event is missing something it cannot do without',
  'unknown-step': 'no step carries that id',
  'wrong-step': 'that step is not the one that is active',
  'missing-artifact': 'the step has nothing attached to complete',
  'missing-acceptance': 'a plan must say what would count as done',
  'unknown-criterion': 'no acceptance criterion carries that id',
  'incomplete-verdicts': 'every acceptance criterion needs a verdict',
};

// actor  — who may emit it
// stages — where it is legal; null is the stage before anything was asked
// bypass — legal without matching the open slot (pause, resume, ask_user)
const EVENTS = {
  start: { actor: 'user', stages: [null] },
  propose_plan: { actor: 'model', stages: ['planning'] },
  approve_plan: { actor: 'user', stages: ['planning'] },
  revise_plan: { actor: 'user', stages: ['planning'] },
  attach_artifact: { actor: 'model', stages: ['execution'] },
  complete_step: { actor: 'model', stages: ['execution'] },
  skip_step: { actor: 'model', stages: ['execution'] },
  ask_user: { actor: 'model', stages: ['planning', 'execution', 'validation'], bypass: true },
  answer: { actor: 'user', stages: ['planning', 'execution', 'validation'] },
  validate: { actor: 'model', stages: ['validation'] },
  accept: { actor: 'user', stages: ['validation'] },
  abandon: { actor: 'user', stages: ['validation'] },
  pause: { actor: 'user', stages: ['planning', 'execution', 'validation'], bypass: true },
  resume: { actor: 'user', stages: ['planning', 'execution', 'validation'], bypass: true },
};

const EVENT_KINDS = Object.keys(EVENTS);

// ---------------------------------------------------------------- small stuff

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function byId(list, id) {
  return (list || []).find((item) => item && item.id === id) || null;
}

function ok() {
  return { ok: true, reason: null, detail: '' };
}

function no(reason, detail) {
  return { ok: false, reason, detail };
}

// ------------------------------------------------------------------ the state

function empty() {
  return {
    goal: null,
    stage: null,
    steps: [],
    cursor: null,
    acceptance: [],
    decisions: [],
    expect: { actor: 'user', kinds: ['start'], why: 'nothing has been asked yet' },
    paused: false,
    outcome: null,
  };
}

function activeStep(state) {
  return (state.steps || []).find((step) => step.status === 'active') || null;
}

function unmetCriteria(state) {
  return (state.acceptance || []).filter((a) => a.verdict !== 'met').map((a) => a.id);
}

// What the machine would accept right now: the open slot, plus whatever is
// legal without one. The prompt prints this, which is the difference between a
// rule the model is told about and a rule it is inside of.
const SLOT_REASONS = ['wrong-kind', 'wrong-actor', 'wrong-stage', 'paused', 'terminal'];

function legalKinds(state) {
  return EVENT_KINDS.filter((kind) => {
    const verdict = legal(state, probe(kind, state));
    return verdict.ok || !SLOT_REASONS.includes(verdict.reason);
  });
}

// A payload-shaped stand-in, so legalKinds asks about the slot and not about
// whether some hypothetical payload was well formed.
function probe(kind, state) {
  const active = activeStep(state);
  return {
    kind,
    goal: 'probe',
    note: 'probe',
    question: 'probe',
    text: 'probe',
    reason: 'probe',
    artifact: 'probe',
    step: active ? active.id : 'probe',
    steps: [{ title: 'probe' }],
    acceptance: [{ text: 'probe' }],
    verdicts: (state.acceptance || []).map((a) => ({ id: a.id, verdict: 'met', evidence: 'probe' })),
  };
}

// ------------------------------------------------------------------ the guard

function targetsActiveStep(state, event) {
  if (!nonEmpty(event.step)) return no('malformed', 'the event has to name a step');
  if (!byId(state.steps, event.step)) return no('unknown-step', `there is no step "${event.step}"`);
  const active = activeStep(state);
  if (!active || event.step !== active.id) {
    return no('wrong-step', active
      ? `step ${event.step} is not active — ${active.id} is`
      : 'no step is active');
  }
  return ok();
}

const PAYLOAD = {
  start: (state, event) => (nonEmpty(event.goal)
    ? ok() : no('malformed', 'a goal is required')),

  propose_plan: (state, event) => {
    const steps = event.steps;
    if (!Array.isArray(steps) || !steps.length || !steps.every((s) => nonEmpty(s && s.title))) {
      return no('malformed', 'a plan is at least one step, and every step needs a title');
    }
    const criteria = event.acceptance;
    if (!Array.isArray(criteria) || !criteria.length || !criteria.every((a) => nonEmpty(a && a.text))) {
      return no('missing-acceptance',
        'a plan has to say what would count as done, and it has to say it now — before any work exists to judge');
    }
    return ok();
  },

  revise_plan: (state, event) => (nonEmpty(event.note)
    ? ok() : no('malformed', 'a revision needs a note saying what to change')),

  attach_artifact: (state, event) => {
    const targeted = targetsActiveStep(state, event);
    if (!targeted.ok) return targeted;
    return nonEmpty(event.artifact) ? ok() : no('malformed', 'an artifact cannot be empty');
  },

  complete_step: (state, event) => {
    const targeted = targetsActiveStep(state, event);
    if (!targeted.ok) return targeted;
    const step = byId(state.steps, event.step);
    return step.artifact
      ? ok()
      : no('missing-artifact', `step ${step.id} has no artifact — attach one before completing it`);
  },

  skip_step: (state, event) => {
    const targeted = targetsActiveStep(state, event);
    if (!targeted.ok) return targeted;
    return nonEmpty(event.reason) ? ok() : no('malformed', 'skipping a step needs a reason');
  },

  ask_user: (state, event) => (nonEmpty(event.question)
    ? ok() : no('malformed', 'a question cannot be empty')),

  answer: (state, event) => (nonEmpty(event.text)
    ? ok() : no('malformed', 'an answer cannot be empty')),

  validate: (state, event) => {
    if (!Array.isArray(event.verdicts)) {
      return no('malformed', 'validate carries one verdict per acceptance criterion');
    }
    for (const verdict of event.verdicts) {
      if (!verdict || !byId(state.acceptance, verdict.id)) {
        return no('unknown-criterion', `there is no acceptance criterion "${verdict && verdict.id}"`);
      }
      if (verdict.verdict !== 'met' && verdict.verdict !== 'unmet') {
        return no('malformed', `a verdict is met or unmet, not "${verdict.verdict}"`);
      }
      if (!nonEmpty(verdict.evidence)) {
        return no('malformed', `criterion ${verdict.id} has a verdict and no evidence for it`);
      }
    }
    const seen = new Set(event.verdicts.map((v) => v.id));
    const missing = state.acceptance.filter((a) => !seen.has(a.id)).map((a) => a.id);
    if (missing.length) {
      return no('incomplete-verdicts', `nothing was said about ${missing.join(', ')}`);
    }
    return ok();
  },

  abandon: (state, event) => (nonEmpty(event.reason)
    ? ok() : no('malformed', 'abandoning the task needs a reason')),

  resume: (state) => (state.paused
    ? ok() : no('wrong-kind', 'the machine is not paused')),
};

function legal(state, event) {
  if (!event || typeof event !== 'object' || typeof event.kind !== 'string') {
    return no('malformed', 'an event has to carry a kind');
  }
  const spec = EVENTS[event.kind];
  if (!spec) return no('malformed', `there is no event of kind "${event.kind}"`);

  if (state.stage === 'done') {
    return no('terminal', 'the machine is closed and nothing moves it');
  }
  if (state.paused && event.kind !== 'resume') {
    return no('paused', 'the machine is paused — resume it first');
  }
  if (!spec.stages.includes(state.stage)) {
    const where = state.stage === null ? 'has not started' : `is in ${state.stage}`;
    return no('wrong-stage',
      `${event.kind} belongs to ${spec.stages.filter(Boolean).join(', ') || 'the start'}; the machine ${where}`);
  }

  // The model never speaks out of turn, not even to ask a question.
  if (spec.actor === 'model' && state.expect.actor !== 'model') {
    return no('wrong-actor', `${event.kind} is the model's to emit, and the machine is waiting on the user`);
  }
  if (!spec.bypass) {
    if (spec.actor !== state.expect.actor) {
      return no('wrong-actor', `the machine is waiting on the ${state.expect.actor}`);
    }
    if (!state.expect.kinds.includes(event.kind)) {
      return no('wrong-kind', `the open slot wants ${state.expect.kinds.join(' or ')}, not ${event.kind}`);
    }
  }

  const payload = PAYLOAD[event.kind];
  return payload ? payload(state, event) : ok();
}

// ---------------------------------------------------------------- the reducer

function expectPlan() {
  return {
    actor: 'model',
    kinds: ['propose_plan'],
    why: 'nothing has been planned yet, and a plan is steps together with what would count as done',
  };
}

// All three moves are genuinely open during execution; which of them passes is
// decided by the payload guard, not by the slot. That is deliberate — a model
// that tries to close an empty step should be told "s1 has no artifact", which
// says what to do next, rather than "wrong kind", which does not.
function expectStep(state) {
  const active = activeStep(state);
  return {
    actor: 'model',
    kinds: ['attach_artifact', 'complete_step', 'skip_step'],
    why: active && active.artifact
      ? `step ${active.id} has an artifact and is waiting to be closed`
      : `step ${active ? active.id : '?'} is active and has nothing attached to it yet`,
  };
}

function advance(state) {
  const from = state.cursor == null ? -1 : state.cursor;
  const next = state.steps.findIndex((step, i) => i > from && step.status === 'pending');
  if (next === -1) {
    state.cursor = null;
    state.stage = 'validation';
    state.expect = {
      actor: 'model',
      kinds: ['validate'],
      why: 'every step is closed, and the criteria fixed during planning decide the outcome',
    };
    return;
  }
  state.cursor = next;
  state.steps[next].status = 'active';
  state.expect = expectStep(state);
}

function apply(state, event) {
  const s = clone(state);
  const at = event.at || 0;

  switch (event.kind) {
    case 'start':
      s.goal = event.goal.trim();
      s.stage = 'planning';
      s.expect = expectPlan();
      break;

    case 'propose_plan':
      s.steps = event.steps.map((step, i) => ({
        id: `s${i + 1}`,
        title: step.title.trim(),
        status: 'pending',
        artifact: null,
        note: null,
      }));
      s.acceptance = event.acceptance.map((criterion, i) => ({
        id: `a${i + 1}`,
        text: criterion.text.trim(),
        verdict: 'unknown',
        evidence: null,
      }));
      s.cursor = null;
      s.expect = {
        actor: 'user',
        kinds: ['approve_plan', 'revise_plan'],
        why: 'the plan and its criteria need approval before any work starts',
      };
      break;

    case 'approve_plan':
      s.stage = 'execution';
      s.cursor = 0;
      s.steps[0].status = 'active';
      s.expect = expectStep(s);
      break;

    case 'revise_plan':
      // A revision is a thing the user has settled, so it is kept where
      // settled things are kept and never asked about again.
      s.decisions.push({ at, question: null, text: event.note.trim() });
      s.steps = [];
      s.acceptance = [];
      s.cursor = null;
      s.expect = expectPlan();
      break;

    case 'attach_artifact':
      byId(s.steps, event.step).artifact = event.artifact.trim();
      s.expect = expectStep(s);
      break;

    case 'complete_step':
      byId(s.steps, event.step).status = 'done';
      advance(s);
      break;

    case 'skip_step': {
      const step = byId(s.steps, event.step);
      step.status = 'skipped';
      step.note = event.reason.trim();
      advance(s);
      break;
    }

    case 'ask_user':
      s.expect = {
        actor: 'user',
        kinds: ['answer'],
        why: event.question.trim(),
        resume: clone(state.expect),
      };
      break;

    case 'answer':
      s.decisions.push({ at, question: s.expect.why, text: event.text.trim() });
      s.expect = s.expect.resume;
      break;

    case 'validate':
      for (const verdict of event.verdicts) {
        const criterion = byId(s.acceptance, verdict.id);
        criterion.verdict = verdict.verdict;
        criterion.evidence = verdict.evidence.trim();
      }
      s.expect = {
        actor: 'user',
        kinds: ['accept', 'abandon'],
        why: unmetCriteria(s).length
          ? `${unmetCriteria(s).length} of ${s.acceptance.length} criteria came back unmet`
          : 'every criterion came back met',
      };
      break;

    case 'accept':
      s.stage = 'done';
      s.cursor = null;
      s.outcome = { result: 'accepted', at, reason: null, unmet: unmetCriteria(s) };
      s.expect = null;
      break;

    case 'abandon':
      s.stage = 'done';
      s.cursor = null;
      s.outcome = { result: 'abandoned', at, reason: event.reason.trim(), unmet: unmetCriteria(s) };
      s.expect = null;
      break;

    case 'pause':
      s.paused = true;
      break;

    case 'resume':
      s.paused = false;
      break;

    default:
      break;
  }

  return s;
}

// -------------------------------------------------------------- the invariants

function invariants(state) {
  const broken = [];
  const say = (claim, condition) => { if (!condition) broken.push(claim); };

  say('stage is null or one of the four', state.stage === null || STAGES.includes(state.stage));
  say('every step status is one of the four',
    state.steps.every((step) => STEP_STATUS.includes(step.status)));
  say('every verdict is one of the three',
    state.acceptance.every((a) => VERDICTS.includes(a.verdict)));
  say('step ids are unique', new Set(state.steps.map((s) => s.id)).size === state.steps.length);
  say('criterion ids are unique',
    new Set(state.acceptance.map((a) => a.id)).size === state.acceptance.length);

  const active = state.steps.filter((step) => step.status === 'active');
  say('at most one step is active', active.length <= 1);
  say('the cursor agrees with the active step',
    state.cursor == null ? active.length === 0 : state.steps[state.cursor] === undefined
      ? false : state.steps[state.cursor].status === 'active');

  if (state.stage === 'execution') {
    say('execution has exactly one active step', active.length === 1);
  }
  if (state.stage === 'validation' || state.stage === 'done') {
    say('nothing is left open past execution',
      state.steps.every((step) => step.status === 'done' || step.status === 'skipped'));
  }
  if (state.stage && state.stage !== 'planning') {
    say('past planning there is a plan', state.steps.length > 0);
    say('past planning there are criteria', state.acceptance.length > 0);
  }

  say('expect is null exactly when the machine is closed',
    (state.expect === null) === (state.stage === 'done'));
  if (state.expect) {
    say('expect names an actor', state.expect.actor === 'user' || state.expect.actor === 'model');
    say('expect names at least one kind',
      Array.isArray(state.expect.kinds) && state.expect.kinds.length > 0);
    say('every expected kind is a real event',
      (state.expect.kinds || []).every((kind) => EVENTS[kind]));
  }

  say('an outcome exists exactly when the machine is closed',
    (state.outcome === null) === (state.stage !== 'done'));
  say('a closed machine is not paused', !(state.paused && state.stage === 'done'));

  return broken;
}

// ------------------------------------------------------------------- the fold

// One turn. The app calls nothing else to move the machine.
function step(state, event) {
  const verdict = legal(state, event);
  if (!verdict.ok) {
    return {
      ok: false,
      state,
      rejection: { kind: event && event.kind, reason: verdict.reason, detail: verdict.detail },
      broken: [],
    };
  }
  const next = apply(state, event);
  return { ok: true, state: next, rejection: null, broken: invariants(next) };
}

// Rejected entries stay in the log — they are the record of what the model
// tried — and the fold walks past them.
function replay(log) {
  let state = empty();
  const skipped = [];
  for (const entry of log || []) {
    if (entry && entry.rejected) continue;
    const moved = step(state, entry);
    if (!moved.ok) {
      skipped.push({ at: entry && entry.at, ...moved.rejection });
      continue;
    }
    state = moved.state;
  }
  return { state, skipped };
}

function reduce(log) {
  return replay(log).state;
}

const Machine = {
  STAGES,
  STEP_STATUS,
  VERDICTS,
  REJECTIONS,
  REJECTION_REASONS: Object.keys(REJECTIONS),
  EVENTS,
  EVENT_KINDS,
  empty,
  legal,
  legalKinds,
  apply,
  step,
  reduce,
  replay,
  invariants,
  activeStep,
  unmetCriteria,
  byId,
  clone,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Machine;
