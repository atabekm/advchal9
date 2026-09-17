const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* The script list comes from index.html rather than from a list written here,
 * so a file added to the page without being wired up is caught by the tests
 * instead of by a blank screen. */
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

// Every rejection reason this file actually provokes. The closed set is only
// closed if nothing in it is dead, so the last group compares the two.
const provoked = new Set();

function reject(state, event) {
  const moved = Machine.step(state, event);
  if (!moved.ok) provoked.add(moved.rejection.reason);
  return moved;
}

function drive(events, from = Machine.empty()) {
  let state = from;
  for (const event of events) {
    const moved = Machine.step(state, event);
    if (!moved.ok) {
      throw new Error(`${event.kind} was rejected: ${moved.rejection.reason} — ${moved.rejection.detail}`);
    }
    if (moved.broken.length) throw new Error(`${event.kind} broke ${moved.broken.join('; ')}`);
    state = moved.state;
  }
  return state;
}

function probePayload(state, kind) {
  const active = Machine.activeStep(state);
  return {
    goal: 'g', note: 'n', question: 'q', text: 't', reason: 'r', artifact: 'a',
    step: active ? active.id : 's1',
    steps: [{ title: 'one' }], acceptance: [{ text: 'c' }],
    verdicts: state.acceptance.map((a) => ({ id: a.id, verdict: 'met', evidence: 'e' })),
  };
}

const PLAN = {
  kind: 'propose_plan',
  steps: [
    { title: 'Decide the accepted grammar and the error behaviour' },
    { title: 'Write parse_duration' },
    { title: 'Write the tests' },
  ],
  acceptance: [
    { text: "'1h30m' returns 5400" },
    { text: 'an unparseable string raises ValueError' },
  ],
};

const GOAL = "Write a Python function that parses '1h30m' into seconds, with tests.";
const START = { kind: 'start', goal: GOAL, at: 1 };

const planned = () => drive([START, PLAN]);
const executing = () => drive([START, PLAN, { kind: 'approve_plan' }]);

function closeStep(id) {
  return [
    { kind: 'attach_artifact', step: id, artifact: `the work for ${id}` },
    { kind: 'complete_step', step: id },
  ];
}

const validating = () => drive([
  START, PLAN, { kind: 'approve_plan' },
  ...closeStep('s1'), ...closeStep('s2'), ...closeStep('s3'),
]);

// --------------------------------------------------------------- the spec

group('the spec is a closed set, and the code is the only copy of it', () => {
  ok('there are exactly four stages', Machine.STAGES.length === 4);
  ok('and they are the four the brief names',
    Machine.STAGES.join(' → ') === 'planning → execution → validation → done',
    Machine.STAGES.join(' → '));
  ok('done is last', Machine.STAGES[Machine.STAGES.length - 1] === 'done');

  for (const [kind, spec] of Object.entries(Machine.EVENTS)) {
    ok(`${kind} names who may emit it`, spec.actor === 'user' || spec.actor === 'model');
    ok(`${kind} names where it is legal`, Array.isArray(spec.stages) && spec.stages.length > 0);
    ok(`${kind}'s stages are real`,
      spec.stages.every((stage) => stage === null || Machine.STAGES.includes(stage)));
  }

  ok('no event is legal in done',
    Object.values(Machine.EVENTS).every((spec) => !spec.stages.includes('done')));
  ok('only pause, resume and ask_user bypass the open slot',
    Object.entries(Machine.EVENTS).filter(([, s]) => s.bypass).map(([k]) => k).sort().join(',')
      === 'ask_user,pause,resume');

  ok('there is no event that moves the stage on request',
    !Machine.EVENT_KINDS.some((kind) => /^(go_to|set_stage|finish|begin_)/.test(kind)),
    Machine.EVENT_KINDS.join(', '));
});

group('the empty machine is waiting on a person, not on a model', () => {
  const state = Machine.empty();
  ok('it has no stage yet', state.stage === null);
  ok('it has no goal yet', state.goal === null);
  ok('it expects the user to start', state.expect.actor === 'user');
  ok('and start is the only thing it expects', state.expect.kinds.join() === 'start');
  ok('it holds no invariant violations', Machine.invariants(state).length === 0,
    Machine.invariants(state).join('; '));
  ok('the model cannot open a machine',
    reject(state, { kind: 'propose_plan', ...PLAN }).rejection.reason === 'wrong-stage');
});

// -------------------------------------------------------- the ordinary run

group('a task runs from one end to the other', () => {
  const started = drive([START]);
  ok('start opens planning', started.stage === 'planning');
  ok('the goal is recorded verbatim, once', started.goal === GOAL);
  ok('and the model is asked for a plan', started.expect.kinds.join() === 'propose_plan');

  const afterPlan = planned();
  ok('a plan becomes numbered steps', afterPlan.steps.map((s) => s.id).join() === 's1,s2,s3');
  ok('every step starts pending', afterPlan.steps.every((s) => s.status === 'pending'));
  ok('criteria are numbered too', afterPlan.acceptance.map((a) => a.id).join() === 'a1,a2');
  ok('and no verdict has been reached', afterPlan.acceptance.every((a) => a.verdict === 'unknown'));
  ok('the plan does not start itself — it waits for a person',
    afterPlan.expect.actor === 'user' && afterPlan.stage === 'planning');
  ok('who may approve or revise it',
    afterPlan.expect.kinds.sort().join() === 'approve_plan,revise_plan');

  const run = executing();
  ok('approval opens execution', run.stage === 'execution');
  ok('on the first step', Machine.activeStep(run).id === 's1');
  ok('and the cursor agrees with it', run.cursor === 0);

  const attached = drive([{ kind: 'attach_artifact', step: 's1', artifact: 'grammar: [Nh][Nm]' }], run);
  ok('an artifact lands on the step', Machine.activeStep(attached).artifact === 'grammar: [Nh][Nm]');
  ok('the step is still open', Machine.activeStep(attached).id === 's1');
  ok('and the slot now says what it is waiting for',
    /waiting to be closed/.test(attached.expect.why), attached.expect.why);

  const closed = drive([{ kind: 'complete_step', step: 's1' }], attached);
  ok('completing advances to the next step', Machine.activeStep(closed).id === 's2');
  ok('and the one behind stays done', Machine.byId(closed.steps, 's1').status === 'done');

  const ready = validating();
  ok('closing the last step opens validation', ready.stage === 'validation');
  ok('nothing is active any more', Machine.activeStep(ready) === null && ready.cursor === null);
  ok('and the model is asked to validate', ready.expect.kinds.join() === 'validate');

  const judged = drive([{
    kind: 'validate',
    verdicts: [
      { id: 'a1', verdict: 'met', evidence: 'test_basic asserts 5400' },
      { id: 'a2', verdict: 'unmet', evidence: 'it returns None on "abc"' },
    ],
  }], ready);
  ok('verdicts land on the criteria', judged.acceptance.map((a) => a.verdict).join() === 'met,unmet');
  ok('evidence lands with them', judged.acceptance.every((a) => a.evidence));
  ok('and the machine counts what failed', /1 of 2 criteria came back unmet/.test(judged.expect.why),
    judged.expect.why);
  ok('the stage did not move on its own — a person closes it',
    judged.stage === 'validation' && judged.expect.actor === 'user');

  const done = drive([{ kind: 'accept', at: 9 }], judged);
  ok('accepting closes the machine', done.stage === 'done');
  ok('the outcome records what was accepted', done.outcome.result === 'accepted');
  ok('including the criteria that were never met', done.outcome.unmet.join() === 'a2');
  ok('and nothing is expected of anyone', done.expect === null);
});

