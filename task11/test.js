/* The rules, checked without a model.
 *
 * `node test.js`. No dependencies, no runner, no build — the same rule the
 * app itself follows.
 *
 * Everything here is a claim the README makes, in the form that fails loudly
 * when it stops being true. The routing rules are a pure function from
 * candidates to layers, so they can be exercised with hand-built candidates
 * and no network: that was the reason for splitting `plan()` from `commit()`
 * in the first place, and this file is what the split was for.
 *
 * The browser loads these files as plain scripts sharing one global scope, so
 * that is how they are loaded here too. `vm.runInThisContext` is the smallest
 * honest imitation of a <script> tag.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

for (const file of ['layers.js', 'extract.js', 'router.js']) {
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

function group(name, body) {
  console.log(`\n${name}`);
  body();
}

/* ------------------------------------------------------------- the layers */

group('the layers are told apart by lifetime', () => {
  const m = new Memory();
  m.short.put({ role: 'user', content: 'call me Atabek' });
  m.working.open('ship the panel');
  m.working.put({ key: 'deadline', value: '11 March', kind: 'decision' });
  m.long.put({ compartment: 'profile', key: 'name', value: 'Atabek' });

  m.resetDialogue();
  ok('resetting the dialogue empties short-term', m.short.length === 0);
  ok('resetting the dialogue keeps the task', m.working.get('deadline') !== null);
  ok('resetting the dialogue keeps the person', m.long.get('profile', 'name') !== null);

  const closed = m.working.close();
  ok('closing the task empties working', m.working.all().length === 0);
  ok('closing the task keeps the person', m.long.get('profile', 'name') !== null);
  ok('a closed task keeps its items', closed.record.items.length === 2);
});

group('the working layer evicts by kind, not by recency', () => {
  const m = new Memory({ maxWorking: 3 });
  m.working.open('the goal');
  m.working.put({ key: 'a1', value: 'first artifact', kind: 'artifact' });
  m.working.put({ key: 'c1', value: 'no cloud', kind: 'constraint' });
  m.working.put({ key: 'a2', value: 'second artifact', kind: 'artifact' });
  const kept = m.working.all().map((i) => i.key);
  ok('the goal survives newer artifacts', kept.includes('task_goal'), `kept: ${kept}`);
  ok('a constraint outranks an artifact', kept.includes('c1'), `kept: ${kept}`);
});

group('the profile is typed and the other compartments are not', () => {
  const m = new Memory();
  ok('a profile field is accepted',
    m.long.put({ compartment: 'profile', key: 'language', value: 'Russian' }).written);
  ok('a free key is refused by the profile',
    m.long.put({ compartment: 'profile', key: 'favourite_colour', value: 'blue' }).written === false);
  ok('the same free key is accepted by knowledge',
    m.long.put({ compartment: 'knowledge', key: 'favourite_colour', value: 'blue' }).written);
});

group('the same value twice is a confirmation, not a revision', () => {
  const m = new Memory();
  m.long.put({ compartment: 'knowledge', key: 'db', value: 'Postgres' });
  const again = m.long.put({ compartment: 'knowledge', key: 'db', value: 'Postgres' });
  ok('it is reported as a confirmation', again.confirmed === true);
  ok('the counter moved', m.long.get('knowledge', 'db').confirmations === 1);
  ok('no revision was recorded', m.long.get('knowledge', 'db').history.length === 0);

  const changed = m.long.put({ compartment: 'knowledge', key: 'db', value: 'MySQL' });
  ok('a different value is a revision', changed.revised === true);
  ok('only the current value is current', m.long.get('knowledge', 'db').value === 'MySQL');
  ok('the old value is kept out of the block',
    !m.long.block().text.includes('Postgres'));
});

group('a block that truncates says so inside itself', () => {
  const m = new Memory({ longBudget: 24 });
  for (let i = 0; i < 12; i += 1) {
    m.long.put({ compartment: 'knowledge', key: `key_${i}`, value: `value number ${i}` });
  }
  const block = m.long.block();
  ok('it truncated', block.shown < block.held);
  ok('it admits it', /not shown/.test(block.text), block.text);
});

