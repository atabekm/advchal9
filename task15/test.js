const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* The script list comes from index.html rather than from a list written here,
 * so a file added to the page without being wired up is caught by the tests
 * instead of by a blank screen. Until the page exists — stages 1 and 2 — the
 * fallback below stands in, and it is deleted the moment index.html arrives. */
const htmlPath = path.join(__dirname, 'index.html');
const SCRIPTS = fs.existsSync(htmlPath)
  ? [...fs.readFileSync(htmlPath, 'utf8').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])
  : ['lifecycle.js'];

for (const file of SCRIPTS.filter((name) => name !== 'app.js')) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), { filename: file });
}

let checks = 0;
let failures = 0;

function ok(claim, condition, detail = '') {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  ✗ ${claim}${detail ? `\n      ${detail}` : ''}`);
}

const queue = [];
function group(name, body) {
  queue.push(async () => {
    console.log(`\n${name}`);
    await body();
  });
}

// Every refusal this file actually provokes. The closed set is only closed if
// nothing in it is dead, so the last group compares the two.
const provoked = new Set();

function refuse(state, move) {
  const moved = Lifecycle.step(state, move);
  if (!moved.ok) provoked.add(moved.rejection.reason);
  return moved;
}

function drive(moves, from = Lifecycle.empty()) {
  let state = from;
  for (const move of moves) {
    const moved = Lifecycle.step(state, move);
    if (!moved.ok) {
      throw new Error(`${move.trigger || move.kind} was refused: ${moved.rejection.reason} — ${moved.rejection.detail}`);
    }
    if (moved.broken.length) throw new Error(`${move.trigger || move.kind} broke ${moved.broken.join('; ')}`);
    state = moved.state;
  }
  return state;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------- the fixture, task 13's
 *
 * The same goal task 13 used, so the two runs can be read side by side — with
 * one difference that is the point of this task: here the third criterion comes
 * back unmet, because a run that passes first time never reaches the back edge
 * or the stale verdict. */

const GOAL = "Write a Python function that parses a duration like '1h30m' into seconds, with tests.";

const START = { type: 'transition', actor: 'user', trigger: 'start', goal: GOAL };

const PLAN = {
  type: 'action',
  actor: 'model',
  kind: 'propose_plan',
  steps: [
    { title: 'Fix the grammar the parser accepts and how it fails' },
    { title: 'Write parse_duration' },
    { title: 'Write the tests' },
  ],
  acceptance: [
    { text: "parse_duration('1h30m') returns 5400" },
    { text: "a bare '45m' and a bare '2h' both parse" },
    { text: 'an unparseable string raises ValueError rather than returning None' },
  ],
};

const APPROVE = { type: 'transition', actor: 'user', trigger: 'approve_plan' };

function work(id) {
  return [
    { type: 'action', actor: 'model', kind: 'attach_artifact', step: id, artifact: `the work for ${id}` },
    { type: 'action', actor: 'model', kind: 'complete_step', step: id },
  ];
}

const THREE_STEPS = [...work('s1'), ...work('s2'), ...work('s3')];
const SUBMIT = { type: 'transition', actor: 'model', trigger: 'submit' };

function verdicts(state, unmet = []) {
  return {
    type: 'action',
    actor: 'model',
    kind: 'validate',
    verdicts: state.acceptance.map((a) => ({
      id: a.id,
      verdict: unmet.includes(a.id) ? 'unmet' : 'met',
      evidence: unmet.includes(a.id) ? 'it returns None' : 'the test passes',
    })),
  };
}

// In validation, with a3 unmet and the verdicts fresh.
function atFailedValidation() {
  const before = drive([START, PLAN, APPROVE, ...THREE_STEPS, SUBMIT]);
  return drive([verdicts(before, ['a3'])], before);
}

// In validation, with everything met and the verdicts fresh.
function atCleanValidation() {
  const before = drive([START, PLAN, APPROVE, ...THREE_STEPS, SUBMIT]);
  return drive([verdicts(before)], before);
}

/* ----------------------------------------------------------------- the table */

group('the table is a value, and it holds together', () => {
  const T = Lifecycle.TRANSITIONS;

  ok('edge ids are unique', new Set(T.map((e) => e.id)).size === T.length);
  ok('triggers are unique', new Set(T.map((e) => e.trigger)).size === T.length);
  ok('every from is a state or the start',
    T.every((e) => e.from === null || Lifecycle.STATES.includes(e.from)));
  ok('every to is a state', T.every((e) => Lifecycle.STATES.includes(e.to)));
  ok('every actor is one of the two', T.every((e) => Lifecycle.ACTORS.includes(e.actor)));
  ok('every guard named on an edge exists',
    T.every((e) => e.guards.every((id) => Lifecycle.GUARDS[id])));
  ok('every edge carries a note', T.every((e) => typeof e.note === 'string' && e.note.length > 10));

  ok('every guard has a label, an owner field, a remedy and a test',
    Lifecycle.GUARD_IDS.every((id) => {
      const g = Lifecycle.GUARDS[id];
      return typeof g.label === 'string' && 'owner' in g
        && typeof g.remedy === 'string' && typeof g.test === 'function';
    }));
  ok('no guard is dead — every one is named by some edge',
    Lifecycle.GUARD_IDS.every((id) => T.some((e) => e.guards.includes(id))));

  ok('done is terminal — no edge leaves it', Lifecycle.edgesFrom('done').length === 0);
  ok('every other state has a way out',
    [null, 'planning', 'execution', 'validation'].every((s) => Lifecycle.edgesFrom(s).length > 0));

  // The two claims the task turns on, asserted against the table rather than
  // against prose in a README.
  const build = Lifecycle.edgeByTrigger('approve_plan');
  ok('the only road into execution from planning is the person\'s',
    Lifecycle.edgesFrom('planning').every((e) => e.to !== 'execution' || e.actor === 'user'));
  ok('build is that road', build.from === 'planning' && build.to === 'execution');
  ok('nothing else enters execution from planning',
    Lifecycle.edgesFrom('planning').filter((e) => e.to === 'execution').length === 1);

  const leaving = Lifecycle.edgesFrom('validation');
  ok('three edges leave validation, which is what makes this a graph', leaving.length === 3);
  ok('the two that claim an outcome both need a fresh validation',
    leaving.filter((e) => e.trigger !== 'abandon')
      .every((e) => e.guards.includes('validation-fresh')));
  ok('abandon needs no evidence, because giving up needs no proof',
    Lifecycle.edgeByTrigger('abandon').guards.length === 0);

  ok('there is a back edge, which task 13 did not have',
    T.some((e) => e.from === 'validation' && e.to === 'execution'));
});

/* ------------------------------------------------------------------ the walk */

group('the ordinary path walks', () => {
  let state = drive([START]);
  ok('start opens planning', state.state === 'planning');
  ok('the goal is kept', state.goal === GOAL);
  ok('the model moves first in planning', Lifecycle.turn(state) === 'model');

  state = drive([PLAN], state);
  ok('a plan does not move the state', state.state === 'planning');
  ok('three steps and three criteria', state.steps.length === 3 && state.acceptance.length === 3);
  ok('the turn passes to the person once a plan exists', Lifecycle.turn(state) === 'user');
  ok('the revision has not moved — a plan is not work', state.revision === 0);

  state = drive([APPROVE], state);
  ok('approving is the edge into execution', state.state === 'execution');
  ok('s1 is active', Lifecycle.activeStep(state).id === 's1');

  const before = state.revision;
  state = drive(work('s1'), state);
  ok('working a step moves the revision twice', state.revision === before + 2);
  ok('the cursor walks to s2', Lifecycle.activeStep(state).id === 's2');

  state = drive([...work('s2'), ...work('s3')], state);
  ok('closing the last step leaves nothing active', Lifecycle.activeStep(state) === null);
  ok('finishing the steps does NOT move the state on its own', state.state === 'execution');
  ok('submit is open', Lifecycle.offers(state).transitions.find((t) => t.trigger === 'submit').open);

  state = drive([SUBMIT], state);
  ok('submit lands in validation', state.state === 'validation');

  state = drive([verdicts(state)], state);
  ok('validating does not move the state either', state.state === 'validation');
  ok('the validation stamps the revision it judged', state.validation.at === state.revision);
  ok('the turn passes back once the verdicts are in', Lifecycle.turn(state) === 'user');

  state = drive([{ type: 'transition', actor: 'user', trigger: 'accept' }], state);
  ok('accept closes the machine', state.state === 'done');
  ok('the outcome is accepted', state.outcome.result === 'accepted');
  ok('nothing is offered past done', Lifecycle.offers(state).transitions.length === 0);
  ok('nobody has the move', Lifecycle.turn(state) === null);
});

/* --------------------------------------------------------------- the refusals */

group('a skip is refused, and the refusal carries the road', () => {
  const planning = drive([START, PLAN]);

  const jump = refuse(planning, { type: 'transition', actor: 'user', to: 'done' });
  ok('planning to done is refused', !jump.ok);
  ok('and the reason is that there is no such edge', jump.rejection.reason === 'no-edge');
  ok('the refusal carries a route', jump.rejection.route && jump.rejection.route.ok);
  ok('the route is three moves', jump.rejection.route.path.length === 3);
  ok('and it goes the long way round',
    same(jump.rejection.route.path.map((p) => p.edge.trigger), ['approve_plan', 'submit', 'accept']));
  ok('the first edge of the route is adjudicated',
    jump.rejection.route.path[0].guards.every((g) => typeof g.holds === 'boolean'));
  ok('the rest are requirements, not verdicts',
    jump.rejection.route.path.slice(1).every((p) => p.guards.every((g) => g.holds === null)));
  ok('the state did not move', same(jump.state, planning));

  const named = refuse(planning, { type: 'transition', actor: 'model', trigger: 'submit' });
  ok('naming a trigger that belongs elsewhere is refused too', !named.ok);
  ok('and it is the same reason', named.rejection.reason === 'no-edge');

  const nowhere = refuse(planning, { type: 'transition', actor: 'user', to: 'shipping' });
  ok('a state that does not exist is refused', nowhere.rejection.reason === 'no-such-state');

  const theirs = refuse(planning, { type: 'transition', actor: 'model', trigger: 'approve_plan' });
  ok('the model cannot approve its own plan', theirs.rejection.reason === 'wrong-actor');
  ok('and the refusal says whose move it is',
    /user's move/.test(theirs.rejection.detail));

  const bare = drive([START]);
  const early = refuse(bare, { type: 'transition', actor: 'user', trigger: 'approve_plan' });
  ok('there is nothing to approve before a plan', early.rejection.reason === 'guard-unmet');
  ok('and both shut guards are named',
    same(early.rejection.guards.map((g) => g.id), ['plan-proposed', 'criteria-fixed']));
  ok('each shut guard carries a remedy',
    early.rejection.guards.every((g) => typeof g.remedy === 'string' && g.remedy.length > 0));
  ok('and an owner', early.rejection.guards.every((g) => g.owner === 'model'));

  const mid = drive([START, PLAN, APPROVE, ...work('s1')]);
  const early2 = refuse(mid, SUBMIT);
  ok('the work cannot be submitted with steps still open',
    early2.rejection.reason === 'guard-unmet');
  ok('and the shut guard is the right one',
    same(early2.rejection.guards.map((g) => g.id), ['every-step-closed']));

  const validating = atCleanValidation();
  const ambiguous = refuse(validating, { type: 'transition', actor: 'user', to: 'done' });
  ok('naming a destination with two roads is refused', ambiguous.rejection.reason === 'malformed');
  ok('and the refusal names both roads',
    /accept/.test(ambiguous.rejection.detail) && /abandon/.test(ambiguous.rejection.detail));
});

/* ----------------------------------------------------------- the stale verdict */

group('a validation goes stale the moment the work moves', () => {
  let state = atFailedValidation();
  ok('a3 came back unmet', same(Lifecycle.unmetCriteria(state), ['a3']));
  ok('the verdicts are fresh', Lifecycle.fresh(state));

  const shut = refuse(state, { type: 'transition', actor: 'user', trigger: 'accept' });
  ok('accept is shut while something is unmet', shut.rejection.reason === 'guard-unmet');
  ok('and it is every-criterion-met that is shut',
    same(shut.rejection.guards.map((g) => g.id), ['every-criterion-met']));

  const stamp = state.validation.at;
  state = drive([{
    type: 'transition', actor: 'user', trigger: 'rework', step: 's3',
    reason: 'it returns None instead of raising',
  }], state);
  ok('rework lands back in execution', state.state === 'execution');
  ok('the reopened step is active again', Lifecycle.activeStep(state).id === 's3');
  ok('its artifact is gone', Lifecycle.byId(state.steps, 's3').artifact === null);
  ok('the round is counted', state.rounds === 1);
  ok('the revision moved', state.revision > stamp);
  ok('so the validation is now stale', !Lifecycle.fresh(state));
  ok('the stamp itself did not move', state.validation.at === stamp);

  state = drive([...work('s3'), SUBMIT], state);
  ok('back in validation', state.state === 'validation');
  ok('and the old verdicts are still stale', !Lifecycle.fresh(state));

  // This is the whole task in one assertion.
  const early = refuse(state, { type: 'transition', actor: 'user', trigger: 'accept' });
  ok('finishing on a stale validation is refused', early.rejection.reason === 'guard-unmet');
  ok('and the guard that stops it is freshness',
    early.rejection.guards.some((g) => g.id === 'validation-fresh'));

  const back = refuse(state, {
    type: 'transition', actor: 'user', trigger: 'rework', step: 's3', reason: 'again',
  });
  ok('and so is going back again', back.rejection.reason === 'guard-unmet');
  ok('so the only legal move is to validate again',
    same(Lifecycle.offers(state).transitions.filter((t) => t.open).map((t) => t.trigger), ['abandon']));
  ok('and the turn is the model\'s', Lifecycle.turn(state) === 'model');

  state = drive([verdicts(state)], state);
  ok('a fresh validation opens the door', Lifecycle.fresh(state));
  ok('accept is open now',
    Lifecycle.offers(state).transitions.find((t) => t.trigger === 'accept').open);

  state = drive([{ type: 'transition', actor: 'user', trigger: 'accept' }], state);
  ok('and the task closes accepted', state.outcome.result === 'accepted');
  ok('with a validation that judged the final revision',
    state.validation.at === state.revision);
});

group('the back edge has guards of its own', () => {
  const clean = atCleanValidation();
  const pointless = refuse(clean, {
    type: 'transition', actor: 'user', trigger: 'rework', step: 's1', reason: 'why not',
  });
  ok('nothing goes back when nothing failed', pointless.rejection.reason === 'guard-unmet');
  ok('and the shut guard says so',
    same(pointless.rejection.guards.map((g) => g.id), ['some-criterion-unmet']));

  const failed = atFailedValidation();
  const nameless = refuse(failed, { type: 'transition', actor: 'user', trigger: 'rework', reason: 'x' });
  ok('rework has to name a step', nameless.rejection.reason === 'malformed');

  const ghost = refuse(failed, {
    type: 'transition', actor: 'user', trigger: 'rework', step: 's9', reason: 'x',
  });
  ok('and it has to be a real one', ghost.rejection.reason === 'unknown-step');

  const silent = refuse(failed, { type: 'transition', actor: 'user', trigger: 'rework', step: 's3' });
  ok('and it has to say why', silent.rejection.reason === 'malformed');

  const twice = drive([
    { type: 'transition', actor: 'user', trigger: 'rework', step: 's3', reason: 'one' },
    ...work('s3'), SUBMIT,
  ], failed);
  const again = drive([verdicts(twice, ['a3'])], twice);
  const looped = drive([
    { type: 'transition', actor: 'user', trigger: 'rework', step: 's3', reason: 'two' },
  ], again);
  ok('the loop is allowed, and counted rather than capped', looped.rounds === 2);
});

/* --------------------------------------------------------- actions and refusals */

group('an action belongs to a state, and to a party', () => {
  const executing = drive([START, PLAN, APPROVE]);

  ok('validating during execution is refused',
    refuse(executing, { type: 'action', actor: 'model', kind: 'validate', verdicts: [] })
      .rejection.reason === 'wrong-state');

  ok('a step that does not exist is refused',
    refuse(executing, { type: 'action', actor: 'model', kind: 'attach_artifact', step: 's9', artifact: 'x' })
      .rejection.reason === 'unknown-step');

  ok('a step that is not the active one is refused',
    refuse(executing, { type: 'action', actor: 'model', kind: 'attach_artifact', step: 's2', artifact: 'x' })
      .rejection.reason === 'wrong-step');

  ok('closing an empty step is refused',
    refuse(executing, { type: 'action', actor: 'model', kind: 'complete_step', step: 's1' })
      .rejection.reason === 'missing-artifact');

  ok('the person cannot do the model\'s work',
    refuse(executing, { type: 'action', actor: 'user', kind: 'attach_artifact', step: 's1', artifact: 'x' })
      .rejection.reason === 'wrong-actor');

  const asked = drive([
    { type: 'action', actor: 'model', kind: 'ask_user', question: 'seconds or milliseconds?' },
  ], executing);
  ok('a question passes the turn', Lifecycle.turn(asked) === 'user');
  ok('and nothing else moves until it is answered',
    refuse(asked, { type: 'action', actor: 'model', kind: 'attach_artifact', step: 's1', artifact: 'x' })
      .rejection.reason === 'question-open');
  ok('edges are shut while a question is open',
    Lifecycle.offers(asked).transitions.every((t) => !t.open));

  const answered = drive([{ type: 'action', actor: 'model', kind: 'ask_user', question: 'q' }], executing);
  const settled = drive([{ type: 'action', actor: 'user', kind: 'answer', text: 'seconds' }], answered);
  ok('an answer is kept where settled things are kept',
    settled.decisions[settled.decisions.length - 1].text === 'seconds');
  ok('and the question closes', settled.question === null);

  const beforeVerdicts = drive([START, PLAN, APPROVE, ...THREE_STEPS, SUBMIT]);
  ok('a verdict for a criterion that does not exist is refused',
    refuse(beforeVerdicts, {
      type: 'action', actor: 'model', kind: 'validate',
      verdicts: [{ id: 'a9', verdict: 'met', evidence: 'e' }],
    }).rejection.reason === 'unknown-criterion');

  ok('validating twice over is refused — the turn has passed',
    refuse(atCleanValidation(), verdicts(atCleanValidation())).rejection.reason === 'wrong-actor');

  ok('a partial validation is refused',
    refuse(beforeVerdicts, {
      type: 'action', actor: 'model', kind: 'validate',
      verdicts: [{ id: 'a1', verdict: 'met', evidence: 'e' }],
    }).rejection.reason === 'incomplete-verdicts');

  const done = drive([START, PLAN, APPROVE, ...THREE_STEPS, SUBMIT]);
  const closed = drive([verdicts(done), { type: 'transition', actor: 'user', trigger: 'accept' }], done);
  ok('nothing moves a closed machine',
    refuse(closed, { type: 'action', actor: 'user', kind: 'pause' }).rejection.reason === 'terminal');

  ok('a move with no actor is malformed',
    refuse(executing, { type: 'transition', trigger: 'submit' }).rejection.reason === 'malformed');
  ok('a move that is neither a transition nor an action is malformed',
    refuse(executing, { type: 'wish', actor: 'user' }).rejection.reason === 'malformed');
});

/* ------------------------------------------------------------ pause and resume */

group('pause holds every state still, and resume works it out again', () => {
  const stations = {
    planning: drive([START, PLAN]),
    execution: drive([START, PLAN, APPROVE, ...work('s1')]),
    validation: atFailedValidation(),
  };

  for (const [name, state] of Object.entries(stations)) {
    ok(`${name}: the station is where it says it is`, state.state === name);

    const paused = drive([{ type: 'action', actor: 'user', kind: 'pause' }], state);
    const { paused: _p, ...restBefore } = state;
    const { paused: _q, ...restAfter } = paused;
    ok(`${name}: pausing changes the flag and nothing else`, same(restBefore, restAfter));

    ok(`${name}: only resume is offered`,
      same(Lifecycle.offers(paused).actions.map((a) => a.kind), ['resume']));
    ok(`${name}: and no edge is offered`, Lifecycle.offers(paused).transitions.length === 0);

    const blocked = refuse(paused, { type: 'transition', actor: 'user', trigger: 'accept' });
    ok(`${name}: a paused machine refuses with paused`, blocked.rejection.reason === 'paused');

    const resumed = drive([{ type: 'action', actor: 'user', kind: 'resume' }], state === paused ? state : paused);
    ok(`${name}: resuming puts it back exactly`, same(resumed, state));
    ok(`${name}: and the offers come back the same`,
      same(Lifecycle.offers(resumed), Lifecycle.offers(state)));
  }
});

group('the offers are derived, never stored', () => {
  const state = atFailedValidation();
  ok('no field of the state is called offers', !('offers' in state));
  ok('nor turn', !('turn' in state));

  const roundTripped = JSON.parse(JSON.stringify(state));
  ok('offers survive a serialise and parse',
    same(Lifecycle.offers(roundTripped), Lifecycle.offers(state)));

  // The point of the exercise: hand the same fold a log that grew while you
  // were away, and the offers come back different — correctly different —
  // because nothing was remembered.
  const log = [START, PLAN, APPROVE, ...THREE_STEPS, SUBMIT];
  const short = Lifecycle.reduce(log);
  const grown = Lifecycle.reduce([...log, verdicts(short)]);
  ok('a shorter log waits on the model', Lifecycle.turn(short) === 'model');
  ok('a longer one waits on the person', Lifecycle.turn(grown) === 'user');
  ok('and the open edges differ accordingly',
    !same(
      Lifecycle.offers(short).transitions.filter((t) => t.open).map((t) => t.trigger),
      Lifecycle.offers(grown).transitions.filter((t) => t.open).map((t) => t.trigger),
    ));

  const refused = [...log, { type: 'transition', actor: 'user', to: 'done', rejected: true }];
  ok('a refused move is kept in the log and walked past',
    same(Lifecycle.reduce(refused), short));
});

/* ------------------------------------------------------------------ the route */

group('the route agrees with the table', () => {
  const truth = {
    'planning→done': ['approve_plan', 'submit', 'accept'],
    'planning→validation': ['approve_plan', 'submit'],
    'execution→done': ['submit', 'accept'],
    'validation→execution': ['rework'],
    'execution→planning': null,
    'done→planning': null,
  };

  for (const [pair, expected] of Object.entries(truth)) {
    const [from, to] = pair.split('→');
    const state = { ...Lifecycle.empty(), state: from };
    const found = Lifecycle.route(state, to);
    if (expected === null) {
      ok(`${pair} is unreachable`, !found.ok);
    } else {
      ok(`${pair} is ${expected.join(' → ')}`,
        found.ok && same(found.path.map((p) => p.edge.trigger), expected),
        found.ok ? found.path.map((p) => p.edge.trigger).join(' → ') : 'unreachable');
    }
  }

  ok('a state to itself is the empty route',
    Lifecycle.route({ ...Lifecycle.empty(), state: 'planning' }, 'planning').path.length === 0);
  ok('a name that is not a state is refused',
    Lifecycle.route(Lifecycle.empty(), 'shipping').reason === 'no-such-state');
  ok('every state is reachable from the start',
    Lifecycle.STATES.every((s) => Lifecycle.route(Lifecycle.empty(), s).ok));
});

/* ------------------------------------------------------------------- the fuzz */

group('80,000 random moves break nothing', () => {
  let seed = 20260919;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const badReason = [];
  const broke = [];
  const moved = [];

  let state = Lifecycle.empty();
  for (let i = 0; i < 80000; i += 1) {
    const move = rand() < 0.5
      ? {
        type: 'transition',
        actor: pick(Lifecycle.ACTORS),
        ...(rand() < 0.5
          ? { trigger: pick([...Lifecycle.TRIGGERS, 'teleport']) }
          : { to: pick([...Lifecycle.STATES, 'shipping']) }),
        goal: GOAL,
        reason: 'because',
        step: pick(['s1', 's2', 's3', 's9']),
      }
      : {
        type: 'action',
        actor: pick(Lifecycle.ACTORS),
        kind: pick([...Lifecycle.ACTION_KINDS, 'hope']),
        step: pick(['s1', 's2', 's3', 's9']),
        artifact: 'work',
        reason: 'because',
        note: 'change it',
        question: 'which?',
        text: 'this one',
        steps: PLAN.steps,
        acceptance: PLAN.acceptance,
        verdicts: state.acceptance.map((a) => ({ id: a.id, verdict: pick(['met', 'unmet']), evidence: 'e' })),
      };

    const before = JSON.stringify(state);
    const result = Lifecycle.step(state, move);
    if (result.ok) {
      if (result.broken.length) broke.push(result.broken.join('; '));
      state = result.state;
      moved.push(move.trigger || move.kind);
    } else {
      if (!Lifecycle.REJECTION_REASONS.includes(result.rejection.reason)) {
        badReason.push(result.rejection.reason);
      }
      provoked.add(result.rejection.reason);
      if (JSON.stringify(result.state) !== before) broke.push('a refusal moved the state');
    }
    if (state.state === 'done') state = Lifecycle.empty();
  }

  ok('no invariant was ever broken', broke.length === 0, broke.slice(0, 3).join(' | '));
  ok('every refusal came from the closed set', badReason.length === 0, [...new Set(badReason)].join(', '));
  ok('and the walk actually went somewhere', moved.length > 1000, `${moved.length} moves landed`);
});

/* -------------------------------------------------------------- the closed set */

group('the closed set is closed, and nothing in it is dead', () => {
  for (const reason of Lifecycle.REJECTION_REASONS) {
    ok(`${reason} is reachable`, provoked.has(reason));
  }
  ok('and nothing was provoked that is not in the set',
    [...provoked].every((r) => Lifecycle.REJECTION_REASONS.includes(r)));
});

/* ------------------------------------------------------------------------ run */

(async () => {
  for (const run of queue) await run();
  console.log(`\n${checks} checks, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})();
