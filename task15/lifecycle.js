/* The lifecycle. States, the edge table, the guards, the actions, the reducer.
 *
 * Nothing here knows about the network, the DOM, or a model. The state is a
 * fold over a log of moves, and the only way it changes is a move that
 * `adjudicate` accepted.
 *
 * The one thing this file does that task 13's machine.js did not: the edges are
 * a value. `TRANSITIONS` is a list you can print, search, and walk. A refusal
 * can therefore say which edge was asked for, which guard is shut, whose move
 * it was, and what the shortest legal route would have been — none of which is
 * available to a machine whose transitions are `stage = 'execution'` written in
 * the middle of a reducer.
 */

const STATES = ['planning', 'execution', 'validation', 'done'];
const STEP_STATUS = ['pending', 'active', 'done', 'skipped'];
const VERDICTS = ['unknown', 'met', 'unmet'];
const ACTORS = ['user', 'model'];

// A closed set. Every refusal this file can issue is one of these, so the
// README has rows to print and the tests have exact strings to assert.
const REJECTIONS = {
  'no-such-state': 'that is not the name of a state',
  'no-edge': 'nothing connects where the machine is to where it was asked to go',
  'guard-unmet': 'the edge exists and it is shut',
  'wrong-actor': 'the move belongs to the other party',
  'wrong-state': 'the action does not belong to the state the machine is in',
  'question-open': 'the model asked something and is waiting to be answered',
  'paused': 'the machine is paused, and only resume is legal',
  'terminal': 'the machine is closed',
  'malformed': 'the move is missing something it cannot do without',
  'unknown-step': 'no step carries that id',
  'wrong-step': 'that step is not the one the move may touch',
  'missing-artifact': 'the step has nothing attached to complete',
  'unknown-criterion': 'no acceptance criterion carries that id',
  'incomplete-verdicts': 'every acceptance criterion needs a verdict and evidence',
};

const REJECTION_REASONS = Object.keys(REJECTIONS);

/* ------------------------------------------------------------------ the guards
 *
 * A guard is a predicate over the state, and three other things that matter as
 * much as the predicate: a label the refusal can print, an owner so the refusal
 * can say whose problem it is, and a remedy so the refusal is a direction
 * rather than a wall.
 *
 * Guards are about the state only. Whether a move carries the fields it needs
 * is a different question with a different answer — see PAYLOAD below, which
 * refuses with `malformed` rather than `guard-unmet`. Keeping them apart is
 * what lets `offers()` evaluate every guard honestly without inventing a move
 * to test them against.
 */
const GUARDS = {
  'plan-proposed': {
    label: 'a plan exists',
    owner: 'model',
    remedy: 'the assistant proposes steps',
    test: (s) => s.steps.length > 0,
  },
  'criteria-fixed': {
    label: 'the plan says what would count as done',
    owner: 'model',
    remedy: 'the assistant writes acceptance criteria, before there is any work to judge',
    test: (s) => s.acceptance.length > 0,
  },
  'every-step-closed': {
    label: 'no step is still open',
    owner: 'model',
    remedy: 'finish or skip the steps that are still open',
    test: (s) => s.steps.length > 0
      && s.steps.every((step) => step.status === 'done' || step.status === 'skipped'),
  },
  'validation-fresh': {
    label: 'the validation judged the work as it now stands',
    owner: 'model',
    remedy: 'validate again — the work changed after the last verdicts were recorded',
    test: (s) => s.validation != null && s.validation.at === s.revision,
  },
  'every-criterion-met': {
    label: 'every criterion came back met',
    owner: 'model',
    remedy: 'send the work back and fix what failed, or abandon the task',
    test: (s) => s.acceptance.length > 0 && s.acceptance.every((a) => a.verdict === 'met'),
  },
};

const GUARD_IDS = Object.keys(GUARDS);

