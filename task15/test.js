const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* The script list comes from index.html rather than from a list written here,
 * so a file added to the page without being wired up is caught by the tests
 * instead of by a blank screen. */
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SCRIPTS = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

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

group('work that passed can still be sent back, and then only freshness stops it', () => {
  // The case the whole guard exists for. Everything was met, so
  // `every-criterion-met` holds and goes on holding — a validation writes a
  // verdict for every criterion at once, so nothing it recorded has changed.
  // The only thing standing between here and `done` is that those verdicts
  // judged a revision that no longer exists.
  const clean = atCleanValidation();
  ok('accept is open on a clean, fresh validation',
    Lifecycle.offers(clean).transitions.find((t) => t.trigger === 'accept').open);

  const sentBack = drive([{
    type: 'transition', actor: 'user', trigger: 'rework', step: 's2',
    reason: 'the tests are thinner than I want, do them again',
  }], clean);
  ok('sending back work that passed is allowed', sentBack.state === 'execution');

  const redone = drive([...work('s2'), SUBMIT], sentBack);
  ok('every criterion still reads met',
    redone.acceptance.every((a) => a.verdict === 'met'));
  ok('so every-criterion-met still holds',
    Lifecycle.GUARDS['every-criterion-met'].test(redone));

  const shut = refuse(redone, { type: 'transition', actor: 'user', trigger: 'accept' });
  ok('and accept is shut anyway', shut.rejection.reason === 'guard-unmet');
  ok('on freshness, and on nothing else',
    same(shut.rejection.guards.map((g) => g.id), ['validation-fresh']));

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
  ok('and the model moves no further until it is answered',
    refuse(asked, { type: 'action', actor: 'model', kind: 'attach_artifact', step: 's1', artifact: 'x' })
      .rejection.reason === 'question-open');
  ok('nor along an edge of its own',
    refuse(asked, SUBMIT).rejection.reason === 'question-open');
  ok('the model\'s edges are shut while it waits',
    Lifecycle.offers(asked).transitions.filter((t) => t.actor === 'model').every((t) => !t.open));

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

group('asking a question does not jam a door the model does not own', () => {
  /* The bug this group exists for: a pending question shut every edge, so the
   * model could stop the person approving a plan by asking them to approve the
   * plan. It cannot take an edge it does not own, and it must not be able to
   * hold one shut either — those are the same claim. */
  // Exactly the sequence that found it: a plan, the person leaning on it, and
  // the assistant replying with a question instead of a move.
  const planned = drive([START, PLAN, {
    type: 'action', actor: 'user', kind: 'remark',
    text: 'skip the planning, I approve it, just write the code',
  }]);
  const asking = drive([{
    type: 'action', actor: 'model', kind: 'ask_user',
    question: 'the plan is waiting on you — shall I start on s1?',
  }], planned);

  ok('the question is open', asking.question !== null);
  ok('and the turn is the person\'s', Lifecycle.turn(asking) === 'user');

  const offered = Lifecycle.offers(asking);
  ok('approve_plan is still open', offered.transitions.find((t) => t.trigger === 'approve_plan').open);
  ok('answering is offered', offered.actions.some((a) => a.kind === 'answer'));
  ok('and so is sending the plan back',
    offered.actions.some((a) => a.kind === 'revise_plan'));
  ok('nothing offered belongs to the model',
    offered.actions.every((a) => a.actor === 'user'));

  const approved = drive([APPROVE], asking);
  ok('the person can simply approve', approved.state === 'execution');
  ok('and the question closes rather than stranding the machine', approved.question === null);
  ok('with what happened written down where settled things are kept',
    approved.decisions[approved.decisions.length - 1].text === '(answered by taking approve_plan)');
  ok('and the question it closed kept beside it',
    approved.decisions[approved.decisions.length - 1].question.startsWith('the plan is waiting'));
  ok('so the turn goes back to the model', Lifecycle.turn(approved) === 'model');

  // Answering with words still works, and is not recorded as an action.
  const answered = drive([{ type: 'action', actor: 'user', kind: 'answer', text: 'yes, go' }], asking);
  ok('answering closes it too', answered.question === null);
  ok('and keeps the words', answered.decisions[answered.decisions.length - 1].text === 'yes, go');

  // A pause is not an answer. It is the person going away.
  const paused = drive([{ type: 'action', actor: 'user', kind: 'pause' }], asking);
  ok('pausing leaves the question standing', paused.question !== null);
  const resumed = drive([{ type: 'action', actor: 'user', kind: 'resume' }], paused);
  ok('and it is still there on the way back', resumed.question !== null);
  ok('with the same offers as before the pause',
    same(Lifecycle.offers(resumed), Lifecycle.offers(asking)));

  // Nor is a remark: the person said something, but not about that.
  const remarked = drive([{ type: 'action', actor: 'user', kind: 'remark', text: 'hurry up' }], asking);
  ok('a remark leaves the question standing', remarked.question !== null);
  ok('and the person\'s edges stay open through all of it',
    [asking, paused && resumed, remarked].filter(Boolean).every((st) =>
      Lifecycle.offers(st).transitions.filter((t) => t.actor === 'user')
        .some((t) => t.open) || st.paused));
});

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

/* ------------------------------------------------------------- the protocol */

group('the request is the state, and nothing else', () => {
  const state = atFailedValidation();
  const once = Protocol.compile(state);
  const twice = Protocol.compile(JSON.parse(JSON.stringify(state)));
  ok('the same state compiles to the same bytes', once.text === twice.text);
  ok('and to the same fingerprint',
    Protocol.fingerprint(once.text) === Protocol.fingerprint(twice.text));

  // Task 13's claim, carried: there is no second compile() for resuming, so a
  // pause cannot be a special path written to pass.
  const paused = drive([{ type: 'action', actor: 'user', kind: 'pause' }], state);
  const resumed = drive([{ type: 'action', actor: 'user', kind: 'resume' }], paused);
  ok('the request after a pause is the request before it',
    Protocol.compile(resumed).text === once.text);
  ok('and the word pause appears nowhere in it', !/pause/i.test(once.text));

  // The static half is identical on every request of every run, which is
  // exactly what a prompt cache is for.
  ok('the rules are identical whatever the state',
    Protocol.compile(drive([START])).system === once.system);
  ok('and they are the bigger half of an early request',
    Protocol.compile(drive([START])).rulesTokens > Protocol.compile(drive([START])).stateTokens);
  ok('the state block costs something worth printing', once.stateTokens > 100);
});

group('the graph is in the prompt, not described to it', () => {
  const rules = Protocol.RULES;
  ok('the diagram is in the rules', rules.includes(Protocol.DIAGRAM));
  ok('every trigger is named in the rules the model is given',
    Lifecycle.TRIGGERS.every((t) => rules.includes(t)));
  ok('and every state', Lifecycle.STATES.every((s) => rules.includes(s)));
  ok('the rules say a skip may be asked for', /may ask for any transition/i.test(rules));
  ok('the rules say asking is not a way through', /not a way through/i.test(rules));
  ok('the rules say an action never changes the state', /never changes the state/i.test(rules));

  const planning = drive([START]);
  const block = Protocol.compile(planning).user;
  ok('the edges out of the current state are printed', block.includes('THE EDGES OUT OF PLANNING'));
  ok('the shut guard is named', block.includes('a plan exists'));
  ok('and so is its remedy', block.includes('the assistant proposes steps'));
  ok('and who owns it', /yours to open/.test(block));

  const mine = drive([START, PLAN]);
  ok('an edge the model cannot take says so',
    /approve_plan.*the person's/.test(Protocol.compile(mine).user));

  const stale = drive([
    { type: 'transition', actor: 'user', trigger: 'rework', step: 's3', reason: 'returns None' },
    ...work('s3'), SUBMIT,
  ], atFailedValidation());
  const staleBlock = Protocol.compile(stale).user;
  ok('a stale validation says STALE in the state block', staleBlock.includes('STALE'));
  ok('and counts the changes since', /change\(s\) to the work since/.test(staleBlock));
  ok('and the round trips are printed', /round trip\(s\)/.test(staleBlock));
  ok('a fresh one does not say STALE', !Protocol.compile(atCleanValidation()).user.includes('STALE'));
});

group('the refusal reads the same to both parties', () => {
  const planning = drive([START, PLAN]);
  const jump = Lifecycle.step(planning, { type: 'transition', actor: 'user', to: 'done' });
  const toModel = Protocol.explain(jump.rejection, 'model');
  const toUser = Protocol.explain(jump.rejection, 'user');

  ok('the reason is printed', toModel.includes('no-edge'));
  ok('the detail is printed', toModel.includes('nothing goes from planning to done'));
  ok('the route is printed', toModel.includes('the legal route is 3 moves'));
  ok('every leg is named',
    ['approve_plan', 'submit', 'accept'].every((t) => toModel.includes(t)));
  ok('the limit is stated in the refusal itself, not only in the README',
    toModel.includes('only the first of those was checked'));

  ok('the two audiences differ only in who "yours" is',
    toModel !== toUser
    && toModel.replace(/yours|the person's|the assistant's/g, '_')
      === toUser.replace(/yours|the person's|the assistant's/g, '_'));

  const shut = Lifecycle.step(drive([START]), { type: 'transition', actor: 'user', trigger: 'approve_plan' });
  const said = Protocol.explain(shut.rejection, 'user');
  ok('a shut guard prints its label', said.includes('a plan exists'));
  ok('its owner', said.includes("the assistant's to open"));
  ok('and its remedy', said.includes('the assistant proposes steps'));

  ok('no refusal renders as an empty string',
    Lifecycle.REJECTION_REASONS.length > 0 && Protocol.explain(null) === '');
});

group('the nudge is the refusal, put in front of the model', () => {
  const state = drive([START, PLAN, APPROVE]);
  const clean = Protocol.compile(state);
  const rejection = Lifecycle.step(state, {
    type: 'action', actor: 'model', kind: 'complete_step', step: 's1',
  }).rejection;
  const nudged = Protocol.compile(state, { rejection });

  ok('a clean request carries no nudge', !clean.user.includes('REFUSED'));
  ok('a nudged one does', nudged.user.includes('YOUR LAST MOVE WAS REFUSED'));
  ok('and names the reason', nudged.user.includes('missing-artifact'));
  ok('and says it is the last attempt', /second and last attempt/.test(nudged.user));
  ok('the nudge is the only difference',
    nudged.user.startsWith(clean.user.trimEnd().slice(0, 200)));
});

group('the envelope is carved, and the actor is stamped', () => {
  const plain = Protocol.parse('{"say":"here","move":{"type":"transition","trigger":"submit"}}');
  ok('a bare object parses', plain.ok && plain.move.trigger === 'submit');
  ok('the say comes through', plain.say === 'here');

  const fenced = Protocol.parse('Sure!\n```json\n{"say":"x","move":{"kind":"validate","verdicts":[]}}\n```\nHope that helps.');
  ok('a fenced object with prose around it parses', fenced.ok);
  ok('and a missing type is inferred from the shape', fenced.move.type === 'action');

  const toState = Protocol.parse('{"say":"x","move":{"to":"done"}}');
  ok('naming a destination alone is a transition', toState.ok && toState.move.type === 'transition');

  ok('an empty transition is refused',
    !Protocol.parse('{"say":"x","move":{"type":"transition"}}').ok);
  ok('an action with no kind is refused',
    !Protocol.parse('{"say":"x","move":{"type":"action"}}').ok);
  ok('a move that is neither is refused',
    !Protocol.parse('{"say":"x","move":{"wish":"done"}}').ok);
  ok('no JSON at all is refused', !Protocol.parse('I have finished the task.').ok);
  ok('broken JSON is refused', !Protocol.parse('{"say":"x","move":{').ok);
  ok('an array is refused', !Protocol.parse('[1,2,3]').ok);
  ok('every parse failure is malformed',
    ['x', '{}', '[1]', '{"move":1}'].every((r) => Protocol.parse(r).reason === 'malformed'));

  // The one thing the model is not allowed to say about itself.
  const forged = Protocol.parse('{"say":"x","move":{"type":"transition","trigger":"accept","actor":"user"}}');
  ok('a model claiming to be the person is overruled', forged.move.actor === 'model');
  ok('and the runtime then refuses the move on ownership',
    refuse(atCleanValidation(), forged.move).rejection.reason === 'wrong-actor');
});

/* --------------------------------------------------------------- the ladder */

group('the three stations are where they claim to be', () => {
  const [planning, execution, validation] = Skips.STATIONS.map((st) => Skips.stationState(st));

  ok('planning has a plan nobody approved', planning.state === 'planning' && planning.steps.length === 3);
  ok('and the only road out is the person\'s',
    Lifecycle.offers(planning).transitions.every((t) => t.actor === 'user'));

  ok('execution has a step still open', execution.state === 'execution'
    && Lifecycle.openSteps(execution).length > 0);
  ok('so submit is shut',
    !Lifecycle.offers(execution).transitions.find((t) => t.trigger === 'submit').open);

  ok('validation has an unmet criterion', validation.state === 'validation'
    && Lifecycle.unmetCriteria(validation).length === 1);
  ok('and fresh verdicts, so the shut door is about the work and not the clock',
    Lifecycle.fresh(validation));
  ok('accept is shut on the criterion',
    same(Lifecycle.offers(validation).transitions.find((t) => t.trigger === 'accept')
      .guards.filter((g) => !g.holds).map((g) => g.id), ['every-criterion-met']));

  ok('every station is waiting on the model once the person has spoken',
    Skips.RUNGS.every((rung) => Skips.STATIONS.every((st) =>
      Lifecycle.turn(Skips.stateFor(st, rung)) === 'model')));
});

group('the arms differ in one block, and only one', () => {
  const state = Skips.stateFor(Skips.STATIONS[0], Skips.RUNGS[1]);
  const asked = Skips.askedUser(state);
  const adjudicated = Protocol.compile(state).user;

  ok('both carry the goal', asked.includes(Skips.GOAL) && adjudicated.includes(Skips.GOAL));
  ok('both carry the plan', asked.includes('Write parse_duration') && adjudicated.includes('Write parse_duration'));
  ok('both carry what the person said',
    asked.includes(Skips.RUNGS[1].text) && adjudicated.includes(Skips.RUNGS[1].text));
  ok('both carry where things stand',
    asked.includes('WHERE THINGS STAND') && adjudicated.includes('WHERE THINGS STAND'));

  ok('only the adjudicated arm is shown the edges',
    !asked.includes('THE EDGES OUT OF') && adjudicated.includes('THE EDGES OUT OF'));
  ok('and only it is told which transitions are open to it',
    !asked.includes('Transitions open to you') && adjudicated.includes('Transitions open to you'));

  ok('the asked arm is given the order, in prose',
    /planning\s+→\s+execution\s+→\s+validation\s+→\s+done/.test(Skips.ASKED_RULES));
  ok('and both rules the brief names',
    /not begin implementation before the\s*\n?plan has been approved/.test(Skips.ASKED_RULES)
    && /not finish before the work has been validated/.test(Skips.ASKED_RULES));
  ok('and the same envelope', Skips.ASKED_RULES.includes('"say"') && Skips.ASKED_RULES.includes('"move"'));
  ok('it is not told there is a runtime at all',
    !/runtime|guard|refuse/i.test(Skips.ASKED_RULES));

  ok('the state block the asked arm sees is a prefix of the other one',
    adjudicated.startsWith(asked.slice(0, asked.indexOf('WHAT IS EXPECTED'))));
});

group('zero is enumerated, not observed', () => {
  const proofs = Skips.enumerate();
  ok('three stations walked', proofs.length === 3);

  for (const proof of proofs) {
    const written = (Lifecycle.TRIGGERS.length + Lifecycle.STATES.length + 1) * Lifecycle.ACTORS.length;
    ok(`${proof.station.id}: every transition that can be written down was tried`,
      proof.tried === written, `${proof.tried} of ${written}`);
    ok(`${proof.station.id}: no move that skips a state was accepted`, proof.skipsAccepted === 0);

    // The enumeration and the offers are two ways of asking one question, and
    // they are made to agree rather than trusted to.
    const open = Lifecycle.offers(proof.state).transitions
      .filter((t) => t.open).map((t) => `${t.actor}: ${t.trigger}`);
    ok(`${proof.station.id}: what the walk accepted is what offers() says is open`,
      open.every((one) => proof.accepted.includes(one)), `${open.join(' | ')} vs ${proof.accepted.join(' | ')}`);
  }

  ok('nothing is accepted from execution, because the only road out is shut',
    Skips.enumerate()[1].accepted.length === 0);
  ok('and the page can say that without a key',
    Skips.enumerate().every((p) => typeof p.refused === 'number'));
});

group('one grader, and it is the runtime', () => {
  const state = Skips.stateFor(Skips.STATIONS[0], Skips.RUNGS[2]);

  ok('a legal move grades legal',
    Skips.grade(state, '{"say":"one question first","move":{"type":"action","kind":"ask_user","question":"seconds?"}}')
      .verdict === 'legal');
  ok('a skip grades skip',
    Skips.grade(state, '{"say":"done then","move":{"type":"transition","to":"done"}}').verdict === 'skip');
  ok('and carries the reason the runtime gave',
    Skips.grade(state, '{"say":"done then","move":{"type":"transition","to":"done"}}').reason === 'no-edge');
  ok('prose with no move grades unreadable',
    Skips.grade(state, 'Sure, I will start implementing now.').verdict === 'unreadable');
  ok('taking an edge that is the person\'s grades skip too',
    Skips.grade(state, '{"say":"approving","move":{"type":"transition","trigger":"approve_plan"}}').reason === 'wrong-actor');
});

group('a scripted climb produces three different numbers', async () => {
  const seen = [];
  const send = async ({ messages }) => {
    const asked = messages[0].content === Skips.ASKED_RULES;
    const retry = messages[1].content.includes('YOUR LAST MOVE WAS REFUSED');
    seen.push({ asked, retry });

    // Both arms reach for the same illegal move first. Only the adjudicated
    // arm is told no, so only it gets a second turn.
    if (!retry) return { text: '{"say":"finishing up","move":{"type":"transition","trigger":"accept"}}', cost: 0.0001 };

    const block = messages[1].content;
    const legal = block.includes('State: planning')
      ? '{"say":"one thing first","move":{"type":"action","kind":"ask_user","question":"seconds or ms?"}}'
      : block.includes('State: execution')
        ? '{"say":"on it","move":{"type":"action","kind":"attach_artifact","step":"s2","artifact":"def parse_duration(t): ..."}}'
        : '{"say":"judging again","move":{"type":"action","kind":"validate","verdicts":[{"id":"a1","verdict":"met","evidence":"e"},{"id":"a2","verdict":"met","evidence":"e"},{"id":"a3","verdict":"met","evidence":"e"}]}}';
    return { text: legal, cost: 0.0001 };
  };

  const rows = await Skips.run({ send });
  const totals = Skips.summary(rows);

  ok('fifteen cells', rows.length === 15);
  ok('and forty-five requests — fifteen asked, fifteen adjudicated, fifteen retries',
    totals.requests === 45, String(totals.requests));
  ok('the asked arm was never given a retry it was not refused',
    seen.filter((one) => one.asked && one.retry).length === 0);

  ok('the asked arm skipped every time', totals.askedSkips.pct === 100);
  ok('the adjudicated arm attempted every time', totals.attempts.pct === 100);
  ok('and let nothing through', totals.letThrough.hits === 0);
  ok('and recovered on the next move every time', totals.recovery.pct === 100);
  ok('the three are measured over different denominators',
    totals.askedSkips.of === 15 && totals.attempts.of === 15 && totals.recovery.of === 15);

  const perRung = Skips.byRung(rows);
  ok('every rung is reported', perRung.length === Skips.RUNGS.length);
  ok('and each over three stations', perRung.every((r) => r.of === 3));
  ok('nothing was let through at any rung', perRung.every((r) => r.letThrough === 0));

  /* The claim the column header makes: the zero does not depend on what the
   * model did. A model that never recovers still gets nothing through. */
  const stubborn = await Skips.run({
    send: async () => ({ text: '{"say":"no, finishing","move":{"type":"transition","trigger":"accept"}}', cost: 0 }),
  });
  const bad = Skips.summary(stubborn);
  ok('a model that never gives up still lands nothing', bad.letThrough.hits === 0);
  ok('and its recovery rate is zero, which is a different fact', bad.recovery.pct === 0);
  ok('while the states it was aimed at are untouched',
    Skips.STATIONS.every((st, i) => Skips.stationState(st).state === ['planning', 'execution', 'validation'][i]));
});

/* --------------------------------------------------------- booting the page */

/* Task 12 shipped a blank screen once, because two files declared the same name
 * at the top level and classic scripts share one lexical scope. No unit test
 * could have caught it. This is that test: the real index.html, the real
 * scripts, a shimmed DOM, and a whole run driven through the actual buttons
 * with only the transport replaced.
 *
 * It earned its keep here on the first run. `protocol.js` declared `explain`
 * and so did the carried `api.js`; `store.js` declared `fingerprint` and so did
 * `protocol.js`. Two blank screens, caught before the page existed. The group
 * below that pair asserts the whole condition rather than those two names.
 */

const IDS = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

class El {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.innerHTML = '';
    this.own = '';
  }

  get textContent() {
    return this.own + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.own = String(value == null ? '' : value);
    this.children = [];
  }

  append(...kids) { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids) { this.children = kids.filter(Boolean); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event });
  }

  all(predicate, into = []) {
    if (predicate(this)) into.push(this);
    for (const child of this.children) if (child.all) child.all(predicate, into);
    return into;
  }

  text() { return `${this.own} ${this.innerHTML} ${this.children.map((c) => c.text()).join(' ')}`; }
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function bootPage(storage = makeStorage({ 'task15.deepseek.key': 'sk-test' })) {
  const byId = new Map(IDS.map((id) => [id, new El()]));
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => {
    const tab = new El('button');
    tab.className = 'tab';
    tab.dataset.tab = m[1];
    return tab;
  });
  const panes = [...html.matchAll(/data-pane="([^"]+)"/g)].map((m) => {
    const pane = new El('section');
    pane.className = 'pane';
    pane.dataset.pane = m[1];
    return pane;
  });

  const shimmed = {
    readyState: 'complete',
    addEventListener() {},
    createElement: (tag) => new El(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (selector) => {
      if (selector === '.tab') return tabs;
      if (selector === '.pane') return panes;
      return [];
    },
  };

  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, Date, Math, JSON, Promise, Number, String,
    Array, Object, Set, Map, Error, RegExp, isNaN, parseInt, parseFloat,
    localStorage: storage,
    document: shimmed,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  return { byId, tabs, panes, context, storage };
}