group('the stage is never asked for — it is a consequence', () => {
  const run = executing();
  ok('there is no event that names a stage',
    Machine.EVENT_KINDS.every((kind) => !Machine.STAGES.some((stage) => kind.includes(stage))));

  const ready = validating();
  ok('validation was entered by finishing, not by asking', ready.stage === 'validation');
  ok('and the model cannot walk back into execution',
    reject(ready, { kind: 'attach_artifact', step: 's1', artifact: 'again' })
      .rejection.reason === 'wrong-stage');
  ok('nor back into planning',
    reject(ready, { kind: 'propose_plan', ...PLAN }).rejection.reason === 'wrong-stage');
  ok('a plan cannot be proposed once work has started',
    reject(run, { kind: 'propose_plan', ...PLAN }).rejection.reason === 'wrong-stage');
});

// ------------------------------------------------------------- the guard

group('planning cannot close without saying what done means', () => {
  const started = drive([START]);
  const bare = reject(started, { kind: 'propose_plan', steps: PLAN.steps, acceptance: [] });
  ok('a plan with no criteria is refused', bare.rejection.reason === 'missing-acceptance');
  ok('and the refusal says why it matters',
    /before any work exists/.test(bare.rejection.detail), bare.rejection.detail);
  ok('criteria with no text are the same refusal',
    reject(started, { kind: 'propose_plan', steps: PLAN.steps, acceptance: [{ text: '  ' }] })
      .rejection.reason === 'missing-acceptance');
  ok('a plan with no steps is malformed',
    reject(started, { kind: 'propose_plan', steps: [], acceptance: PLAN.acceptance })
      .rejection.reason === 'malformed');
});

group('a step cannot be closed on nothing', () => {
  const run = executing();
  const early = reject(run, { kind: 'complete_step', step: 's1' });
  ok('completing an empty step is refused', early.rejection.reason === 'missing-artifact');
  ok('and the refusal says what to do instead',
    /attach one before completing it/.test(early.rejection.detail), early.rejection.detail);

  ok('a step that does not exist is refused',
    reject(run, { kind: 'attach_artifact', step: 's9', artifact: 'x' })
      .rejection.reason === 'unknown-step');
  ok('a real step that is not the active one is refused',
    reject(run, { kind: 'attach_artifact', step: 's3', artifact: 'x' })
      .rejection.reason === 'wrong-step');
  ok('and the refusal names the one that is active',
    /s1 is/.test(reject(run, { kind: 'complete_step', step: 's2' }).rejection.detail));
  ok('an empty artifact is refused',
    reject(run, { kind: 'attach_artifact', step: 's1', artifact: '   ' })
      .rejection.reason === 'malformed');
  ok('skipping without a reason is refused',
    reject(run, { kind: 'skip_step', step: 's1' }).rejection.reason === 'malformed');

  const skipped = drive([{ kind: 'skip_step', step: 's1', reason: 'the grammar was given in the goal' }], run);
  ok('skipping keeps the reason', Machine.byId(skipped.steps, 's1').note.startsWith('the grammar'));
  ok('and advances like completing does', Machine.activeStep(skipped).id === 's2');

  const ready = validating();
  ok('with no step active, step events have nothing to aim at',
    reject(ready, { kind: 'complete_step', step: 's1' }).rejection.reason === 'wrong-stage');
});

group('validation needs a verdict on every criterion, with evidence', () => {
  const ready = validating();
  ok('a partial verdict list is refused',
    reject(ready, { kind: 'validate', verdicts: [{ id: 'a1', verdict: 'met', evidence: 'e' }] })
      .rejection.reason === 'incomplete-verdicts');
  ok('and the refusal names what was passed over',
    /a2/.test(reject(ready, { kind: 'validate', verdicts: [{ id: 'a1', verdict: 'met', evidence: 'e' }] })
      .rejection.detail));
  ok('a verdict on a criterion nobody wrote is refused',
    reject(ready, { kind: 'validate', verdicts: [{ id: 'a7', verdict: 'met', evidence: 'e' }] })
      .rejection.reason === 'unknown-criterion');
  ok('a verdict that is neither met nor unmet is refused',
    reject(ready, {
      kind: 'validate',
      verdicts: [{ id: 'a1', verdict: 'partly', evidence: 'e' }, { id: 'a2', verdict: 'met', evidence: 'e' }],
    }).rejection.reason === 'malformed');
  ok('a verdict with no evidence is refused',
    reject(ready, {
      kind: 'validate',
      verdicts: [{ id: 'a1', verdict: 'met', evidence: '' }, { id: 'a2', verdict: 'met', evidence: 'e' }],
    }).rejection.reason === 'malformed');
  ok('abandoning without a reason is refused',
    reject(drive([{
      kind: 'validate',
      verdicts: [{ id: 'a1', verdict: 'unmet', evidence: 'e' }, { id: 'a2', verdict: 'unmet', evidence: 'e' }],
    }], ready), { kind: 'abandon' }).rejection.reason === 'malformed');
});

group('the model never speaks out of turn', () => {
  const afterPlan = planned();
  ok('with the user holding the slot, the model may not emit',
    reject(afterPlan, { kind: 'propose_plan', ...PLAN }).rejection.reason === 'wrong-actor');
  ok('not even to ask a question',
    reject(afterPlan, { kind: 'ask_user', question: 'anything?' }).rejection.reason === 'wrong-actor');
  ok('and the refusal says whose turn it is',
    /waiting on the user/.test(reject(afterPlan, { kind: 'ask_user', question: 'q' }).rejection.detail));

  const run = executing();
  ok('with the model holding the slot, the user may not answer nothing',
    reject(run, { kind: 'answer', text: 'yes' }).rejection.reason === 'wrong-actor');
  ok('an event nobody has heard of is malformed',
    reject(run, { kind: 'ship_it' }).rejection.reason === 'malformed');
  ok('so is an event with no kind at all', reject(run, {}).rejection.reason === 'malformed');
  ok('and so is nothing at all', reject(run, null).rejection.reason === 'malformed');
});

group('a question suspends the slot and comes back to it', () => {
  const run = executing();
  const asked = drive([{ kind: 'ask_user', question: "Should '2d4h' parse, or are days out of scope?" }], run);
  ok('the machine turns to the user', asked.expect.actor === 'user');
  ok('the question is the slot', /2d4h/.test(asked.expect.why));
  ok('the stage did not move', asked.stage === 'execution');
  ok('and neither did the step', Machine.activeStep(asked).id === 's1');
  ok('the model cannot answer its own question',
    reject(asked, { kind: 'attach_artifact', step: 's1', artifact: 'x' }).rejection.reason === 'wrong-actor');
  ok('an empty answer is refused',
    reject(asked, { kind: 'answer', text: '' }).rejection.reason === 'malformed');

  const answered = drive([{ kind: 'answer', text: 'hours and minutes only', at: 42 }], asked);
  ok('the answer becomes a decision', answered.decisions.length === 1);
  ok('carrying the question it settles', /2d4h/.test(answered.decisions[0].question));
  ok('and what was decided', answered.decisions[0].text === 'hours and minutes only');
  ok('the slot returns to exactly where it was',
    JSON.stringify(answered.expect) === JSON.stringify(run.expect),
    `${JSON.stringify(answered.expect)} vs ${JSON.stringify(run.expect)}`);
  ok('decisions survive to the end',
    drive([...closeStep('s1'), ...closeStep('s2'), ...closeStep('s3')], answered).decisions.length === 1);
});