/* -------------------------------------------------------------- the edge table
 *
 * Six edges. `from` is the state the machine must be in, `to` is where the edge
 * lands, `trigger` is what the move is called, `actor` is who may take it.
 *
 * Two of these do the work the brief asks for:
 *
 *   build   — the only road from planning into execution, and it is the
 *             person's to walk. "No implementation before an approved plan" is
 *             not a guard here; it is the shape of the graph. Approving IS the
 *             edge, so no amount of arguing discharges it, because it was never
 *             the model's move.
 *
 *   rework  — the back edge, which task 13 did not have. The moment it exists
 *             the arc stops being a line, `stageIndex + 1` stops being an
 *             enforcement, and this table stops being decoration.
 */
const TRANSITIONS = [
  {
    id: 'open',
    from: null,
    to: 'planning',
    trigger: 'start',
    actor: 'user',
    guards: [],
    note: 'a goal turns nothing into a task',
  },
  {
    id: 'build',
    from: 'planning',
    to: 'execution',
    trigger: 'approve_plan',
    actor: 'user',
    guards: ['plan-proposed', 'criteria-fixed'],
    note: 'approving the plan is the only way in, and only the person can do it',
  },
  {
    id: 'submit',
    from: 'execution',
    to: 'validation',
    trigger: 'submit',
    actor: 'model',
    guards: ['every-step-closed'],
    note: 'the work goes to be judged against the criteria fixed at planning',
  },
  {
    id: 'rework',
    from: 'validation',
    to: 'execution',
    trigger: 'rework',
    actor: 'user',
    guards: ['validation-fresh'],
    /* This edge asked for a second guard for a while — "something came back
     * unmet" — and it was wrong twice. It is not the runtime's business to tell
     * the person that work which technically passed is good enough. And with it
     * in place, `validation-fresh` could never be the sole reason for a
     * refusal: the only road back out of validation needed an unmet criterion,
     * so any state reached through it already failed `every-criterion-met`, and
     * freshness never had to decide anything. A guard that can never be the
     * reason is decoration. The test that noticed is the run through the page. */
    note: 'the person sends one step back to be done again, on current verdicts',
  },
  {
    id: 'finish',
    from: 'validation',
    to: 'done',
    trigger: 'accept',
    actor: 'user',
    guards: ['validation-fresh', 'every-criterion-met'],
    note: 'the last edge, and the one the stale verdict closes',
  },
  {
    id: 'abandon',
    from: 'validation',
    to: 'done',
    trigger: 'abandon',
    actor: 'user',
    guards: [],
    note: 'the one exit that needs no evidence, because giving up needs no proof',
  },
];

const TRIGGERS = TRANSITIONS.map((t) => t.trigger);

/* ---------------------------------------------------------------- the actions
 *
 * An action changes the work and never changes the state. `bumps` marks the
 * ones that move `revision`, which is the whole of what freshness means.
 *
 * `bypass` marks the two that are legal whoever's turn it is: the person may
 * always stop, and may always start again.
 */
const ACTIONS = {
  propose_plan: { states: ['planning'], actor: 'model', bumps: false },
  revise_plan: { states: ['planning'], actor: 'user', bumps: false },
  attach_artifact: { states: ['execution'], actor: 'model', bumps: true },
  complete_step: { states: ['execution'], actor: 'model', bumps: true },
  skip_step: { states: ['execution'], actor: 'model', bumps: true },
  validate: { states: ['validation'], actor: 'model', bumps: false },
  ask_user: { states: ['planning', 'execution', 'validation'], actor: 'model', bumps: false },
  /* The person saying something is not a move in the task, and it changes no
   * work — but it has to be sayable, or the thing this task exists to watch
   * (somebody leaning on the assistant to skip ahead) can only ever happen in
   * a scripted experiment and never on the page. `anytime` means it does not
   * wait for a turn; a remark is what interrupting looks like. */
  remark: { states: ['planning', 'execution', 'validation'], actor: 'user', bumps: false, anytime: true },
  answer: { states: ['planning', 'execution', 'validation'], actor: 'user', bumps: false },
  pause: { states: ['planning', 'execution', 'validation'], actor: 'user', bumps: false, bypass: true },
  resume: { states: ['planning', 'execution', 'validation'], actor: 'user', bumps: false, bypass: true },
};