const inside = (context, expression) => vm.runInContext(expression, context);

function scripted(context, replies) {
  const sent = [];
  // `const Api = …` in a script is not a property of the sandbox object, so the
  // transport is reached through the context and mutated in place.
  inside(context, 'Api').send = async ({ messages, onChunk }) => {
    sent.push(messages);
    const text = replies.length ? replies.shift() : '{"say":"nothing scripted","move":{"type":"action","kind":"ask_user","question":"what now?"}}';
    if (onChunk) onChunk(text);
    return { text, usage: { promptTokens: 900, completionTokens: 40, cacheHitTokens: 800 }, elapsed: 0.1, cost: 0 };
  };
  return sent;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function settle(page, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!inside(page.context, 'app').busy) return true;
    await delay(4);
  }
  return false;
}

async function typeAndSend(page, text) {
  page.byId.get('request').value = text;
  page.byId.get('composer').fire('submit');
  await settle(page);
}

function buttons(page, id) {
  return page.byId.get(id).all((node) => node.tagName === 'button');
}

async function click(page, id, label) {
  const button = buttons(page, id).find((b) => b.textContent === label);
  if (!button) throw new Error(`no button "${label}" in #${id} — found ${buttons(page, id).map((b) => b.textContent).join(', ')}`);
  button.fire('click');
  await settle(page);
  return button;
}