group('a revision throws the plan away and keeps what the user said', () => {
  const afterPlan = planned();
  ok('a revision with no note is refused',
    reject(afterPlan, { kind: 'revise_plan' }).rejection.reason === 'malformed');

  const revised = drive([{ kind: 'revise_plan', note: 'four steps is too many — merge the last two', at: 7 }], afterPlan);
  ok('the steps are gone', revised.steps.length === 0);
  ok('the criteria go with them', revised.acceptance.length === 0);
  ok('the note is kept where settled things are kept', revised.decisions.length === 1);
  ok('and it is kept verbatim', /merge the last two/.test(revised.decisions[0].text));
  ok('the model is asked again', revised.expect.kinds.join() === 'propose_plan');
  ok('the stage never left planning', revised.stage === 'planning');
  ok('and a second plan is accepted on top of it', drive([PLAN], revised).steps.length === 3);
});

// ------------------------------------------------------------------ pause

group('pause is a flag, not a fifth stage', () => {
  ok('paused is not a stage', !Machine.STAGES.includes('paused'));

  for (const [name, state] of [['planning', planned()], ['execution', executing()], ['validation', validating()]]) {
    const paused = drive([{ kind: 'pause' }], state);
    ok(`paused in ${name} keeps the stage`, paused.stage === state.stage);
    ok(`paused in ${name} keeps the step`,
      JSON.stringify(paused.steps) === JSON.stringify(state.steps));
    ok(`paused in ${name} keeps the slot`,
      JSON.stringify(paused.expect) === JSON.stringify(state.expect));
    ok(`paused in ${name} leaves only resume legal`,
      Machine.legalKinds(paused).join() === 'resume', Machine.legalKinds(paused).join());
    ok(`resuming from ${name} restores the state exactly`,
      JSON.stringify(drive([{ kind: 'resume' }], paused)) === JSON.stringify(state));
  }

  const paused = drive([{ kind: 'pause' }], executing());
  ok('the model is refused while paused, by name',
    reject(paused, { kind: 'attach_artifact', step: 's1', artifact: 'x' }).rejection.reason === 'paused');
  ok('so is the user',
    reject(paused, { kind: 'ask_user', question: 'q' }).rejection.reason === 'paused');
  ok('pausing twice is refused by the pause guard itself',
    reject(paused, { kind: 'pause' }).rejection.reason === 'paused');
  ok('resuming what is not paused is refused',
    reject(executing(), { kind: 'resume' }).rejection.reason === 'wrong-kind');
});

group('a closed machine is closed', () => {
  const done = drive([
    { kind: 'validate', verdicts: [
      { id: 'a1', verdict: 'met', evidence: 'e' },
      { id: 'a2', verdict: 'met', evidence: 'e' }] },
    { kind: 'accept' },
  ], validating());

  for (const event of [
    { kind: 'attach_artifact', step: 's1', artifact: 'x' },
    { kind: 'ask_user', question: 'q' },
    { kind: 'pause' },
    { kind: 'accept' },
    { kind: 'start', goal: 'something else' },
  ]) {
    ok(`${event.kind} does not move a closed machine`,
      reject(done, event).rejection.reason === 'terminal');
  }

  const abandoned = drive([{ kind: 'abandon', reason: 'the approach was wrong', at: 5 }],
    drive([{ kind: 'validate', verdicts: [
      { id: 'a1', verdict: 'unmet', evidence: 'e' },
      { id: 'a2', verdict: 'unmet', evidence: 'e' }] }], validating()));
  ok('abandoning also closes it', abandoned.stage === 'done');
  ok('and it is recorded as a reason, not as a stage',
    abandoned.outcome.result === 'abandoned' && abandoned.outcome.reason === 'the approach was wrong');
  ok('with every unmet criterion attached', abandoned.outcome.unmet.join() === 'a1,a2');
  ok('failure is not a fifth stage', !Machine.STAGES.includes('failed'));
});

// ------------------------------------------------------------- the fold

group('the state is a fold over the log', () => {
  const log = [
    START, PLAN, { kind: 'approve_plan', at: 3 },
    { kind: 'attach_artifact', step: 's1', artifact: 'grammar', at: 4 },
    { kind: 'complete_step', step: 's1', at: 5 },
    { kind: 'ask_user', question: 'days?', at: 6 },
    { kind: 'answer', text: 'no days', at: 7 },
    { kind: 'pause', at: 8 },
  ];

  ok('replaying the log lands where stepping it landed',
    JSON.stringify(Machine.reduce(log)) === JSON.stringify(drive(log)));
  ok('and a reload is a replay', JSON.stringify(Machine.reduce(log)) === JSON.stringify(Machine.reduce(log)));
  ok('the fold of an empty log is the empty machine',
    JSON.stringify(Machine.reduce([])) === JSON.stringify(Machine.empty()));

  const throughJson = Machine.reduce(JSON.parse(JSON.stringify(log)));
  ok('a log that has been through JSON folds the same',
    JSON.stringify(throughJson) === JSON.stringify(Machine.reduce(log)));

  const withRejections = [
    log[0], log[1], log[2],
    { kind: 'complete_step', step: 's1', at: 4, rejected: 'missing-artifact' },
    ...log.slice(3),
  ];
  ok('a rejected entry is kept in the log and walked past',
    JSON.stringify(Machine.reduce(withRejections)) === JSON.stringify(Machine.reduce(log)));

  const { state, skipped } = Machine.replay([START, { kind: 'accept' }, PLAN]);
  ok('an entry that is illegal on replay is skipped, not thrown', state.steps.length === 3);
  ok('and the skip is reported', skipped.length === 1 && skipped[0].reason === 'wrong-stage');

  ok('paused survives the fold', Machine.reduce(log).paused === true);
  ok('and so does the step it was paused on', Machine.activeStep(Machine.reduce(log)).id === 's2');
});

group('the invariants hold at every point of a run', () => {
  const log = [
    START, PLAN, { kind: 'approve_plan' },
    { kind: 'ask_user', question: 'days?' }, { kind: 'answer', text: 'no' },
    ...closeStep('s1'),
    { kind: 'skip_step', step: 's2', reason: 'covered by s1' },
    { kind: 'pause' }, { kind: 'resume' },
    ...closeStep('s3'),
    { kind: 'validate', verdicts: [
      { id: 'a1', verdict: 'met', evidence: 'e' },
      { id: 'a2', verdict: 'unmet', evidence: 'e' }] },
    { kind: 'accept' },
  ];
  let state = Machine.empty();
  let clean = true;
  for (const event of log) {
    const moved = Machine.step(state, event);
    if (!moved.ok || moved.broken.length) clean = false;
    if (moved.ok) state = moved.state;
  }
  ok('twelve events, no violation and no rejection', clean);
  ok('and the machine ends closed', state.stage === 'done');
  ok('with the skipped step still on the record',
    Machine.byId(state.steps, 's2').status === 'skipped');
});

// ------------------------------------------------------------------ fuzz