/* -------------------------------------------------------------- the gate */

group('the verbatim gate', () => {
  const turn = { user: 'the deadline is 11 March', assistant: 'noted' };
  const quoted = normalise({ key: 'deadline', value: '11 March', kind: 'decision', from: 'user' });
  const rephrased = normalise({ key: 'deadline', value: 'the 11th of March', kind: 'decision', from: 'user' });
  const misattributed = normalise({ key: 'deadline', value: '11 March', kind: 'decision', from: 'assistant' });

  ok('a quoted span passes', gate(quoted, turn).ok);
  ok('a rephrased date is refused', gate(rephrased, turn).ok === false);
  ok('quoting one speaker while naming the other is refused', gate(misattributed, turn).ok === false);
  ok('case and whitespace do not matter',
    gate(normalise({ key: 'deadline', value: '11  MARCH', from: 'user' }), turn).ok);
});

/* ------------------------------------------------------------ the router */

function routed(candidates, { goal = null, turn } = {}) {
  const memory = new Memory();
  if (goal) memory.working.open(goal);
  const router = new Router({ memory });
  const entries = router.handle(candidates.map(normalise), { turn });
  return { memory, router, entries };
}

group('every rule fires, and says which one it was', () => {
  const turn = {
    user: 'Call me Atabek and answer in Russian. The deadline is 11 March, we must not add a build '
      + 'step, the staging box is 10.2.0.7, and Postgres 16 is what production runs. Sounds good to me.',
    assistant: 'Understood, three columns it is.',
  };
  const { entries } = routed([
    { key: 'name', value: 'Atabek', kind: 'profile', layer: 'long', from: 'user' },
    { key: 'preferred_language', value: 'Russian', kind: 'profile', layer: 'working', from: 'user' },
    { key: 'production_db', value: 'Postgres 16', kind: 'knowledge', layer: 'long', from: 'user' },
    { key: 'build', value: 'must not add a build step', kind: 'constraint', layer: 'working', from: 'user' },
    { key: 'deadline', value: '11 March', kind: 'decision', layer: 'long', from: 'user' },
    { key: 'columns', value: 'three columns', kind: 'agreement', layer: 'working', from: 'assistant' },
    { key: 'it', value: '10.2.0.7', kind: 'identifier', layer: 'working', from: 'user' },
    { key: 'mood', value: 'Sounds good to me', kind: 'other', layer: 'working', from: 'user' },
  ], { goal: 'ship the memory panel', turn });

  const by = (key) => entries.find((e) => e.key === key || e.key === Memory.key(key));
  ok('rule 3 puts the name in the profile',
    by('name').layer === 'long' && by('name').compartment === 'profile' && by('name').rule.n === 3);
  ok('an alias reaches the same field', by('language').key === 'language');
  ok('rule 4 puts knowledge in long-term',
    by('production_db').compartment === 'knowledge' && by('production_db').rule.n === 4);
  ok('rule 5 puts a constraint in working',
    by('build').layer === 'working' && by('build').rule.n === 5);
  ok('rule 6 puts a decision in working and marks it promotable',
    by('deadline').layer === 'working' && by('deadline').rule.n === 6 && by('deadline').promotable);
  ok('an agreement is a decision', by('columns').workingKind === 'decision');
  ok('rule 2 drops a pronoun key',
    by('it').outcome === 'dropped' && by('it').rule.n === 2);
  ok('rule 2 drops a value that carries nothing',
    by('mood').outcome === 'dropped' && by('mood').rule.n === 2);
});

group('the model proposes and the rules overrule it, on the record', () => {
  const turn = { user: 'answer in Russian, and the deadline is 11 March', assistant: 'ok' };
  const { entries } = routed([
    { key: 'language', value: 'Russian', kind: 'profile', layer: 'working', from: 'user' },
    { key: 'deadline', value: '11 March', kind: 'decision', layer: 'long', from: 'user' },
  ], { goal: 'the migration', turn });

  ok('a proposal that was overruled is marked so', entries.every((e) => e.agreed === false));
  ok('the proposal is kept beside the decision',
    entries[0].proposed === 'working' && entries[0].layer === 'long');
  ok('and the other way round',
    entries[1].proposed === 'long' && entries[1].layer === 'working');
});