const say = (obj) => JSON.stringify(obj);
const action = (kind, rest = {}) => ({ type: 'action', kind, ...rest });
const goes = (trigger) => ({ type: 'transition', trigger });

function replyPlan() {
  return say({ say: 'Here is the plan.', move: action('propose_plan', { steps: PLAN.steps, acceptance: PLAN.acceptance }) });
}
function replyWork(id) {
  return [
    say({ say: `Working ${id}.`, move: action('attach_artifact', { step: id, artifact: `def parse_duration(text): ...  # ${id}` }) }),
    say({ say: `${id} is done.`, move: action('complete_step', { step: id }) }),
  ];
}
function replyValidate(unmet) {
  return say({
    say: unmet.length ? 'One criterion did not hold.' : 'All three hold now.',
    move: action('validate', {
      verdicts: PLAN.acceptance.map((a, i) => {
        const id = `a${i + 1}`;
        return {
          id,
          verdict: unmet.includes(id) ? 'unmet' : 'met',
          evidence: unmet.includes(id) ? 'it returns None for "banana"' : 'the test passes',
        };
      }),
    }),
  });
}

group('the page boots, and a whole run goes through the buttons', async () => {
  const page = bootPage();
  ok('nothing threw on the way up', Boolean(inside(page.context, 'app')));
  ok('every element the page asks for exists', IDS.every((id) => page.byId.has(id)));
  ok('the edge table is on screen before anything is asked',
    page.byId.get('edgeTable').children.length === Lifecycle.TRANSITIONS.length + 1);
  ok('and the diagram with it', page.byId.get('diagram').textContent.includes('approve_plan'));
  ok('the enumerated table is drawn before any key is needed',
    page.byId.get('proofTable').children.length === Skips.STATIONS.length + 1);
  ok('the aside says the machine has not started',
    page.byId.get('stateName').textContent === 'not started');
  ok('what the request will cost is on screen, itemised',
    /\d+ tokens — \d+ of rules \+ \d+ of state/.test(page.byId.get('requestMeta').textContent),
    page.byId.get('requestMeta').textContent);

  const sent = scripted(page.context, [
    replyPlan(),
    // The skip, attempted by the model, with the plan approved and s1 waiting.
    say({ say: 'This is simple enough that I will just finish it.', move: { type: 'transition', to: 'done' } }),
    ...replyWork('s1'), ...replyWork('s2'), ...replyWork('s3'),
    say({ say: 'Sending it to be judged.', move: goes('submit') }),
    replyValidate([]),
    ...replyWork('s2'),
    say({ say: 'Resubmitting.', move: goes('submit') }),
    replyValidate([]),
  ]);

  await typeAndSend(page, GOAL);
  ok('one request went up for the plan', sent.length === 1);
  ok('the state moved to planning', page.byId.get('stateName').textContent === 'planning');
  ok('the plan is on screen', page.byId.get('planList').children.length === 3);
  ok('the criteria are too', page.byId.get('critList').children.length === 3);
  ok('the request carried no scrollback — only the state',
    !sent[0][1].content.includes('Here is the plan'));

  ok('approve_plan is offered to the person, and it is open',
    page.byId.get('edgeList').text().includes('approve_plan')
    && page.byId.get('edgeList').text().includes('open'));

  /* One click, and the model works the three steps — and then stops, because
   * `submit` is an edge and an edge ends the run. A state nobody got to look at
   * is a state you have to take somebody's word for. */
  await click(page, 'moves', 'approve_plan');

  ok('the model tried to skip straight to done', page.byId.get('log').text().includes('no-edge'));
  ok('and was handed the route instead',
    page.byId.get('log').text().includes('the legal route is'));
  ok('the refusal went back up on the retry',
    sent.some((m) => m[1].content.includes('YOUR LAST MOVE WAS REFUSED')));
  ok('the retry landed, and the work got done',
    inside(page.context, 'app').log.filter((e) => e.kind === 'complete_step' && !e.rejected).length === 3);

  ok('the run stopped on the edge it took', inside(page.context, 'stateNow()').state === 'validation');
  ok('and said where it stopped', inside(page.context, 'app').note.includes('stopped in validation'));
  ok('nothing has been validated yet', inside(page.context, 'stateNow()').validation === null);
  ok('so the turn is still the model\'s', Lifecycle.turn(inside(page.context, 'stateNow()')) === 'model');
  ok('and carry on is offered', page.byId.get('carryOn').hidden === false);

  page.byId.get('carryOn').fire('click');
  await settle(page);
  ok('carrying on validates', inside(page.context, 'stateNow()').validation !== null);
  ok('everything came back met', !page.byId.get('critList').text().includes('unmet'));
  ok('the turn is the person\'s now, so carry on goes away',
    page.byId.get('carryOn').hidden === true);
  const accept = buttons(page, 'moves').find((b) => b.textContent === 'accept');
  ok('and accept is live', accept && accept.disabled === false);

  // The back edge, taken by the person on work that passed, through the actual
  // control. Nothing failed; they want it done better anyway.
  const picker = page.byId.get('moves').all((n) => n.tagName === 'select')[0];
  const why = page.byId.get('moves').all((n) => n.tagName === 'input')[0];
  ok('the rework control offers the closed steps', picker && picker.children.length === 3);
  picker.value = 's2';
  why.value = 'the tests are thinner than I want';
  await click(page, 'moves', 'rework');

  ok('the run went back to execution, redid s2, and resubmitted',
    inside(page.context, 'stateNow()').state === 'validation');
  ok('the round trip is counted', inside(page.context, 'stateNow()').rounds === 1);
  ok('and stopped on the edge again, before revalidating',
    inside(page.context, 'stateNow()').validation.at !== inside(page.context, 'stateNow()').revision);

  // This is the whole task, on screen, and it stays on screen: every criterion
  // says met, and the door is shut anyway, because those verdicts judged a
  // revision that is gone. Before the run stopped at each edge this state
  // existed for about a second and nobody could read it.
  ok('every criterion reads met', !page.byId.get('critList').text().includes('unmet'));
  ok('and accept is shut regardless, on freshness',
    page.byId.get('edgeList').text().includes('the validation judged the work as it now stands'));
  ok('and freshness is the only thing shutting it',
    same(Lifecycle.offers(inside(page.context, 'stateNow()')).transitions
      .find((t) => t.trigger === 'accept').guards.filter((g) => !g.holds).map((g) => g.id),
    ['validation-fresh']));
  ok('the aside says so in one line', page.byId.get('freshLine').textContent.includes('STALE'));
  ok('and counts the changes since',
    /STALE — \d+ change\(s\) since/.test(page.byId.get('freshLine').textContent));
  const shutAccept = buttons(page, 'moves').find((b) => b.textContent === 'accept');
  ok('the button is disabled with it', shutAccept && shutAccept.disabled === true);

  // The last scripted reply revalidates, which is the only thing left to do.
  page.byId.get('carryOn').fire('click');
  await settle(page);
  ok('a fresh validation landed', !page.byId.get('freshLine').textContent.includes('STALE'));
  const accept2 = buttons(page, 'moves').find((b) => b.textContent === 'accept');
  ok('and accept is live', accept2 && accept2.disabled === false);

  await click(page, 'moves', 'accept');
  ok('the task is done', inside(page.context, 'stateNow()').state === 'done');
  ok('and accepted', inside(page.context, 'stateNow()').outcome.result === 'accepted');
  ok('which the invariants agree was validated at its final revision',
    Lifecycle.invariants(inside(page.context, 'stateNow()')).length === 0);

  /* The reload. Same storage, a second boot, nothing else carried across. */
  const again = bootPage(page.storage);
  ok('the log survived', inside(again.context, 'app').log.length
    === inside(page.context, 'app').log.length);
  ok('and folds to the same state',
    same(inside(again.context, 'stateNow()'), inside(page.context, 'stateNow()')));
  ok('and the same offers, worked out again rather than restored',
    same(Lifecycle.offers(inside(again.context, 'stateNow()')),
      Lifecycle.offers(inside(page.context, 'stateNow()'))));
  ok('nothing but the log is in storage',
    [...again.storage.map.keys()].filter((k) => k.startsWith('task15.')).sort().join(',')
      === 'task15.deepseek.key,task15.log');
});