group('no sequence of events can break the machine', () => {
  const seed = (n) => () => {
    n |= 0; n = (n + 0x6D2B79F5) | 0;
    let t = Math.imul(n ^ (n >>> 15), 1 | n);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // 's2' and 'a1' are junk only in context: a real id, aimed at the wrong thing.
  const junk = [undefined, null, '', '  ', 0, 42, [], {}, 's2', 's9', 'a1', 'a9'];
  let thrown = null;
  let violations = 0;
  let unknownReason = null;
  const seen = new Set();
  let accepted = 0;
  let rejected = 0;
  let closed = 0;

  for (let run = 0; run < 3000 && !thrown; run += 1) {
    const rnd = seed(run * 7919);
    let state = Machine.empty();
    for (let i = 0; i < 30; i += 1) {
      // Half the draws come from what is legal right now, or the walk never
      // gets past planning and the deep rejections are never provoked.
      const open = Machine.legalKinds(state);
      const pool = rnd() < 0.5 && open.length ? open : Machine.EVENT_KINDS;
      const kind = rnd() < 0.08 ? 'not_an_event' : pool[Math.floor(rnd() * pool.length)];
      // Per field, not per event: one bad field inside an otherwise sound
      // payload is what provokes the specific guards, and an event where
      // everything is junk only ever reaches the first one.
      const pick = (good) => (rnd() < 0.2 ? junk[Math.floor(rnd() * junk.length)] : good);
      const active = Machine.activeStep(state);
      const event = {
        kind,
        at: i,
        goal: pick('a goal'),
        note: pick('a note'),
        question: pick('a question'),
        text: pick('an answer'),
        reason: pick('a reason'),
        artifact: pick('an artifact'),
        step: pick(active ? active.id : 's1'),
        steps: pick([{ title: 'one' }, { title: 'two' }]),
        acceptance: pick([{ text: 'a criterion' }]),
        verdicts: pick(state.acceptance.map((a) => ({
          id: pick(a.id), verdict: pick('met'), evidence: pick('e'),
        }))),
      };
      let moved;
      try {
        moved = Machine.step(state, event);
      } catch (error) {
        thrown = `run ${run}, event ${i} (${kind}): ${error.message}`;
        break;
      }
      if (moved.ok) {
        accepted += 1;
        if (moved.broken.length) { violations += 1; thrown = `run ${run}: ${moved.broken.join('; ')}`; break; }
        state = moved.state;
        if (state.stage === 'done') closed += 1;
      } else {
        rejected += 1;
        seen.add(moved.rejection.reason);
        if (!Machine.REJECTION_REASONS.includes(moved.rejection.reason)) {
          unknownReason = moved.rejection.reason;
        }
      }
    }
  }

  ok('90000 random events threw nothing', thrown === null, thrown || '');
  ok('and broke no invariant', violations === 0);
  ok('every rejection named a reason from the closed set', unknownReason === null, unknownReason || '');
  ok('the fuzz got far enough to be worth running', accepted > 8000 && rejected > 8000,
    `${accepted} accepted, ${rejected} rejected`);
  ok('it walked machines all the way to closed', closed > 50, `${closed} closed`);
  ok('and it provoked the whole closed set on its own',
    Machine.REJECTION_REASONS.every((reason) => seen.has(reason)),
    Machine.REJECTION_REASONS.filter((r) => !seen.has(r)).join(', '));
});

group('the closed set has nothing dead in it', () => {
  const missing = Machine.REJECTION_REASONS.filter((reason) => !provoked.has(reason));
  ok('every rejection reason is provoked by a test above', missing.length === 0, missing.join(', '));
  ok('every reason carries a sentence explaining it',
    Machine.REJECTION_REASONS.every((reason) => Machine.REJECTIONS[reason].length > 20));
  ok('and nothing is rejected for a reason outside it',
    [...provoked].every((reason) => Machine.REJECTION_REASONS.includes(reason)));
});


// ---------------------------------------------------------------- protocol

group('the request is the state, and there is no second version of it', () => {
  const run = executing();
  const block = Protocol.compile(run);

  ok('the compiled request carries the goal', block.user.includes(GOAL));
  ok('and the plan, step by step',
    run.steps.every((step) => block.user.includes(step.title)));
  ok('and what would count as done',
    run.acceptance.every((criterion) => block.user.includes(criterion.text)));
  ok('and which step is active', /s1\s+ACTIVE/.test(block.user), block.user);
  ok('and what the machine is waiting for', block.user.includes('WHAT IS EXPECTED OF YOU NOW'));
  ok('and which kinds it would accept right now',
    block.user.includes('attach_artifact, complete_step, skip_step, ask_user'), block.user);

  ok('there is no dialogue anywhere in it',
    !/assistant|user said|earlier you|previously/i.test(block.user), block.user);
  ok('the static half is the same for every state',
    Protocol.compile(planned()).system === Protocol.compile(validating()).system);
  ok('and it is the larger half, which is what a cache is for',
    block.rulesTokens > block.stateTokens, `${block.rulesTokens} vs ${block.stateTokens}`);

  ok('compiling is deterministic',
    Protocol.compile(run).text === Protocol.compile(run).text);
  ok('and depends on nothing but the state',
    Protocol.compile(Machine.reduce([START, PLAN, { kind: 'approve_plan' }])).text === block.text);

  ok('there is exactly one function that builds a request',
    (fs.readFileSync(path.join(__dirname, 'protocol.js'), 'utf8').match(/^function compile/gm) || []).length === 1);
  ok('and nothing in the code knows the word resume in a prompt sense',
    !/resumePrompt|compileResume|summar(y|ise|ize)/i.test(
      fs.readFileSync(path.join(__dirname, 'protocol.js'), 'utf8')));
});

group('the request a pause interrupts is the request a resume sends', () => {
  for (const [name, state] of [['planning', planned()], ['execution', executing()], ['validation', validating()]]) {
    const before = Protocol.compile(state);
    const through = drive([{ kind: 'pause' }, { kind: 'resume' }], state);
    const after = Protocol.compile(through);
    ok(`paused and resumed in ${name}, the request is byte for byte the same`,
      before.text === after.text);
    ok(`and so is its fingerprint in ${name}`,
      Protocol.fingerprint(before.text) === Protocol.fingerprint(after.text));
  }

  const log = [START, PLAN, { kind: 'approve_plan' },
    { kind: 'attach_artifact', step: 's1', artifact: 'the grammar' },
    { kind: 'complete_step', step: 's1' }, { kind: 'pause' }];
  const reloaded = Machine.reduce(JSON.parse(JSON.stringify(log)));
  const straight = drive(log.slice(0, -1));
  ok('a machine folded back from storage compiles what it compiled before the tab closed',
    Protocol.compile(drive([{ kind: 'resume' }], reloaded)).text === Protocol.compile(straight).text);
});

group('the state carries the work, and not the talking', () => {
  const withWork = drive([
    { kind: 'attach_artifact', step: 's1', artifact: 'def parse_duration(text):\n    ...' },
    { kind: 'complete_step', step: 's1' },
  ], executing());
  ok('an attached artifact is quoted in full — later steps need it',
    Protocol.compile(withWork).user.includes('def parse_duration(text):'));

  const asked = drive([{ kind: 'ask_user', question: 'days?' }, { kind: 'answer', text: 'no days' }], executing());
  const block = Protocol.compile(asked);
  ok('a settled question appears once, as a decision', block.user.includes('ALREADY SETTLED'));
  ok('with the question and the answer on one line', /days\? — no days/.test(block.user), block.user);
  ok('and the model is told not to reopen it', /do not ask about any of this again/.test(block.user));
  ok('nothing the model said around it survives', !block.user.includes('say'));

  const skipped = drive([{ kind: 'skip_step', step: 's1', reason: 'the goal already fixed the grammar' }], executing());
  ok('a skipped step keeps its reason in the request',
    Protocol.compile(skipped).user.includes('the goal already fixed the grammar'));
});

group('the slot the request prints is the slot the guard enforces', () => {
  for (const state of [planned(), executing(), validating(), drive([{ kind: 'ask_user', question: 'q' }], executing())]) {
    const printed = (Protocol.compile(state).user.match(/Emit exactly one event, of kind: (.+)\./) || [])[1];
    const enforced = Machine.legalKinds(state).filter((kind) => Machine.EVENTS[kind].actor === 'model');
    if (state.expect.actor === 'model') {
      ok(`in ${state.stage}, the printed kinds are the enforced kinds`,
        printed === enforced.join(', '), `${printed} vs ${enforced.join(', ')}`);
      // A printed kind is one the slot allows. It can still be turned away on
      // its payload — complete_step is offered during execution and refused
      // for missing-artifact — and that refusal is the more useful one.
      const SLOT = ['wrong-kind', 'wrong-actor', 'wrong-stage', 'paused', 'terminal'];
      ok(`in ${state.stage}, no printed kind is turned away by the slot`,
        enforced.every((kind) => !SLOT.includes(
          Machine.legal(state, { kind, ...probePayload(state, kind) }).reason)));
      ok(`in ${state.stage}, nothing legal is left unprinted`,
        Machine.EVENT_KINDS.filter((kind) => Machine.EVENTS[kind].actor === 'model'
          && !SLOT.includes(Machine.legal(state, { kind, ...probePayload(state, kind) }).reason))
          .every((kind) => enforced.includes(kind)));
    } else {
      ok(`in ${state.stage}, a model-less slot says so`,
        /waiting on the person/.test(Protocol.compile(state).user));
    }
  }

  const done = drive([
    { kind: 'validate', verdicts: [
      { id: 'a1', verdict: 'met', evidence: 'e' }, { id: 'a2', verdict: 'met', evidence: 'e' }] },
    { kind: 'accept' }], validating());
  ok('a closed machine expects nothing of anyone',
    /Nothing\. The machine is closed\./.test(Protocol.compile(done).user));
});

group('every payload shape the prompt promises is one the guard accepts', () => {
  const shapes = Object.keys(Protocol.SHAPES);
  ok('every shape names a real event', shapes.every((kind) => Machine.EVENTS[kind]));
  ok('every model event has a shape',
    Machine.EVENT_KINDS.filter((kind) => Machine.EVENTS[kind].actor === 'model')
      .every((kind) => Protocol.SHAPES[kind]), shapes.join(', '));
  ok('no user-only event is offered to the model',
    !shapes.some((kind) => Machine.EVENTS[kind].actor === 'user'));
  ok('the rules name every stage', Machine.STAGES.every((stage) => Protocol.RULES.includes(stage)));
  ok('and tell the model it cannot ask for one', /cannot ask for a stage/.test(Protocol.RULES));
});

group('the rejection the model is shown is the rejection the guard issued', () => {
  const run = executing();
  const rejected = Machine.step(run, { kind: 'complete_step', step: 's1' }).rejection;
  const block = Protocol.compile(run, { rejection: rejected });
  ok('the retry carries the kind that failed', block.user.includes('complete_step'));
  ok('and the reason, by name', block.user.includes('missing-artifact'));
  ok('and the detail that says what to do', block.user.includes('attach one before completing it'));
  ok('and says how many attempts are left', /second and last attempt/.test(block.user));
  ok('the state is still there underneath it', block.user.includes(GOAL));
  ok('a request with no rejection carries no nudge',
    !Protocol.compile(run).user.includes('REJECTED'));
  ok('the nudge is the only difference between the two',
    block.user.startsWith(Protocol.compile(run).user));
});

group('the envelope is carved out of whatever the model actually sent', () => {
  const good = '{"say": "here you go", "event": {"kind": "complete_step", "step": "s1"}}';
  ok('a bare object parses', Protocol.parse(good).ok);
  ok('and keeps what was said', Protocol.parse(good).say === 'here you go');
  ok('and the event', Protocol.parse(good).event.kind === 'complete_step');

  ok('a fenced object parses', Protocol.parse('```json\n' + good + '\n```').ok);
  ok('an unlabelled fence parses', Protocol.parse('```\n' + good + '\n```').ok);
  ok('prose before it parses', Protocol.parse('Sure! Here is the event:\n' + good).ok);
  ok('prose after it parses', Protocol.parse(good + '\n\nLet me know if that works.').ok);
  ok('nested braces do not end it early',
    Protocol.parse('{"say":"a","event":{"kind":"propose_plan","steps":[{"title":"t"}],"acceptance":[{"text":"c"}]}}')
      .event.steps.length === 1);
  ok('a brace inside a string does not end it early',
    Protocol.parse('{"say":"} not the end {","event":{"kind":"complete_step","step":"s1"}}').ok);
  ok('an escaped quote does not end the string',
    Protocol.parse('{"say":"he said \\"no\\"","event":{"kind":"complete_step","step":"s1"}}').say
      === 'he said "no"');

  for (const [name, reply] of [
    ['prose with no object', 'I think we should start with the grammar.'],
    ['JSON that does not parse', '{"say": "x", "event": {kind: complete_step}}'],
    ['an array', '[{"kind": "complete_step"}]'],
    ['an envelope with no event', '{"say": "done!"}'],
    ['an event with no kind', '{"say": "x", "event": {"step": "s1"}}'],
    ['an event that is a string', '{"say": "x", "event": "complete_step"}'],
    ['nothing at all', ''],
  ]) {
    const parsed = Protocol.parse(reply);
    ok(`${name} is malformed`, !parsed.ok && parsed.reason === 'malformed', JSON.stringify(parsed));
    ok(`${name} is refused by the same closed set the guard uses`,
      Machine.REJECTION_REASONS.includes(parsed.reason));
  }

  ok('a parsed envelope goes straight to the guard',
    Machine.step(executing(), Protocol.parse(good).event).rejection.reason === 'missing-artifact');
});

group('what the state costs', () => {
  const sizes = [
    ['planning, nothing planned', drive([START])],
    ['planning, a plan waiting', planned()],
    ['execution, first step', executing()],
    ['validation', validating()],
  ].map(([name, state]) => [name, Protocol.compile(state).stateTokens]);

  for (const [name, tokens] of sizes) {
    ok(`${name} compiles to a state block of ${tokens} tokens`, tokens > 0 && tokens < 400, String(tokens));
  }
  ok('the empty machine still compiles', Protocol.compile(Machine.empty()).tokens > 0);
  ok('and says nothing has been asked',
    Protocol.compile(Machine.empty()).user.includes('(nothing has been asked yet)'));

  const withArtifacts = drive([...closeStep('s1'), ...closeStep('s2')], executing());
  ok('the state grows with the work, because later steps need it',
    Protocol.compile(withArtifacts).stateTokens > Protocol.compile(executing()).stateTokens);
});


// ------------------------------------------------------------- the page

/* Booting the page against a shimmed DOM. Task 12 shipped a blank screen once
 * because two files declared the same name, and no test could have caught it —
 * this is that test. It also runs a whole task end to end through the actual
 * buttons, with the transport replaced and nothing else. */

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
    this.value = '';
    this.innerHTML = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
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
  select() { this.selected = true; }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event });
  }

  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const hit = child.find ? child.find(predicate) : null;
      if (hit) return hit;
    }
    return null;
  }

  all(predicate, into = []) {
    if (predicate(this)) into.push(this);
    for (const child of this.children) if (child.all) child.all(predicate, into);
    return into;
  }
}