group('an identifier is an artifact of a task, and knowledge without one', () => {
  const turn = { user: 'the staging box is 10.2.0.7', assistant: 'ok' };
  const withTask = routed([{ key: 'staging_box', value: '10.2.0.7', kind: 'identifier', from: 'user' }],
    { goal: 'the migration', turn });
  const without = routed([{ key: 'staging_box', value: '10.2.0.7', kind: 'identifier', from: 'user' }],
    { turn });
  ok('with a task open it is working memory', withTask.entries[0].layer === 'working');
  ok('with no task it is knowledge', without.entries[0].compartment === 'knowledge');
});

group('a task-shaped candidate cannot overwrite the person', () => {
  const turn = { user: 'we agreed the name is memory-panel', assistant: 'ok' };
  const { memory, entries } = routed([
    { key: 'name', value: 'memory-panel', kind: 'agreement', layer: 'long', from: 'user' },
  ], { goal: 'the panel', turn });
  ok('an agreement keyed "name" stays in the task', entries[0].layer === 'working');
  ok('the profile was not touched', memory.long.get('profile', 'name') === null);
});

group('a retraction is a write, and finds the layer for itself', () => {
  const memory = new Memory();
  memory.working.open('the migration');
  memory.long.put({ compartment: 'knowledge', key: 'db', value: 'Postgres' });
  memory.working.put({ key: 'deadline', value: '11 March', kind: 'decision' });
  const router = new Router({ memory });

  const [dropped] = router.handle(
    [normalise({ key: 'deadline', op: 'clear', from: 'user' })],
    { turn: { user: 'forget the deadline', assistant: 'ok' } }
  );
  ok('it reaches working', dropped.layer === 'working' && dropped.outcome === 'retracted');
  ok('and the key is gone', memory.working.get('deadline') === null);

  const [longer] = router.handle(
    [normalise({ key: 'db', op: 'clear', from: 'user' })],
    { turn: { user: 'forget the database', assistant: 'ok' } }
  );
  ok('it reaches long-term', longer.compartment === 'knowledge' && longer.outcome === 'retracted');
  ok('a retraction is tombstoned, not lost', memory.long.retracted.length === 1);

  const [nothing] = router.handle(
    [normalise({ key: 'nonsense', op: 'clear', from: 'user' })],
    { turn: { user: 'forget the nonsense', assistant: 'ok' } }
  );
  ok('withdrawing something unknown is reported', nothing.outcome === 'dropped');
});

group('a person can overrule the router, and the log says it was a person', () => {
  const memory = new Memory();
  memory.working.open('the migration');
  memory.working.put({ key: 'db', value: 'Postgres 16', kind: 'artifact' });
  const router = new Router({ memory });

  const entry = router.manual({ item: memory.working.get('db'), to: 'long', compartment: 'knowledge' });
  ok('it moved', memory.long.get('knowledge', 'db') !== null && memory.working.get('db') === null);
  ok('the rule is 0 and named manual', entry.rule.n === 0 && entry.rule.name === 'manual');
  ok('the provenance came with it', memory.long.get('knowledge', 'db').value === 'Postgres 16');
});

group('promotion happens at the close, and not before', () => {
  const memory = new Memory();
  memory.working.open('the migration');
  const router = new Router({ memory });
  router.handle([normalise({ key: 'db', value: 'Postgres', kind: 'decision', from: 'user' })],
    { turn: { user: 'we will use Postgres', assistant: 'ok' } });

  ok('while the task is open it is not long-term', memory.long.get('decisions', 'db') === null);
  const { record, promotable } = memory.working.close();
  ok('the decision is offered', promotable.length === 1 && promotable[0].key === 'db');
  router.promote(promotable[0], { taskId: record.id, goal: record.goal });
  ok('and then it is long-term', memory.long.get('decisions', 'db').value === 'Postgres');
  ok('it remembers which task decided it',
    memory.long.get('decisions', 'db').promotedFrom.goal === 'the migration');
});

/* --------------------------------------------------------------- the end */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