const ACTION_KINDS = Object.keys(ACTIONS);

/* ---------------------------------------------------------------- small stuff */

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

function no(reason, detail, extra) {
  return { ok: false, reason, detail, ...(extra || {}) };
}

/* ------------------------------------------------------------------ the state */

function empty() {
  return {
    goal: null,
    state: null,
    steps: [],
    cursor: null,
    acceptance: [],
    decisions: [],
    question: null,
    remark: null,
    revision: 0,
    validation: null,
    rounds: 0,
    paused: false,
    outcome: null,
  };
}

function activeStep(state) {
  return (state.steps || []).find((step) => step.status === 'active') || null;
}

function openSteps(state) {
  return (state.steps || []).filter((step) => step.status === 'pending' || step.status === 'active');
}

function unmetCriteria(state) {
  return (state.acceptance || []).filter((a) => a.verdict === 'unmet').map((a) => a.id);
}

function fresh(state) {
  return GUARDS['validation-fresh'].test(state);
}

/* Whose move it is. Derived, never stored — like everything else `offers` is
 * built from. A machine that remembers whose turn it was has a second source of
 * truth, and a pause is exactly the moment the two drift apart. */
function turn(state) {
  if (state.state === 'done') return null;
  if (state.paused) return 'user';
  if (state.question) return 'user';
  // The person said something and is owed one move for it.
  if (state.remark && !state.remark.heard) return 'model';
  if (state.state === null) return 'user';
  if (state.state === 'planning') return state.steps.length ? 'user' : 'model';
  if (state.state === 'execution') return 'model';
  if (state.state === 'validation') return fresh(state) ? 'user' : 'model';
  return null;
}

/* ----------------------------------------------------------- payload guards */

function targetsActiveStep(state, move) {
  if (!nonEmpty(move.step)) return no('malformed', 'the move has to name a step');
  if (!byId(state.steps, move.step)) return no('unknown-step', `there is no step "${move.step}"`);
  const active = activeStep(state);
  if (!active || move.step !== active.id) {
    return no('wrong-step', active
      ? `step ${move.step} is not active — ${active.id} is`
      : 'no step is active');
  }
  return ok();
}