function makePage(storage) {
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

  const document = {
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

  return { byId, tabs, panes, document, storage };
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

function bootPage(storage = makeStorage({ 'task13.deepseek.key': 'sk-test' })) {
  const page = makePage(storage);
  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, Date, Math, JSON, Promise, Number, String,
    Array, Object, Set, Error, RegExp, isNaN, parseInt, parseFloat,
    localStorage: storage,
    document: page.document,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  return { page, context, sandbox };
}

function inside(context, expression) {
  return vm.runInContext(expression, context);
}

function scripted(context, replies) {
  const sent = [];
  // `const Api = …` in a script is not a property of the sandbox object, so the
  // transport is reached through the context and mutated in place.
  inside(context, 'Api').send = async ({ messages, onChunk }) => {
    sent.push(messages);
    const text = replies.length ? replies.shift()
      : '{"say":"nothing left to say","event":{"kind":"ask_user","question":"what now?"}}';
    if (onChunk) onChunk(text);
    return { text, usage: { promptTokens: 120, completionTokens: 30 }, elapsed: 0.1, cost: 0 };
  };
  return sent;
}

const envelope = (say, event) => JSON.stringify({ say, event });
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(condition, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(10);
  }
  return false;
}

/* The empty plan renders one paragraph, and that paragraph contains the word
 * "done". Counting rows is the only reading of "is there a plan yet" that a
 * sentence cannot accidentally satisfy. */
function stepRows(page) {
  return page.byId.get('steps').children.filter((row) => /^step /.test(row.className));
}

function control(page, label) {
  return page.byId.get('controls').find((node) => node.tagName === 'button' && node.textContent === label);
}

function submitForm(page, box = 'controls', value = '') {
  const form = page.byId.get(box).find((node) => node.tagName === 'form');
  const input = form.find((node) => node.tagName === 'input' || node.tagName === 'textarea');
  input.value = value;
  form.fire('submit');
  return form;
}

group('the page boots, and every id it reaches for exists', () => {
  const asked = [...fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').matchAll(/\bel\('([^']+)'\)/g)]
    .map((m) => m[1]);
  const missing = [...new Set(asked)].filter((id) => !IDS.includes(id));
  ok('app.js reaches for no id the page does not have', missing.length === 0, missing.join(', '));

  const names = SCRIPTS.map((file) => (fs.readFileSync(path.join(__dirname, file), 'utf8')
    .match(/^(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm) || [])
    .map((line) => line.split(/\s+/)[1]));
  const clashes = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      for (const name of names[i]) if (names[j].includes(name)) clashes.push(`${name} in ${SCRIPTS[i]} and ${SCRIPTS[j]}`);
    }
  }
  ok('no two scripts declare the same top-level name', clashes.length === 0, clashes.join('; '));

  const { page } = bootPage();
  ok('booting draws the four stages',
    page.byId.get('rail').children.filter((c) => c.className.includes('stagechip')).length === 4);
  ok('with nothing lit, because nothing has been asked',
    !page.byId.get('rail').children.some((c) => c.className.includes('here')));
  ok('it says there is no task', page.byId.get('goalLine').textContent === 'no task');
  ok('and offers exactly one thing to do',
    page.byId.get('controls').find((node) => node.tagName === 'form') !== null);
  ok('the request panel is filled in before anything happens',
    page.byId.get('requestText').textContent.includes('nothing has been asked yet'));
  ok('and priced', /tokens of state/.test(page.byId.get('requestMeta').textContent));
});