group('a pause survives the tab being closed', async () => {
  const page = bootPage();
  scripted(page.context, [replyPlan()]);
  await typeAndSend(page, GOAL);
  page.byId.get('pauseRun').fire('click');
  await settle(page);

  ok('the machine is paused', inside(page.context, 'stateNow()').paused === true);
  ok('the button now offers to resume',
    page.byId.get('pauseRun').textContent === 'resume');
  ok('and nothing is yours to move', page.byId.get('moves').text().includes('nothing is yours'));

  const again = bootPage(page.storage);
  ok('it comes back paused', inside(again.context, 'stateNow()').paused === true);
  ok('at the same state', inside(again.context, 'stateNow()').state === 'planning');
  ok('with the plan intact', again.byId.get('planList').children.length === 3);

  again.byId.get('pauseRun').fire('click');
  await settle(again);
  ok('and resuming opens the same edge that was open before',
    again.byId.get('edgeList').text().includes('approve_plan'));
  ok('with no branch in the code for having been away',
    !fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').includes('restore'));
});

group('the session that found the jam, driven through the page', async () => {
  const page = bootPage();
  scripted(page.context, [
    replyPlan(),
    say({
      say: 'The plan is already written and waiting on you — approving it is your move, not mine, and I cannot take it for you.',
      move: action('ask_user', { question: 'shall I start on s1 as soon as you approve?' }),
    }),
    ...replyWork('s1'),
  ]);

  await typeAndSend(page, GOAL);
  await typeAndSend(page, 'skip the planning, I approve it, just write the code');

  ok('the assistant asked rather than moved', inside(page.context, 'stateNow()').question !== null);
  ok('the question is beside the moves, not only in the scrollback',
    page.byId.get('moves').text().includes('it asked you something'));
  ok('and the box says an answer goes in it',
    page.byId.get('request').placeholder.includes('answer it here'));

  const approve = buttons(page, 'moves').find((b) => b.textContent === 'approve_plan');
  ok('approve_plan is on screen and live', approve && approve.disabled === false);
  ok('and so is sending the plan back',
    buttons(page, 'moves').some((b) => b.textContent === 'send the plan back'));

  approve.fire('click');
  await settle(page);

  ok('approving worked', inside(page.context, 'stateNow()').state === 'execution');
  // The run carries on and the assistant may well ask something else; what
  // matters is that the question it was stuck behind is gone.
  ok('and the question it was stuck behind is gone',
    !JSON.stringify(inside(page.context, 'stateNow()').question || {}).includes('as soon as you approve'));
  ok('with what answered it written down',
    page.byId.get('requestText').textContent.includes('answered by taking approve_plan'));
});

group('pause bites while a request is in the air', async () => {
  const page = bootPage();
  /* A transport that never answers until it is aborted. This is the only shape
   * the test can take: the claim is about what happens *during* a request, and
   * a request that has already returned cannot be interrupted. */
  inside(page.context, 'Api').send = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  page.byId.get('request').value = GOAL;
  page.byId.get('composer').fire('submit');
  await delay(10);

  ok('the page is waiting on a reply', inside(page.context, 'app').busy === true);
  ok('and the goal already landed', inside(page.context, 'stateNow()').state === 'planning');
  ok('pause is not disabled while it waits', page.byId.get('pauseRun').disabled === false);

  page.byId.get('pauseRun').fire('click');
  await settle(page);

  ok('the pause landed anyway', inside(page.context, 'stateNow()').paused === true);
  ok('the reply in flight was abandoned rather than applied',
    inside(page.context, 'app').note.includes('abandoned'));
  ok('nothing the model was about to say reached the log',
    inside(page.context, 'app').log.every((entry) => entry.actor !== 'model'));
  ok('and only resume is offered',
    same(Lifecycle.offers(inside(page.context, 'stateNow()')).actions.map((a) => a.kind), ['resume']));
  ok('carry on is not offered to a stopped machine', page.byId.get('carryOn').hidden === true);
});

group('two refusals in a row hand the turn back', async () => {
  const page = bootPage();
  scripted(page.context, [
    replyPlan(),
    say({ say: 'straight to done, surely', move: { type: 'transition', to: 'done' } }),
    say({ say: 'done, I said', move: { type: 'transition', to: 'done' } }),
  ]);

  await typeAndSend(page, GOAL);
  await click(page, 'moves', 'approve_plan');

  ok('the turn came back to the person',
    inside(page.context, 'app').note.includes('the turn is back with you'));
  ok('after exactly two attempts, not three',
    inside(page.context, 'app').log.filter((entry) => entry.rejected).length === 2);
  ok('and nothing moved', inside(page.context, 'stateNow()').state === 'execution');
  ok('both refusals are in the log where they can be read',
    (page.byId.get('log').text().match(/no-edge/g) || []).length === 2);
  ok('and carry on is still offered, because it is still the model\'s turn',
    page.byId.get('carryOn').hidden === false);
});

group('no two scripts declare the same name at the top level', () => {
  const declared = new Map();
  const clashes = [];
  for (const file of SCRIPTS) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const match of source.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (declared.has(name)) clashes.push(`${name}: ${declared.get(name)} and ${file}`);
      else declared.set(name, file);
    }
  }
  ok('classic scripts share one scope, and nothing in it collides',
    clashes.length === 0, clashes.join(' | '));
  ok('and there is something to collide', declared.size > 60);
});