const PAYLOAD = {
  start: (state, move) => (nonEmpty(move.goal)
    ? ok() : no('malformed', 'a goal is required')),

  abandon: (state, move) => (nonEmpty(move.reason)
    ? ok() : no('malformed', 'abandoning the task needs a reason')),

  // Rework names the one step to reopen. It has to be a step that was closed,
  // because reopening an open step is not rework, it is a no-op dressed up as
  // progress — and the round trip it would buy is exactly the move this task
  // exists to refuse.
  rework: (state, move) => {
    if (!nonEmpty(move.step)) return no('malformed', 'rework has to name the step to reopen');
    const step = byId(state.steps, move.step);
    if (!step) return no('unknown-step', `there is no step "${move.step}"`);
    if (step.status !== 'done' && step.status !== 'skipped') {
      return no('wrong-step', `step ${step.id} is ${step.status}, so there is nothing to reopen`);
    }
    return nonEmpty(move.reason)
      ? ok() : no('malformed', 'sending a step back needs a reason');
  },

  approve_plan: () => ok(),
  accept: () => ok(),

  propose_plan: (state, move) => {
    const steps = move.steps;
    if (!Array.isArray(steps) || !steps.length || !steps.every((s) => nonEmpty(s && s.title))) {
      return no('malformed', 'a plan is at least one step, and every step needs a title');
    }
    const criteria = move.acceptance;
    if (!Array.isArray(criteria) || !criteria.length || !criteria.every((a) => nonEmpty(a && a.text))) {
      return no('malformed',
        'a plan has to say what would count as done, and it has to say it now — before any work exists to judge');
    }
    return ok();
  },

  revise_plan: (state, move) => (nonEmpty(move.note)
    ? ok() : no('malformed', 'a revision needs a note saying what to change')),

  attach_artifact: (state, move) => {
    const targeted = targetsActiveStep(state, move);
    if (!targeted.ok) return targeted;
    return nonEmpty(move.artifact) ? ok() : no('malformed', 'an artifact cannot be empty');
  },

  complete_step: (state, move) => {
    const targeted = targetsActiveStep(state, move);
    if (!targeted.ok) return targeted;
    const step = byId(state.steps, move.step);
    return step.artifact
      ? ok()
      : no('missing-artifact', `step ${step.id} has no artifact — attach one before completing it`);
  },

  skip_step: (state, move) => {
    const targeted = targetsActiveStep(state, move);
    if (!targeted.ok) return targeted;
    return nonEmpty(move.reason) ? ok() : no('malformed', 'skipping a step needs a reason');
  },

  ask_user: (state, move) => (nonEmpty(move.question)
    ? ok() : no('malformed', 'a question cannot be empty')),

  remark: (state, move) => (nonEmpty(move.text)
    ? ok() : no('malformed', 'a remark cannot be empty')),

  answer: (state, move) => {
    if (!state.question) return no('malformed', 'nothing was asked');
    return nonEmpty(move.text) ? ok() : no('malformed', 'an answer cannot be empty');
  },

  validate: (state, move) => {
    if (!Array.isArray(move.verdicts)) {
      return no('malformed', 'validate carries one verdict per acceptance criterion');
    }
    for (const verdict of move.verdicts) {
      if (!verdict || !byId(state.acceptance, verdict.id)) {
        return no('unknown-criterion', `there is no acceptance criterion "${verdict && verdict.id}"`);
      }
      if (verdict.verdict !== 'met' && verdict.verdict !== 'unmet') {
        return no('malformed', `a verdict is met or unmet, not "${verdict && verdict.verdict}"`);
      }
      if (!nonEmpty(verdict.evidence)) {
        return no('malformed', `criterion ${verdict.id} has a verdict and no evidence for it`);
      }
    }
    const seen = new Set(move.verdicts.map((v) => v.id));
    const missing = state.acceptance.filter((a) => !seen.has(a.id)).map((a) => a.id);
    if (missing.length) {
      return no('incomplete-verdicts', `nothing was said about ${missing.join(', ')}`);
    }
    return ok();
  },

  pause: (state) => (state.paused ? no('malformed', 'the machine is already paused') : ok()),
  resume: (state) => (state.paused ? ok() : no('malformed', 'the machine is not paused')),
};

/* ------------------------------------------------------------------- the edges */

function edgesFrom(from) {
  return TRANSITIONS.filter((t) => t.from === from);
}

function edgeByTrigger(trigger) {
  return TRANSITIONS.find((t) => t.trigger === trigger) || null;
}

// Which guards on an edge are shut right now, as records rather than ids, so a
// refusal can print the label, the owner and the remedy without looking
// anything up.
function failingGuards(state, edge) {
  return edge.guards
    .filter((id) => !GUARDS[id].test(state))
    .map((id) => ({ id, ...GUARDS[id], test: undefined }));
}

function guardReport(state, edge) {
  return edge.guards.map((id) => ({
    id,
    label: GUARDS[id].label,
    owner: GUARDS[id].owner,
    remedy: GUARDS[id].remedy,
    holds: GUARDS[id].test(state),
  }));
}

/* ----------------------------------------------------------------- the route
 *
 * Breadth-first over the edge table, so a refusal can hand back the road
 * instead of only the wall.
 *
 * The honest limit, stated where it is implemented rather than where it is
 * convenient: only the FIRST edge of a route is adjudicated. The guards on
 * later edges come back with `holds: null`, because evaluating a predicate
 * against a state that does not exist yet is fiction. The route says what the
 * road is. It does not promise the road will be open when you get there.
 */