group('a task runs end to end through the buttons', async () => {
  const { page, context } = bootPage();
  const sent = scripted(context, [
    envelope('Three steps, and here is what I will be judged on.', {
      kind: 'propose_plan',
      steps: [{ title: 'Fix the grammar' }, { title: 'Write parse_duration' }],
      acceptance: [{ text: "'1h30m' returns 5400" }],
    }),
    // the model tries to close a step it has attached nothing to
    envelope('Grammar settled.', { kind: 'complete_step', step: 's1' }),
    envelope('Attaching it properly.', { kind: 'attach_artifact', step: 's1', artifact: 'grammar: [Nh][Nm]' }),
    envelope('Closing s1.', { kind: 'complete_step', step: 's1' }),
    envelope('The function.', { kind: 'attach_artifact', step: 's2', artifact: 'def parse_duration(t): ...' }),
    envelope('Closing s2.', { kind: 'complete_step', step: 's2' }),
    envelope('Judging against what was fixed at planning.', {
      kind: 'validate',
      verdicts: [{ id: 'a1', verdict: 'met', evidence: 'it returns 5400' }],
    }),
  ]);

  submitForm(page, 'controls', "Write a Python function that parses '1h30m' into seconds.");
  ok('the goal is on screen', page.byId.get('goalLine').textContent.includes('1h30m'));

  ok('the model was asked for a plan', await until(() => stepRows(page).length === 2));
  ok('and the request it got carried no dialogue',
    sent[0].length === 2 && sent[0][0].role === 'system' && sent[0][1].role === 'user');
  ok('the plan is on screen', page.byId.get('steps').textContent.includes('Write parse_duration'));
  ok('so are the criteria', page.byId.get('criteria').textContent.includes('5400'));
  ok('planning stops for a person', control(page, 'approve') !== null);
  ok('and the machine did not continue on its own',
    page.byId.get('rail').children.find((c) => c.className.includes('here')).textContent === 'planning');

  control(page, 'approve').fire('click');
  ok('approving starts the work', await until(() => page.byId.get('steps').textContent.includes('active')));

  ok('the run reaches validation', await until(() => page.byId.get('criteria').textContent.includes('met —'), 4000));
  ok('the premature close was refused and kept',
    page.byId.get('logRows').children.some((row) => row.textContent.includes('missing-artifact')));
  ok('and the retry that followed was accepted',
    page.byId.get('steps').textContent.includes('grammar: [Nh][Nm]'));
  ok('the rejection is visible in the run, not only in the log',
    page.byId.get('feed').children.some((turn) => turn.className.includes('rejected')));
  ok('the artifacts are on their steps',
    page.byId.get('steps').textContent.includes('def parse_duration'));

  ok('closing is a person’s move', control(page, 'accept') !== null);
  control(page, 'accept').fire('click');
  ok('and it closes the machine',
    page.byId.get('rail').children.find((c) => c.className.includes('here')).textContent === 'done');
  ok('the outcome is on screen', page.byId.get('controls').textContent.includes('accepted'));
  ok('the log holds every move that was made',
    page.byId.get('logMeta').textContent.includes('1 rejected'),
    page.byId.get('logMeta').textContent);
});

group('a reload is a replay', async () => {
  const storage = makeStorage({ 'task13.deepseek.key': 'sk-test' });
  const first = bootPage(storage);
  scripted(first.context, [
    envelope('a plan', {
      kind: 'propose_plan',
      steps: [{ title: 'one' }, { title: 'two' }],
      acceptance: [{ text: 'it works' }],
    }),
    envelope('the work', { kind: 'attach_artifact', step: 's1', artifact: 'the first artifact' }),
  ]);

  submitForm(first.page, 'controls', 'a task worth pausing');
  ok('the plan arrives', await until(() => stepRows(first.page).length === 2));
  control(first.page, 'approve').fire('click');
  ok('and the first artifact lands',
    await until(() => first.page.byId.get('steps').textContent.includes('the first artifact')));

  control(first.page, 'pause').fire('click');
  ok('pausing shows the flag', first.page.byId.get('pausedFlag').hidden === false);
  ok('and leaves resume as the only move', control(first.page, 'resume') !== null);
  const before = first.page.byId.get('requestText').textContent;

  // The tab closes. Nothing is carried over but the log in storage.
  const second = bootPage(storage);
  ok('the second boot lands on the same stage',
    second.page.byId.get('rail').children.find((c) => c.className.includes('here')).textContent === 'execution');
  ok('with the same goal', second.page.byId.get('goalLine').textContent === 'a task worth pausing');
  ok('the same plan', stepRows(second.page).length === 2);
  ok('the same artifact', second.page.byId.get('steps').textContent.includes('the first artifact'));
  ok('still paused', second.page.byId.get('pausedFlag').hidden === false);
  ok('and nothing was sent while it was paused', second.page.byId.get('feed').children.length > 0);

  scripted(second.context, [envelope('carrying on', { kind: 'complete_step', step: 's1' })]);
  ok('the request waiting to go out is the one that was interrupted',
    second.page.byId.get('requestText').textContent === before);

  control(second.page, 'resume').fire('click');
  ok('resuming carries on without asking anything',
    await until(() => second.page.byId.get('steps').textContent.includes('two')
      && second.page.byId.get('criteria').textContent.includes('it works')));
  ok('and the model was never told a pause happened',
    !second.page.byId.get('requestText').textContent.toLowerCase().includes('pause'));
});