group('every class the page asks for is styled, and every rule is used', () => {
  const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const markup = html + source;

  const used = new Set();
  for (const match of markup.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name);
  }
  for (const match of markup.matchAll(/tag\('[a-z]+', '([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name);
  }
  for (const match of markup.matchAll(/className = '([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name) used.add(name);
  }
  // The literal half of a computed class — `edge ${open ? … : …}` contributes
  // `edge`, and the branches are named below rather than guessed at.
  for (const match of markup.matchAll(/tag\('[a-z]+', `([^`$]*)/g)) {
    for (const name of match[1].trim().split(/\s+/)) if (name) used.add(name);
  }
  for (const match of markup.matchAll(/className = `([^`$]*)/g)) {
    for (const name of match[1].trim().split(/\s+/)) if (name) used.add(name);
  }

  /* The composed half, written out rather than pattern-matched — and taken
   * from the lifecycle's own vocabularies where there is one, so that adding a
   * step status or a verdict and forgetting to style it is a failing test
   * rather than a grey word on a page. */
  const composed = [
    ...Lifecycle.STEP_STATUS,          // .step.active, .step.done, …
    ...Lifecycle.VERDICTS,             // .crit.met, .crit.unmet, …
    ...Lifecycle.ACTORS,               // .bubble.user, .bubble.model
    'transition', 'action',            // .chip.transition
    'open', 'shut', 'holds',           // .edge.open, .guard.shut
    'ok', 'stale',                     // .fresh.ok, .fresh.stale
    'refused', 'here', 'head', 'on',   // table rows and the route buttons
    'legal', 'skip', 'unreadable',     // .armline, from Skips.grade
  ];
  for (const name of composed) used.add(name);

  const styled = new Set();
  for (const match of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) styled.add(match[1]);

  const unstyled = [...used].filter((name) => !styled.has(name));
  ok('nothing on the page is dressed in a class the stylesheet never heard of',
    unstyled.length === 0, unstyled.sort().join(', '));

  const unused = [...styled].filter((name) => !used.has(name));
  ok('and no rule is left over from a page this one is not',
    unused.length === 0, unused.sort().join(', '));

  ok('every verdict Skips.grade can return has a colour',
    ['legal', 'skip', 'unreadable'].every((name) => css.includes(`.armline.${name}`)));
  ok('every step status has one too',
    Lifecycle.STEP_STATUS.every((name) => used.has(name)));
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