function route(state, target) {
  if (!STATES.includes(target)) {
    return { ok: false, reason: 'no-such-state', path: [] };
  }
  const from = state.state;
  if (from === target) return { ok: true, path: [] };

  const seen = new Set([String(from)]);
  const queue = [[from, []]];
  while (queue.length) {
    const [where, path] = queue.shift();
    for (const edge of edgesFrom(where)) {
      if (seen.has(edge.to)) continue;
      const next = [...path, edge];
      if (edge.to === target) {
        return {
          ok: true,
          path: next.map((step, i) => ({
            edge: step,
            actor: step.actor,
            guards: i === 0
              ? guardReport(state, step)
              : step.guards.map((id) => ({
                id,
                label: GUARDS[id].label,
                owner: GUARDS[id].owner,
                remedy: GUARDS[id].remedy,
                holds: null,
              })),
          })),
        };
      }
      seen.add(edge.to);
      queue.push([edge.to, next]);
    }
  }
  return { ok: false, reason: 'no-edge', path: [] };
}

/* ----------------------------------------------------------------- the offers
 *
 * Everything legal right now. A pure function of the state: there is no
 * `offers` field, nothing persists one, and there is no code path anywhere in
 * this repo called `restore`. That is the whole of what "correct resumption"
 * means here — not that the machine puts back what it remembered, but that it
 * never remembered anything and works it out again.
 */
function offers(state) {
  const whose = turn(state);
  const base = {
    turn: whose,
    paused: !!state.paused,
    question: state.question ? state.question.text : null,
    transitions: [],
    actions: [],
  };

  if (state.state === 'done') return base;

  if (state.paused) {
    base.actions = [{ kind: 'resume', actor: 'user' }];
    return base;
  }

  base.transitions = edgesFrom(state.state).map((edge) => {
    const guards = guardReport(state, edge);
    return {
      id: edge.id,
      trigger: edge.trigger,
      from: edge.from,
      to: edge.to,
      actor: edge.actor,
      note: edge.note,
      guards,
      open: guards.every((g) => g.holds),
    };
  });

  if (state.question) {
    base.actions = [
      { kind: 'answer', actor: 'user' },
      { kind: 'pause', actor: 'user' },
    ];
    // Nothing moves along an edge while a question is open.
    base.transitions = base.transitions.map((t) => ({ ...t, open: false, blocked: 'question-open' }));
    return base;
  }

  base.actions = ACTION_KINDS
    .filter((kind) => ACTIONS[kind].states.includes(state.state))
    .filter((kind) => kind !== 'answer' && kind !== 'resume')
    .filter((kind) => (kind === 'remark' ? !state.paused : true))
    .filter((kind) => (kind === 'revise_plan' ? state.steps.length > 0 : true))
    .filter((kind) => (kind === 'propose_plan' ? state.steps.length === 0 : true))
    .map((kind) => ({ kind, actor: ACTIONS[kind].actor }));

  return base;
}

/* ------------------------------------------------------------- adjudication */

function normalise(move) {
  if (!move || typeof move !== 'object') {
    return no('malformed', 'a move has to be an object');
  }
  if (!ACTORS.includes(move.actor)) {
    return no('malformed', 'a move has to say who is making it');
  }
  if (move.type === 'transition') return ok();
  if (move.type === 'action') {
    return typeof move.kind === 'string' && ACTIONS[move.kind]
      ? ok()
      : no('malformed', `there is no action called "${move.kind}"`);
  }
  return no('malformed', 'a move is a transition or an action');
}