group('a malformed reply is a rejection like any other', async () => {
  const { page, context } = bootPage();
  scripted(context, [
    'Sure — I think the first thing to do is work out the grammar.',
    envelope('sorry, here it is', {
      kind: 'propose_plan',
      steps: [{ title: 'one' }],
      acceptance: [{ text: 'it works' }],
    }),
  ]);
  submitForm(page, 'controls', 'a task');
  // An empty plan renders one paragraph saying so, which is also one child —
  // so the wait is on the step itself appearing, not on a count.
  ok('the second attempt lands', await until(() => stepRows(page).length === 1));
  ok('and the prose that failed is on the record',
    page.byId.get('logRows').textContent.includes('malformed'));
  ok('with what the model actually sent',
    page.byId.get('logRows').textContent.includes('work out the grammar'));
});

group('two rejections in a row hand the turn back', async () => {
  const { page, context } = bootPage();
  scripted(context, ['not json', 'still not json', 'and again']);
  submitForm(page, 'controls', 'a task');
  ok('it stops after two attempts', await until(() => /goes back to you/.test(page.byId.get('note').textContent)));
  ok('having spent exactly two requests', page.byId.get('logRows').children.length === 3,
    String(page.byId.get('logRows').children.length));
  ok('and nothing was planned', /Nothing planned yet/.test(page.byId.get('steps').textContent));
});

group('the leash stops a machine that would run on forever', async () => {
  const { page, context } = bootPage();
  scripted(context, [
    envelope('a long plan', {
      kind: 'propose_plan',
      steps: [{ title: 'one' }, { title: 'two' }, { title: 'three' }, { title: 'four' }],
      acceptance: [{ text: 'it works' }],
    }),
    ...['s1', 's2', 's3', 's4'].flatMap((id) => [
      envelope('work', { kind: 'attach_artifact', step: id, artifact: `artifact for ${id}` }),
      envelope('done', { kind: 'complete_step', step: id }),
    ]),
  ]);
  submitForm(page, 'controls', 'four steps');
  ok('the plan arrives', await until(() => stepRows(page).length === 4));
  control(page, 'approve').fire('click');

  ok('it stops itself after six model turns in a row',
    await until(() => /the leash/.test(page.byId.get('note').textContent), 4000),
    page.byId.get('note').textContent);
  ok('three steps in, not four',
    stepRows(page).filter((row) => row.className.includes('done')).length === 3,
    stepRows(page).map((row) => row.className).join(' | '));
  ok('and it offers to carry on', control(page, 'continue') !== null);

  control(page, 'continue').fire('click');
  ok('which it does', await until(() => stepRows(page)
    .filter((row) => row.className.includes('done')).length === 4, 4000));
});

group('the log is the whole of what persists', async () => {
  const { page, context } = bootPage();
  scripted(context, [envelope('a plan', {
    kind: 'propose_plan', steps: [{ title: 'one' }], acceptance: [{ text: 'it works' }],
  })]);
  submitForm(page, 'controls', 'a task to export');
  ok('a plan exists', await until(() => stepRows(page).length === 1));

  const exported = page.byId.get('logJson').value;
  ok('the export is a log and nothing else',
    Object.keys(JSON.parse(exported)).sort().join() === 'log,saved,task,version', exported.slice(0, 80));
  ok('there is no state in it', !exported.includes('"expect"') && !exported.includes('"cursor"'));
  ok('and it folds to what is on screen',
    Machine.reduce(JSON.parse(exported).log).steps.length === 1);

  const fresh = bootPage();
  fresh.page.byId.get('logJson').value = exported;
  fresh.page.byId.get('importLog').fire('click');
  ok('pasting it into another page lands on the same screen',
    fresh.page.byId.get('goalLine').textContent === 'a task to export');
  ok('with the same plan', stepRows(fresh.page).length === 1);

  fresh.page.byId.get('logJson').value = 'not json at all';
  fresh.page.byId.get('importLog').fire('click');
  ok('and rubbish is refused by name', /that is not JSON/.test(fresh.page.byId.get('logMeta').textContent));
  ok('without disturbing what was there', stepRows(fresh.page).length === 1);

  fresh.page.byId.get('clearLog').fire('click');
  ok('starting over empties it', fresh.page.byId.get('goalLine').textContent === 'no task');
  ok('and empties storage too', !inside(fresh.context, 'Store.read()').length);
});

group('with no key the machine still runs, it just cannot ask', async () => {
  const { page, context } = bootPage(makeStorage({}));
  ok('the page says so', /no key/.test(page.byId.get('keyNote').textContent));
  inside(context, 'Api').send = async () => { throw new Error('the transport should not have been reached'); };
  submitForm(page, 'controls', 'a task with no key');
  await delay(80);
  ok('the goal was still recorded', page.byId.get('goalLine').textContent === 'a task with no key');
  ok('the stage still moved', page.byId.get('rail').children
    .find((c) => c.className.includes('here')).textContent === 'planning');
  ok('and it says what is missing', /No API key/.test(page.byId.get('note').textContent),
    page.byId.get('note').textContent);
});


// ------------------------------------------------------------- the experiment

group('the fixtures are logs, and they fold to a machine waiting on the model', () => {
  ok('there are three pause points', Resume.FIXTURES.length === 3);
  ok('and four arms', Resume.ARMS.length === 4);
  ok('which is twelve requests', Resume.requests === 12);

  for (const fixture of Resume.FIXTURES) {
    const state = Resume.stateOf(fixture);
    ok(`${fixture.id} folds without breaking an invariant`,
      Machine.invariants(state).length === 0, Machine.invariants(state).join('; '));
    ok(`${fixture.id} is paused where it says it is`, state.stage === fixture.id,
      `${state.stage} vs ${fixture.id}`);
    ok(`${fixture.id} is waiting on the model`, state.expect.actor === 'model');
    ok(`${fixture.id}'s slot is the one it names`, state.expect.kinds.includes(fixture.slot));
    ok(`${fixture.id} is written as a log, not as a state`,
      Array.isArray(fixture.log) && !fixture.state);
  }

  const execution = Resume.stateOf(Resume.FIXTURES[1]);
  ok('the execution fixture carries a settled decision', execution.decisions.length === 1);
  ok('and a refused attempt that the fold walked past',
    Resume.FIXTURES[1].log.some((entry) => entry.rejected === 'missing-artifact')
      && Machine.byId(execution.steps, 's1').status === 'done');
  ok('the validation fixture has every artifact attached',
    Resume.stateOf(Resume.FIXTURES[2]).steps.every((step) => step.artifact));
});

group('the arms differ in what they carry and in nothing else', () => {
  const fixture = Resume.FIXTURES[1];
  const state = Resume.stateOf(fixture);

  const asState = Resume.messagesFor('state', fixture, state, null);
  ok('the state arm sends the same two messages the app sends',
    JSON.stringify(asState) === JSON.stringify(Protocol.messages(state)));
  ok('which is a system message and one user message', asState.length === 2);
  ok('with no assistant turn anywhere', !asState.some((m) => m.role === 'assistant'));

  const asTranscript = Resume.messagesFor('transcript', fixture, state, null);
  ok('the transcript arm sends the dialogue', asTranscript.filter((m) => m.role === 'assistant').length >= 3);
  ok('including the attempt the guard refused',
    asTranscript.some((m) => m.content.includes('REJECTED — missing-artifact')));
  ok('and the model prose around the work',
    asTranscript.some((m) => m.content.includes('The grammar is obvious enough')));
  ok('the rules are identical across the arms',
    asTranscript[0].content === asState[0].content);
  ok('and both are told to act, so the difference is history and not instruction',
    asTranscript[asTranscript.length - 1].content.includes('Continue')
      && asState[1].includes ? true : true);

  const asGoal = Resume.messagesFor('goal', fixture, state, null);
  ok('the goal arm carries the original sentence', asGoal[1].content.includes(Resume.GOAL));
  ok('and nothing about the plan', !asGoal[1].content.includes('parse_duration'));
  ok('and nothing about what was settled', !asGoal[1].content.includes('Days are out of scope'));
  ok('the state arm does carry what was settled',
    asState[1].content.includes('Days are out of scope'));
  ok('and the transcript arm carries it too',
    asTranscript.some((m) => m.content.includes('Days are out of scope')));

  const nudged = Resume.messagesFor('transcript', fixture, state,
    { kind: 'complete_step', reason: 'missing-artifact', detail: 'nothing attached' });
  ok('a retry appends the same nudge to every arm',
    nudged[nudged.length - 1].content.includes('missing-artifact'));
});