// Resolve what the mover asked for into one edge. Naming the trigger is exact;
// naming the destination is the interesting case, because that is what a skip
// looks like when it is written down.
function resolve(state, move) {
  if (nonEmpty(move.trigger)) {
    const edge = edgeByTrigger(move.trigger);
    if (!edge) return no('malformed', `there is no transition called "${move.trigger}"`);
    return { ok: true, edge };
  }
  if (!nonEmpty(move.to)) {
    return no('malformed', 'a transition names a trigger or a destination state');
  }
  if (!STATES.includes(move.to)) {
    return no('no-such-state', `"${move.to}" is not a state; the states are ${STATES.join(', ')}`);
  }
  const candidates = edgesFrom(state.state).filter((edge) => edge.to === move.to);
  if (candidates.length === 0) {
    return no('no-edge',
      `nothing goes from ${state.state === null ? 'the start' : state.state} to ${move.to}`,
      { target: move.to });
  }
  if (candidates.length > 1) {
    return no('malformed',
      `${candidates.length} edges go from ${state.state} to ${move.to} — name one of ${candidates.map((e) => e.trigger).join(', ')}`);
  }
  return { ok: true, edge: candidates[0] };
}

function adjudicateTransition(state, move) {
  const resolved = resolve(state, move);
  if (!resolved.ok) return resolved;
  const edge = resolved.edge;

  if (edge.from !== state.state) {
    // The trigger was named, and it belongs somewhere else. Refuse with the
    // road rather than the wall.
    return no('no-edge',
      `${edge.trigger} goes ${edge.from === null ? 'from the start' : `from ${edge.from}`}, and the machine is ${state.state === null ? 'not started' : `in ${state.state}`}`,
      { target: edge.to });
  }
  if (move.actor !== edge.actor) {
    return no('wrong-actor', `${edge.trigger} is the ${edge.actor}'s move, not the ${move.actor}'s`);
  }
  if (state.question) {
    return no('question-open', `"${state.question.text}" is still waiting for an answer`);
  }
  /* No turn check here, and that is deliberate. Whose turn it is, is derived
   * from the guards; checking it as well would answer "the machine is waiting
   * on the model" where "a plan exists — the assistant writes the steps" was
   * available, and the second answer is the first one with a remedy attached.
   * Ownership is the only thing a turn check would add, and the line above
   * already asked it. */
  const shut = failingGuards(state, edge);
  if (shut.length) {
    return no('guard-unmet',
      `${edge.trigger} is shut: ${shut.map((g) => g.label).join('; ')}`,
      { guards: shut, target: edge.to });
  }
  const payload = PAYLOAD[edge.trigger];
  const verdict = payload ? payload(state, move) : ok();
  return verdict.ok ? { ok: true, edge, reason: null, detail: '' } : verdict;
}

function adjudicateAction(state, move) {
  const spec = ACTIONS[move.kind];
  if (!spec.states.includes(state.state)) {
    return no('wrong-state',
      `${move.kind} belongs to ${spec.states.join(', ')}; the machine is ${state.state === null ? 'not started' : `in ${state.state}`}`);
  }
  if (move.actor !== spec.actor) {
    return no('wrong-actor', `${move.kind} is the ${spec.actor}'s move, not the ${move.actor}'s`);
  }
  if (!spec.bypass) {
    if (state.question && move.kind !== 'answer') {
      return no('question-open', `"${state.question.text}" is still waiting for an answer`);
    }
    const whose = turn(state);
    if (!spec.anytime && whose && move.actor !== whose) {
      return no('wrong-actor', `the machine is waiting on the ${whose}`);
    }
  }
  const payload = PAYLOAD[move.kind];
  const verdict = payload ? payload(state, move) : ok();
  return verdict.ok ? { ok: true, edge: null, reason: null, detail: '' } : verdict;
}

function adjudicate(state, move) {
  const shape = normalise(move);
  if (!shape.ok) return shape;

  if (state.state === 'done') {
    return no('terminal', 'the machine is closed and nothing moves it');
  }
  if (state.paused) {
    const resuming = move.type === 'action' && move.kind === 'resume';
    if (!resuming) return no('paused', 'the machine is paused — resume it first');
  }

  return move.type === 'transition'
    ? adjudicateTransition(state, move)
    : adjudicateAction(state, move);
}

/* ---------------------------------------------------------------- the reducer */

function advance(s) {
  const next = s.steps.findIndex((step) => step.status === 'pending');
  if (next === -1) {
    s.cursor = null;
    return;
  }
  s.cursor = next;
  s.steps[next].status = 'active';
}

function apply(state, move, edge) {
  const s = clone(state);
  const at = move.at || 0;

  if (move.type === 'transition') {
    switch (edge.id) {
      case 'open':
        s.goal = move.goal.trim();
        s.state = 'planning';
        break;

      case 'build':
        s.state = 'execution';
        advance(s);
        break;

      case 'submit':
        s.state = 'validation';
        s.cursor = null;
        break;

      case 'rework': {
        const step = byId(s.steps, move.step);
        step.status = 'pending';
        step.artifact = null;
        step.note = move.reason.trim();
        s.state = 'execution';
        s.rounds += 1;
        // Reopening a step is a change to the work, so it moves `revision` and
        // the validation that judged the old work goes stale in the same
        // breath. That is the whole mechanism, and it is one line.
        s.revision += 1;
        advance(s);
        break;
      }

      case 'finish':
        s.state = 'done';
        s.cursor = null;
        s.outcome = { result: 'accepted', at, reason: null, unmet: unmetCriteria(s) };
        break;

      case 'abandon':
        s.state = 'done';
        s.cursor = null;
        s.outcome = { result: 'abandoned', at, reason: move.reason.trim(), unmet: unmetCriteria(s) };
        break;

      default:
        break;
    }
    return s;
  }

  switch (move.kind) {
    case 'propose_plan':
      s.steps = move.steps.map((step, i) => ({
        id: `s${i + 1}`,
        title: step.title.trim(),
        status: 'pending',
        artifact: null,
        note: null,
      }));
      s.acceptance = move.acceptance.map((criterion, i) => ({
        id: `a${i + 1}`,
        text: criterion.text.trim(),
        verdict: 'unknown',
        evidence: null,
      }));
      s.cursor = null;
      break;

    case 'revise_plan':
      // A revision is a thing the person has settled, so it is kept where
      // settled things are kept and never asked about again.
      s.decisions.push({ at, question: null, text: move.note.trim() });
      s.steps = [];
      s.acceptance = [];
      s.cursor = null;
      break;

    case 'attach_artifact':
      byId(s.steps, move.step).artifact = move.artifact.trim();
      s.revision += 1;
      break;

    case 'complete_step':
      byId(s.steps, move.step).status = 'done';
      s.revision += 1;
      advance(s);
      break;

    case 'skip_step': {
      const step = byId(s.steps, move.step);
      step.status = 'skipped';
      step.note = move.reason.trim();
      s.revision += 1;
      advance(s);
      break;
    }

    case 'ask_user':
      s.question = { at, text: move.question.trim() };
      break;

    case 'remark':
      // Only the most recent survives. The scrollback is not the state, and
      // carrying every past sentence forward is the thing task 13 refused to
      // do and this task has no reason to start doing.
      s.remark = { at, text: move.text.trim(), heard: false };
      break;

    case 'answer':
      s.decisions.push({ at, question: s.question.text, text: move.text.trim() });
      s.question = null;
      break;

    case 'validate':
      for (const verdict of move.verdicts) {
        const criterion = byId(s.acceptance, verdict.id);
        criterion.verdict = verdict.verdict;
        criterion.evidence = verdict.evidence.trim();
      }
      // The stamp is the revision it judged, not the time it ran. Freshness is
      // then integer equality — exact, and impossible to fudge with an argument
      // about clock granularity.
      s.validation = { at: s.revision, round: s.rounds, verdicts: move.verdicts.length };
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

/* Any accepted move by the model discharges the debt a remark created. */
function heard(state, move) {
  if (move.actor !== 'model') return state;
  if (!state.remark || state.remark.heard) return state;
  return { ...state, remark: { ...state.remark, heard: true } };
}

/* -------------------------------------------------------------- the invariants */

function invariants(state) {
  const broken = [];
  const say = (claim, condition) => { if (!condition) broken.push(claim); };

  say('the state is null or one of the four', state.state === null || STATES.includes(state.state));
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
    state.cursor == null
      ? active.length === 0
      : !!state.steps[state.cursor] && state.steps[state.cursor].status === 'active');

  // Task 13 auto-advanced into validation the moment the last step closed, so
  // execution always had exactly one active step. Here finishing the steps does
  // not move anything — `submit` is an edge somebody has to take — so execution
  // has a second legitimate shape: everything closed, and waiting.
  if (state.state === 'execution') {
    say('execution has an active step, or nothing left open',
      active.length === 1 || openSteps(state).length === 0);
  }
  if (state.state === 'validation' || state.state === 'done') {
    say('nothing is left open past execution', openSteps(state).length === 0);
  }
  if (state.state && state.state !== 'planning') {
    say('past planning there is a plan', state.steps.length > 0);
    say('past planning there are criteria', state.acceptance.length > 0);
  }

  say('the revision never goes backwards', state.revision >= 0);
  say('a validation never judges a revision that has not happened',
    state.validation == null || state.validation.at <= state.revision);
  say('a validation exists only past execution',
    state.validation == null || state.state === 'validation' || state.state === 'execution' || state.state === 'done');
  say('the round count matches the reworks', state.rounds >= 0);

  say('an outcome exists exactly when the machine is closed',
    (state.outcome === null) === (state.state !== 'done'));
  say('a closed machine is not paused', !(state.paused && state.state === 'done'));
  say('a closed machine has nothing open', state.state !== 'done' || state.question === null);

  // The one this task exists for: nothing reaches `done` accepted without a
  // validation that judged the work as it finally stood.
  if (state.outcome && state.outcome.result === 'accepted') {
    say('an accepted task was validated at its final revision',
      state.validation != null && state.validation.at === state.revision);
    say('an accepted task has no unmet criterion',
      state.acceptance.every((a) => a.verdict === 'met'));
  }

  say('whose turn it is, is an actor or nobody',
    turn(state) === null || ACTORS.includes(turn(state)));

  return broken;
}

/* ------------------------------------------------------------------- the fold */

// One move. The app calls nothing else.
function step(state, move) {
  const verdict = adjudicate(state, move);
  if (!verdict.ok) {
    return {
      ok: false,
      state,
      rejection: {
        move: move && (move.trigger || move.to || move.kind || move.type),
        reason: verdict.reason,
        detail: verdict.detail,
        guards: verdict.guards || null,
        route: verdict.target ? route(state, verdict.target) : null,
      },
      broken: [],
    };
  }
  const next = heard(apply(state, move, verdict.edge), move);
  return { ok: true, state: next, rejection: null, broken: invariants(next) };
}

// Refused moves stay in the log — they are the record of what was tried, and
// the skip ladder reads them — and the fold walks past them.
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

const Lifecycle = {
  STATES,
  STEP_STATUS,
  VERDICTS,
  ACTORS,
  REJECTIONS,
  REJECTION_REASONS,
  GUARDS,
  GUARD_IDS,
  TRANSITIONS,
  TRIGGERS,
  ACTIONS,
  ACTION_KINDS,
  empty,
  turn,
  fresh,
  offers,
  route,
  edgesFrom,
  edgeByTrigger,
  guardReport,
  failingGuards,
  adjudicate,
  apply,
  step,
  reduce,
  replay,
  invariants,
  activeStep,
  openSteps,
  unmetCriteria,
  byId,
  clone,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Lifecycle;