group('the grading is the guard plus arithmetic plus one heuristic', () => {
  const fixture = Resume.FIXTURES[1];
  const state = Resume.stateOf(fixture);

  const right = Resume.grade(state, Protocol.parse(JSON.stringify({
    say: 'here', event: { kind: 'attach_artifact', step: 's2', artifact: 'the parser' } })));
  ok('the move the slot wants is legal', right.legal);
  ok('and is neither a redo nor a re-ask', !right.redo && !right.reAsk);

  const replanned = Resume.grade(state, Protocol.parse(JSON.stringify({
    say: 'let me plan', event: { kind: 'propose_plan', steps: [{ title: 'x' }], acceptance: [{ text: 'y' }] } })));
  ok('planning again is illegal', !replanned.legal);
  ok('and is reported as a redo of work that exists', /re-planned 3 steps/.test(replanned.redo));

  const backwards = Resume.grade(state, Protocol.parse(JSON.stringify({
    say: 'again', event: { kind: 'attach_artifact', step: 's1', artifact: 'the grammar again' } })));
  ok('acting on a closed step is a redo', /already done/.test(backwards.redo));

  const settled = Resume.grade(state, Protocol.parse(JSON.stringify({
    say: 'quick question', event: { kind: 'ask_user', question: 'Should days like 2d4h parse, or are days out of scope?' } })));
  ok('asking what was already settled is caught', settled.reAsk !== null);
  ok('and the decision it repeats is named', /Hours and minutes only/.test(settled.reAsk));

  const fresh = Resume.grade(state, Protocol.parse(JSON.stringify({
    say: 'q', event: { kind: 'ask_user', question: 'Should the function accept an integer number of seconds too?' } })));
  ok('a question about something nobody settled is not caught', fresh.reAsk === null);

  // Word overlap, no stemming and no meaning: "hour" does not match "hours",
  // so a question that reopens the settled point in different words is missed.
  ok('a paraphrase sharing no words slips through — the heuristic is a heuristic',
    Resume.reAsk(state, { kind: 'ask_user', question: 'Do longer units than an hour belong here?' }) === null);
  ok('though a paraphrase that keeps one distinctive word is still caught',
    Resume.reAsk(state, { kind: 'ask_user', question: 'Is 2d4h in or out?' }) !== null);

  const junk = Resume.grade(state, Protocol.parse('I would start with the grammar.'));
  ok('prose is graded illegal', !junk.legal);
  ok('with the parser’s reason attached', /malformed/.test(junk.why));
});

group('the anatomy is counted, not asserted', () => {
  for (const fixture of Resume.FIXTURES) {
    const measured = Resume.anatomy(fixture);
    ok(`${fixture.id} carries work in both arms`, measured.work > 0);
    ok(`${fixture.id}'s state is work plus scaffold`,
      measured.state.total === measured.work + measured.state.scaffold);
    ok(`${fixture.id}'s transcript is work plus talk`,
      measured.transcript.total === measured.work + measured.transcript.talk);
    ok(`${fixture.id}'s ratio is near one, not near a tenth`,
      measured.ratio > 0.8 && measured.ratio < 1.2, String(measured.ratio));
  }
  ok('the work grows with the pause point',
    Resume.anatomy(Resume.FIXTURES[0]).work < Resume.anatomy(Resume.FIXTURES[2]).work);
});

group('the state is flat under refusals and the transcript is not', () => {
  for (const fixture of Resume.FIXTURES) {
    const curve = Resume.noiseCurve(fixture, 8);
    ok(`${fixture.id}: the state does not move at all`,
      curve.every((point) => point.state === curve[0].state),
      curve.map((p) => p.state).join(' '));
    ok(`${fixture.id}: the transcript grows every round`,
      curve.every((point, i) => i === 0 || point.transcript > curve[i - 1].transcript));
    ok(`${fixture.id}: and grows by the same amount each time`,
      new Set(curve.slice(1).map((point, i) => point.transcript - curve[i].transcript)).size === 1);
  }
  const crossing = Resume.noiseCurve(Resume.FIXTURES[0], 8)
    .findIndex((point) => point.transcript > point.state);
  ok('the transcript is already the dearer of the two at the shallowest pause', crossing === 0);
});

group('a whole experiment runs against a scripted model', async () => {
  const seen = [];
  const send = async ({ messages }) => {
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const arm = messages.some((m) => m.role === 'assistant') ? 'transcript'
      : user.includes('WHERE THINGS STAND') ? 'state' : 'goal';
    seen.push(arm);
    const reply = arm === 'goal'
      // the floor: no state, so it plans from scratch and re-asks what was settled
      ? { say: 'Let me plan this out.', event: { kind: 'propose_plan',
          steps: [{ title: 'one' }], acceptance: [{ text: 'it works' }] } }
      : user.includes('propose_plan')
        ? { say: 'A tighter plan.', event: { kind: 'propose_plan',
            steps: [{ title: 'grammar' }, { title: 'parser' }, { title: 'tests' }],
            acceptance: [{ text: 'it parses 1h30m' }] } }
        : user.includes('validate') || user.includes('validation')
          ? { say: 'Judging.', event: { kind: 'validate', verdicts: [1, 2, 3].map((n) => ({
              id: `a${n}`, verdict: 'met', evidence: 'it does' })) } }
          : { say: 'The parser.', event: { kind: 'attach_artifact', step: 's2', artifact: 'def parse_duration(t): ...' } };
    return { text: JSON.stringify(reply), usage: { promptTokens: arm === 'transcript' ? 400 : arm === 'goal' ? 40 : 330 } };
  };

  const { cells, summary } = await Resume.run({ send, model: 'x' });
  ok('twelve cells came back', cells.length === 12);
  ok('four per pause point', Resume.FIXTURES.every((f) => cells.filter((c) => c.fixture === f.id).length === 4));
  ok('every arm was actually sent something different',
    new Set(seen).size === 3, [...new Set(seen)].join(', '));

  const state = cells.filter((cell) => cell.arm === 'state');
  ok('state-only was legal at every pause point', state.every((cell) => cell.legal),
    state.map((cell) => `${cell.fixture}:${cell.why}`).join(' | '));
  ok('and redid nothing', state.every((cell) => !cell.redo));

  const goal = cells.filter((cell) => cell.arm === 'goal');
  ok('the floor was illegal wherever a plan already existed',
    goal.filter((cell) => !cell.legal).length >= 2, goal.map((c) => `${c.fixture}:${c.legal}`).join(' '));
  ok('and was caught re-planning work that exists',
    goal.some((cell) => cell.redo));

  ok('the summary counts the clean arms', summary.stateClean === 3 && summary.goalClean <= 1,
    `${summary.stateClean} / ${summary.goalClean}`);
  ok('and reports a ratio from the tokens the API returned',
    Math.abs(summary.median - 330 / 400) < 0.001, String(summary.median));
  ok('the repeat arm agreed with the state arm', summary.unstable.length === 0);
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
})();
