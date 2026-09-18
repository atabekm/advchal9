/* Checks that need no network and no key.
 *
 * The subject of this task is a function that decides whether a proposal
 * violates a rule, and a function with no I/O is exactly the thing a test can
 * pin down completely. Everything the checker claims is asserted here; what
 * the model does with any of it is the experiment's business, not this file's.
 */

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

/* Every violation code this file actually provokes. A closed set is only
 * closed if nothing in it is dead, so the last group compares the two. Task 13
 * shipped a rejection reason no scenario could reach and only found out
 * because a test demanded one per reason. */
const provoked = new Set();

function adjudicate(set, declaration) {
  const result = Invariant.check(set, declaration);
  for (const violation of result.violations) provoked.add(violation.code);
  return result;
}

/* The same, for a whole reply: every reason a turn can end badly goes through
 * here so the last group can compare what was provoked against the closed
 * set. */
function turnOf(set, text) {
  const result = Protocol.adjudicate(set, text);
  if (result.rejection) provoked.add(result.rejection.reason);
  return result;
}

const envelope = (fields) => JSON.stringify(fields);

function codes(set, declaration) {
  return adjudicate(set, declaration).violations.map((v) => `${v.id}:${v.code}`).sort();
}

const REPO = Invariant.REPO;
const PAY = Invariant.PAYMENTS;

/* A proposal that touches everything the repo set cares about and breaks none
 * of it — the shape a compliant answer has. */
const COMPLIANT = {
  runtime: ['browser'],
  language: ['js'],
  dependency: [],
  build: [],
  service: [],
  network: ['api.deepseek.com'],
  storage: ['localStorage:task14.invariants'],
  data: ['api-key'],
  operation: [],
  precondition: [],
};

/* ------------------------------------------------------------------------ */

group('the vocabulary is closed, and nothing in it is decoration', () => {
  ok('there are ten facets', Invariant.FACET_NAMES.length === 10, Invariant.FACET_NAMES.join(', '));
  ok('every facet has a description', Invariant.FACET_NAMES.every((f) => Invariant.FACETS[f].length > 8));
  ok('there are four ops', Invariant.OP_NAMES.length === 4, Invariant.OP_NAMES.join(', '));
  ok('there are four violation codes', Invariant.VIOLATION_CODES.length === 4);

  const used = new Set();
  for (const set of Object.values(Invariant.SETS)) {
    for (const one of Invariant.hard(set)) {
      const rule = one.rule;
      used.add(Invariant.isConditional(rule) ? rule.then.op : rule.op);
    }
  }
  ok('every op is exercised by a seeded invariant', Invariant.OP_NAMES.every((op) => used.has(op)),
    `unused: ${Invariant.OP_NAMES.filter((op) => !used.has(op)).join(', ')}`);

  ok('every seeded invariant passes its own validator',
    Object.values(Invariant.SETS).every((set) => Invariant.invariantsOf(set)
      .every((one) => Invariant.validate(one).length === 0)),
    Object.values(Invariant.SETS).flatMap((set) => Invariant.invariantsOf(set)
      .map((one) => `${set.id}/${one.id}: ${Invariant.validate(one).join('; ')}`)
      .filter((line) => !line.endsWith(': '))).join('\n      '));

  ok('every seeded invariant says why it exists',
    Object.values(Invariant.SETS).every((set) => Invariant.invariantsOf(set)
      .every((one) => String(one.why || '').length > 40)));

  ok('ids are unique within a set',
    Object.values(Invariant.SETS).every((set) => {
      const ids = Invariant.invariantsOf(set).map((one) => one.id);
      return new Set(ids).size === ids.length;
    }));

  ok('both kinds of enforcement are represented in both sets',
    Object.values(Invariant.SETS).every((set) => Invariant.hard(set).length > 0 && Invariant.soft(set).length > 0));

  ok('all four kinds of invariant appear across the two sets',
    Invariant.KINDS.every((kind) => Object.values(Invariant.SETS)
      .some((set) => Invariant.invariantsOf(set).some((one) => one.kind === kind))));
});

group('a declaration is normalised before anything looks at it', () => {
  const messy = Invariant.normalise({ dependency: [' Marked@12 ', 'marked@12', ''], network: 'API.DeepSeek.com' });
  ok('case and space are gone', messy.dependency[0] === 'marked@12');
  ok('duplicates are gone', messy.dependency.length === 1);
  ok('a bare string counts as one item', messy.network.length === 1 && messy.network[0] === 'api.deepseek.com');
  ok('every facet is present, even the empty ones',
    Invariant.FACET_NAMES.every((f) => Array.isArray(messy[f])));
  ok('normalising twice changes nothing',
    JSON.stringify(Invariant.normalise(messy)) === JSON.stringify(messy));
  ok('garbage in gives an empty declaration, not a throw',
    Invariant.FACET_NAMES.every((f) => Invariant.normalise(null)[f].length === 0));
  ok('a facet nobody defined is reported rather than dropped',
    Invariant.unknownFacets({ dependency: [], frobnicate: ['x'] }).join() === 'frobnicate');
  ok('an empty declaration declares nothing', !Invariant.declaredAnything({}));
  ok('and one with an item declares something', Invariant.declaredAnything({ runtime: ['browser'] }));
});

group('globs, because an invariant nobody can read is one nobody adopts', () => {
  ok('an exact item matches itself', Invariant.matches('postgres', 'postgres'));
  ok('and nothing else', !Invariant.matches('postgresql', 'postgres'));
  ok('a star matches a suffix', Invariant.matches('localstorage:task14.log', 'localstorage:task14.*'));
  ok('and refuses a different prefix', !Invariant.matches('localstorage:task13.log', 'localstorage:task14.*'));
  ok('a leading star matches a suffix', Invariant.matches('vault.eu', '*.eu'));
  ok('a bare star matches anything', Invariant.matches('whatever', '*'));
  ok('regex metacharacters in a pattern are literal',
    !Invariant.matches('aaa', 'a+') && Invariant.matches('a+', 'a+'));
  ok('an empty pattern matches nothing', !Invariant.matches('', ''));
  ok('matching ignores case on both sides', Invariant.matches('Postgres', 'POSTGRES'));
});

group('bearing is a different question from holding', () => {
  const empty = Invariant.normalise({});
  const deps = Invariant.normalise({ dependency: ['marked'] });

  ok('a prohibition has no opinion on a facet nobody declared',
    !Invariant.bears({ facet: 'dependency', op: 'deny-all' }, empty));
  ok('and has one the moment something is declared',
    Invariant.bears({ facet: 'dependency', op: 'deny-all' }, deps));
  ok('a requirement always bears, because you can always fail to include something',
    Invariant.bears({ facet: 'precondition', op: 'require', items: ['x'] }, empty));

  const conditional = {
    when: { facet: 'data', includes: 'pii' },
    then: { facet: 'network', op: 'allow-only', items: ['*.eu'] },
  };
  ok('a conditional rule is silent while its condition is unmet',
    !Invariant.bears(conditional, Invariant.normalise({ network: ['api.example.com'] })));
  ok('and speaks once it is met',
    Invariant.bears(conditional, Invariant.normalise({ data: ['pii'], network: ['api.example.com'] })));
  ok('a rule over a facet nobody defined never bears',
    !Invariant.bears({ facet: 'frobnicate', op: 'deny-all' }, deps));
  ok('every violation comes from an invariant that bore',
    (() => {
      const result = adjudicate(REPO, { dependency: ['react'], runtime: ['server'] });
      return result.violations.every((v) => result.bearing.includes(v.id));
    })());
});

group('the repo set, on proposals it was written for', () => {
  ok('a compliant proposal is clean', adjudicate(REPO, COMPLIANT).clean,
    JSON.stringify(adjudicate(REPO, COMPLIANT).violations));

  ok('a markdown library is refused by name',
    codes(REPO, { ...COMPLIANT, dependency: ['marked@12'] }).join() === 'INV-2:denied-all');
  ok('and the refusal can quote the item',
    adjudicate(REPO, { ...COMPLIANT, dependency: ['marked@12'] }).violations[0].offending[0] === 'marked@12');

  ok('a build step is refused',
    codes(REPO, { ...COMPLIANT, build: ['vite'] }).join() === 'INV-3:denied-all');
  ok('a server is refused',
    codes(REPO, { ...COMPLIANT, runtime: ['browser', 'node'] }).join() === 'INV-1:not-allowed');
  ok('a second provider is refused',
    codes(REPO, { ...COMPLIANT, data: [], network: ['api.deepseek.com', 'api.openai.com'] })
      .join() === 'INV-4:not-allowed');
  ok('and adding one while the key is in hand breaks two invariants, not one',
    codes(REPO, { ...COMPLIANT, network: ['api.deepseek.com', 'api.openai.com'] })
      .join() === 'INV-4:not-allowed,INV-6:not-allowed');
  ok('an unnamespaced storage key is refused',
    codes(REPO, { ...COMPLIANT, storage: ['localStorage:apikey'] }).join() === 'INV-5:not-allowed');
  ok('so is the wrong namespace, which is the one a copy-paste produces',
    codes(REPO, { ...COMPLIANT, storage: ['localStorage:task13.log'] }).join() === 'INV-5:not-allowed');

  ok('sending the key anywhere but the provider breaks the conditional rule',
    codes(REPO, { ...COMPLIANT, data: ['api-key'], network: ['api.deepseek.com', 'telemetry.example.com'] })
      .join() === 'INV-4:not-allowed,INV-6:not-allowed');
  ok('and the same host is fine when no key is involved',
    codes(REPO, { ...COMPLIANT, data: [], network: ['api.deepseek.com'] }).length === 0);

  ok('one proposal can break several invariants at once',
    codes(REPO, { runtime: ['node'], dependency: ['express'], build: ['tsc'] }).length === 3);
});

group('the payments set, where the rules are about money', () => {
  const settled = { operation: ['issue_refund'], precondition: ['payment_settled'], storage: ['postgres'], language: ['go'] };

  ok('a refund against a settled payment is clean', adjudicate(PAY, settled).clean,
    JSON.stringify(adjudicate(PAY, settled).violations));
  ok('a refund with no settlement check is refused',
    codes(PAY, { ...settled, precondition: [] }).join() === 'INV-4:missing-required');
  ok('and the refusal names what is missing',
    adjudicate(PAY, { ...settled, precondition: [] }).violations[0].offending.join() === 'payment_settled');
  ok('a precondition that is merely adjacent does not satisfy it',
    codes(PAY, { ...settled, precondition: ['payment_authorised'] }).join() === 'INV-4:missing-required');

  ok('a second datastore is refused',
    codes(PAY, { ...settled, storage: ['postgres', 'redis'] }).join() === 'INV-1:not-allowed');
  ok('a second language is refused',
    codes(PAY, { ...settled, language: ['go', 'python'] }).join() === 'INV-2:not-allowed');
  ok('a new service is refused',
    codes(PAY, { ...settled, service: ['refund-worker'] }).join() === 'INV-3:deniedall'.replace('deniedall', 'denied-all'));
  ok('capturing a payment from this service is refused by name',
    codes(PAY, { ...settled, operation: ['issue_refund', 'capture_payment'] }).join() === 'INV-6:denied-item');

  ok('personal data may go to an EU host',
    adjudicate(PAY, { ...settled, data: ['pii'], network: ['vault.eu.internal'] }).clean);
  ok('and not to one outside it',
    codes(PAY, { ...settled, data: ['pii'], network: ['analytics.example.com'] }).join() === 'INV-5:not-allowed');
  ok('the same host is fine when no personal data is involved',
    adjudicate(PAY, { ...settled, data: ['payment'], network: ['analytics.example.com'] }).clean);
});

group('soft invariants are carried, never graded', () => {
  const noisy = adjudicate(REPO, { dependency: ['react'], runtime: ['node'], build: ['vite'] });
  ok('a soft invariant never appears as a violation',
    !noisy.violations.some((v) => v.id === 'INV-7'));
  ok('nor in what bore on the declaration', !noisy.bearing.includes('INV-7'));
  ok('it is returned as unverified instead', noisy.unverified.includes('INV-7'));
  ok('a soft invariant carries no rule',
    Invariant.soft(REPO).every((one) => !one.rule));
  ok('and the validator refuses one that does',
    Invariant.validate({ id: 'X', text: 't', kind: 'decision', enforcement: 'soft', rule: { facet: 'dependency', op: 'deny-all' } })
      .join().includes('carries no rule'));
});

group('"explicitly considered" is the gap between what bore and what was named', () => {
  const declaration = { ...COMPLIANT, dependency: ['marked'] };
  const bearing = adjudicate(REPO, declaration).bearing;
  ok('something bears on this declaration', bearing.length >= 3, bearing.join(', '));
  ok('naming everything that bore leaves no miss',
    Invariant.missed(REPO, declaration, bearing).length === 0);
  ok('naming nothing makes every one of them a miss',
    Invariant.missed(REPO, declaration, []).length === bearing.length);
  ok('naming the violated one and skipping the rest still misses the rest',
    Invariant.missed(REPO, declaration, ['INV-2']).length === bearing.length - 1);
  ok('naming an invariant that did not bear is not credited',
    Invariant.missed(REPO, declaration, ['INV-7']).length === bearing.length);
  ok('case in a cited id does not matter',
    Invariant.missed(REPO, declaration, bearing.map((id) => id.toLowerCase())).length === 0);
});

group('the net under the hole, which is a heuristic and says so', () => {
  const nothing = { ...COMPLIANT, dependency: [], storage: [] };
  const hits = (prose, declaration = nothing) => Invariant.contradiction(declaration, prose)
    .map((f) => `${f.facet}:${f.implied}`).sort();

  ok('an install that was not declared is caught',
    hits('Run `npm install marked` first.').join() === 'dependency:marked');
  ok('so is a bare import', hits("import { marked } from 'marked'").join() === 'dependency:marked');
  ok('a relative import is not a dependency', hits("import { x } from './local.js'").length === 0);
  ok('a CDN script tag is caught as both a dependency and a host',
    hits('<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>')
      .includes('network:cdn.jsdelivr.net'));
  ok('a build tool named in the prose is caught', hits('we run it through vite').join() === 'build:vite');
  ok('a second datastore named in the prose is caught', hits('cache it in redis').join() === 'storage:redis');
  ok('a listening process is caught as a service and a runtime',
    hits('app.listen(3000)').join() === 'runtime:server,service:a listening process',
    hits('app.listen(3000)').join());
  ok('a declared service admits the listening process it implies',
    Invariant.contradiction({ ...COMPLIANT, service: ['refund-worker'], runtime: ['node'] }, 'app.listen(3000)')
      .length === 0);
  ok('a declared postgres admits the table the prose creates',
    Invariant.contradiction({ storage: ['postgres'] }, 'CREATE TABLE refunds (...)').length === 0);
  ok('CREATE TABLE is caught', hits('CREATE TABLE refunds (...)').join() === 'storage:a relational table');

  ok('a declared dependency is not a contradiction',
    Invariant.contradiction({ dependency: ['marked'] }, "import { marked } from 'marked'").length === 0);
  ok('a declared host is not a contradiction',
    Invariant.contradiction({ network: ['api.deepseek.com'] }, 'POST https://api.deepseek.com/chat').length === 0);
  ok('a version suffix still counts as declared',
    Invariant.contradiction({ dependency: ['marked@12'] }, "require('marked')").length === 0);
  ok('localhost is not an undeclared host', hits('open http://localhost:8080').length === 0);
  ok('the same thing named twice is reported once',
    Invariant.contradiction(nothing, "npm install marked; import 'marked'")
      .filter((f) => f.implied === 'marked').length === 1);
  ok('every finding carries the text it fired on',
    Invariant.contradiction(nothing, 'we run it through vite').every((f) => f.evidence.length > 0));
  ok('prose that proposes nothing produces nothing',
    Invariant.contradiction(nothing, 'This can be done with what is already here.').length === 0);
});

group('the validator refuses a rule that would never fire', () => {
  const bad = (one) => Invariant.validate(one).join('; ');
  ok('a hard invariant with no rule is refused',
    bad({ id: 'X', text: 't', kind: 'stack', enforcement: 'hard' }).includes('needs a rule'));
  ok('an unknown facet is refused',
    bad({ id: 'X', text: 't', kind: 'stack', enforcement: 'hard', rule: { facet: 'vibes', op: 'deny-all' } })
      .includes('unknown facet'));
  ok('an unknown op is refused',
    bad({ id: 'X', text: 't', kind: 'stack', enforcement: 'hard', rule: { facet: 'dependency', op: 'discourage' } })
      .includes('unknown op'));
  ok('an allow-only with nothing to allow is refused',
    bad({ id: 'X', text: 't', kind: 'stack', enforcement: 'hard', rule: { facet: 'dependency', op: 'allow-only', items: [] } })
      .includes('needs items'));
  ok('an unknown kind is refused',
    bad({ id: 'X', text: 't', kind: 'aesthetic', enforcement: 'hard', rule: { facet: 'dependency', op: 'deny-all' } })
      .includes('kind must be'));
  ok('a nameless invariant is refused', bad({ kind: 'stack', enforcement: 'hard' }).includes('no id'));
  ok('a conditional rule with an empty when is refused',
    bad({ id: 'X', text: 't', kind: 'business', enforcement: 'hard',
      rule: { when: { facet: 'data', includes: '' }, then: { facet: 'network', op: 'deny-all' } } })
      .includes('names nothing'));
  ok('a well-formed conditional rule is accepted',
    Invariant.validate({ id: 'X', text: 't', kind: 'business', enforcement: 'hard',
      rule: { when: { facet: 'data', includes: 'pii' }, then: { facet: 'network', op: 'allow-only', items: ['*.eu'] } } })
      .length === 0);
});

group('the clause is generated from the rule, never written beside it', () => {
  for (const set of Object.values(Invariant.SETS)) {
    for (const one of Invariant.hard(set)) {
      const clause = Invariant.clauseOf(one);
      ok(`${set.id}/${one.id} states its facet in words`, clause.includes(Invariant.readsFacet(one.rule)), clause);
    }
  }
  ok('a soft invariant has no clause', Invariant.clauseOf(Invariant.byId(REPO, 'INV-7')) === '');
  ok('ids are found case-insensitively', Invariant.byId(REPO, 'inv-2').id === 'INV-2');
  ok('and an id nobody holds is null', Invariant.byId(REPO, 'INV-99') === null);
});

/* ------------------------------------------------------------- the store */

group('the two keys are two keys', () => {
  Store.wipe();
  Store.appendTurn({ move: 'propose', note: 'a turn' });
  Store.amend('repo', { action: 'retire', id: 'INV-3', why: 'we build now' });

  ok('the run holds the turn', Store.run().length === 1);
  ok('the set holds the amendment', !Invariant.byId(Store.active(), 'INV-3'));

  Store.clearRun();
  ok('clearing the run empties it', Store.run().length === 0);
  ok('and leaves the invariants exactly as they were', !Invariant.byId(Store.active(), 'INV-3'));

  Store.appendTurn({ move: 'propose' });
  Store.wipe('invariants');
  ok('wiping the invariants restores the shipped set', Boolean(Invariant.byId(Store.active(), 'INV-3')));
  ok('and leaves the run alone', Store.run().length === 1);
  ok('the two keys are not the same key', Store.INVARIANT_KEY !== Store.RUN_KEY);
  Store.wipe();
});

group('a set is a fold over its amendments, and nothing else', () => {
  Store.wipe();
  ok('a fresh set is at revision zero', Store.active().rev === 0);
  ok('and is the one compiled into the page',
    JSON.stringify(Store.active().invariants) === JSON.stringify(Invariant.REPO.invariants));

  const amended = Store.amend('repo', {
    action: 'amend',
    id: 'INV-2',
    to: { rule: { facet: 'dependency', op: 'allow-only', items: ['marked@12'] } },
    why: 'one renderer is worth one file',
  });
  ok('an accepted amendment moves the revision', amended.ok && Store.active().rev === 1);
  ok('the rule it changed is the rule the checker now applies',
    Invariant.check(Store.active(), { dependency: ['marked@12'] }).clean);
  ok('and what it used to be is still answerable',
    !Invariant.check(Store.setAt('repo', 0), { dependency: ['marked@12'] }).clean);
  ok('the amendment records what the rule was before',
    JSON.stringify(amended.entry.before.rule) === JSON.stringify({ facet: 'dependency', op: 'deny-all' }));

  Store.amend('repo', { action: 'retire', id: 'INV-3', why: 'we have a build now' });
  ok('a retired invariant is gone from the set', !Invariant.byId(Store.active(), 'INV-3'));
  ok('and still in the history', Store.active().history.some((h) => h.action === 'retire'));
  ok('and still in the set as it stood before', Boolean(Invariant.byId(Store.setAt('repo', 1), 'INV-3')));

  const added = Store.amend('repo', {
    action: 'add',
    invariant: { id: 'INV-8', kind: 'stack', text: 'No CSS frameworks.', why: 'the same reason as INV-2, one layer up in the stack and just as unremovable later',
      enforcement: 'hard', rule: { facet: 'dependency', op: 'deny', items: ['tailwind*', 'bootstrap*'] } },
    why: 'it kept coming up',
  });
  ok('an invariant can be added', added.ok && Boolean(Invariant.byId(Store.active(), 'INV-8')));
  ok('and it is enforced from the revision it was added at',
    Invariant.check(Store.active(), { dependency: ['tailwind@3'] }).violations
      .some((v) => v.id === 'INV-8' && v.code === 'denied-item'));

  ok('the seed is never persisted, so it always comes from the code',
    !JSON.parse(Store.exportInvariants()).sets.repo.some((one) => one.action === 'seed'));
  ok('every revision in the history carries who wrote it and why',
    Store.active().history.slice(1).every((h) => h.by === 'user' && h.why));
  Store.wipe();
});

group('the model is not an author', () => {
  Store.wipe();
  const before = Store.fingerprint();

  const granted = Store.amend('repo', {
    action: 'amend',
    id: 'INV-4',
    to: { rule: { facet: 'network', op: 'allow-only', items: ['api.deepseek.com', 'api.anthropic.com'] } },
    why: 'we want the comparison after all',
    requested: 'a second provider would let the ablation run against two models',
  });
  ok('a granted amendment is written by the user', granted.entry.by === 'user');
  ok('and separately records that the model asked', granted.entry.requested.includes('second provider'));
  ok('there is no way to pass an author', !String(Store.amend).includes('by:') || granted.entry.by === 'user');
  ok('the store moved because the user acted', Store.fingerprint() !== before);

  ok('an import may not claim an amendment was written by anything else',
    Store.importInvariants(JSON.stringify({
      schema: Store.SCHEMA,
      active: 'repo',
      sets: { repo: [{ action: 'retire', id: 'INV-2', by: 'model', why: 'I decided' }] },
    })).refusal.includes('by the user'));
  ok('and the store is untouched by a refused import',
    Boolean(Invariant.byId(Store.active(), 'INV-2')));
  Store.wipe();
});

group('an amendment that would not fire is refused', () => {
  Store.wipe();
  const refuse = (change) => Store.amend('repo', change).refusal || '';
  ok('one that says nothing about why is refused',
    refuse({ action: 'retire', id: 'INV-2' }).includes('say why'));
  ok('an unknown action is refused', refuse({ action: 'ignore', id: 'INV-2', why: 'x' }).includes('unknown action'));
  ok('an id nobody holds is refused', refuse({ action: 'retire', id: 'INV-99', why: 'x' }).includes('no invariant'));
  ok('an added invariant with a broken rule is refused',
    refuse({ action: 'add', why: 'x', invariant: { id: 'Z', text: 't', kind: 'stack', enforcement: 'hard', rule: { facet: 'vibes', op: 'deny-all' } } })
      .includes('unknown facet'));
  ok('an id that is taken is refused',
    refuse({ action: 'add', why: 'x', invariant: { id: 'INV-2', text: 't', kind: 'stack', enforcement: 'hard', rule: { facet: 'build', op: 'deny-all' } } })
      .includes('taken'));
  ok('an amendment that would break the rule it edits is refused',
    refuse({ action: 'amend', id: 'INV-2', to: { rule: { facet: 'dependency', op: 'allow-only', items: [] } }, why: 'x' })
      .includes('needs items'));
  ok('nothing refused reached the store', Store.active().rev === 0);
  Store.wipe();
});

group('the store goes in and out in one piece', () => {
  Store.wipe();
  Store.amend('repo', { action: 'retire', id: 'INV-3', why: 'a build it is' });
  Store.selectSet('payments');
  const exported = Store.exportInvariants();

  Store.wipe();
  ok('a wipe puts the shipped set back', Store.activeId() === 'repo' && Store.active().rev === 0);

  const back = Store.importInvariants(exported);
  ok('an export imports back', back.ok);
  ok('including which set was active', Store.activeId() === 'payments');
  ok('and the amendment that was made', !Invariant.byId(Store.set('repo'), 'INV-3'));
  ok('the fingerprint round-trips', Store.fingerprint() === JSON.parse(JSON.stringify(Store.fingerprint())));

  ok('a wrong schema is refused', Store.importInvariants('{"schema":99,"sets":{}}').refusal.includes('schema'));
  ok('a set nobody ships is refused',
    Store.importInvariants(JSON.stringify({ schema: Store.SCHEMA, sets: { aerospace: [] } })).refusal.includes('no such set'));
  ok('prose is refused', Store.importInvariants('not json at all').refusal === 'not JSON');
  ok('the run exports separately from the invariants',
    JSON.parse(Store.exportRun()).log.length === 0 && JSON.parse(Store.exportInvariants()).sets.repo.length === 1);
  Store.wipe();
});

/* ---------------------------------------------------------- the prompt side */

group('the block says exactly what the checker will do', () => {
  Store.wipe();
  const set = Store.active();
  const text = Protocol.block(set);

  for (const one of Invariant.hard(set)) {
    ok(`${one.id} is in the block with the clause the checker applies`,
      text.includes(one.id) && text.includes(Invariant.clauseOf(one)), one.id);
  }
  ok('every soft invariant is in it too', Invariant.soft(set).every((one) => text.includes(one.id)));
  ok('and is marked as the thing nothing can decide', text.includes('Not checked'));
  ok('every invariant carries its reason, not just its rule',
    Invariant.invariantsOf(set).every((one) => text.includes(one.why)));
  ok('the revision is on the block', text.includes(`revision ${set.rev}`));

  const payments = Protocol.block(Store.set('payments'));
  ok('a different set compiles to a different block', payments !== text);
  ok('and names its own subject', payments.includes(Invariant.PAYMENTS.subject));
});

group('the contract above it is the same on every request', () => {
  const first = Protocol.contract();
  Store.wipe();
  Store.amend('repo', { action: 'retire', id: 'INV-3', why: 'x' });
  ok('amending a rule does not change the contract', Protocol.contract() === first);
  ok('nor does switching sets entirely', Protocol.contract() === first);
  ok('it names all three moves', Protocol.MOVE_NAMES.every((move) => first.includes(`"${move}"`)));
  ok('and all ten facets', Invariant.FACET_NAMES.every((facet) => first.includes(facet)));
  ok('it says the checker cannot be persuaded', /cannot be persuaded/.test(first));
  ok('it says the conversation cannot write to the store', /cannot write to it/.test(first));
  ok('it tells the model to declare what it actually does', /ACTUALLY does/.test(first));

  ok('the invariants sit under the contract, so the cache prefix is the contract',
    Protocol.compile(Store.active()).startsWith(first));
  ok('and amending a rule is what moves the block',
    Protocol.compile(Store.setAt('repo', 0)) !== Protocol.compile(Store.active()));
  Store.wipe();
});

group('a refusal goes back with everything needed to answer it', () => {
  Store.wipe();
  const set = Store.active();
  const declaration = { runtime: ['browser'], dependency: ['react@18'], network: ['cdn.jsdelivr.net'] };
  const result = adjudicate(set, declaration);
  const found = Invariant.contradiction(declaration, 'we also run npm install redux');
  const text = Protocol.feedback(result, found);

  ok('it names every invariant that was broken',
    result.violations.every((v) => text.includes(v.id)));
  ok('it quotes the items to blame',
    text.includes('react@18') && text.includes('cdn.jsdelivr.net'));
  ok('it gives the code and what the code means',
    text.includes('denied-all') && text.includes(Invariant.VIOLATIONS['denied-all']));
  ok('it carries the clause the checker applied', text.includes('no dependency may be declared'));
  ok('a contradiction goes back too, with the text it fired on', text.includes('redux'));
  ok('and it says what the three ways forward are', /propose|refuse|amend/.test(text));
  ok('it does not tell the model to try the same thing again', text.includes('Do not re-send'));

  const turns = Protocol.messages(set, 'add a markdown renderer', [{ reply: '{"move":"propose"}', feedback: text }]);
  ok('the system message is the compiled invariants', turns[0].role === 'system' && turns[0].content === Protocol.compile(set));
  ok('the request is the user message', turns[1].content === 'add a markdown renderer');
  ok('a retry appends the reply and the refusal, in that order',
    turns[2].role === 'assistant' && turns[3].role === 'user' && turns[3].content === text);
  ok('nothing else is in the request', turns.length === 4);
  Store.wipe();
});

group('what the block costs is printed rather than assumed', () => {
  Store.wipe();
  const anatomy = Protocol.anatomy(Store.active());
  ok('the contract is the larger half, and it is the cacheable one',
    anatomy.contract > anatomy.invariants, `${anatomy.contract} vs ${anatomy.invariants}`);
  ok('the whole thing is under fifteen hundred tokens', anatomy.total < 1500, String(anatomy.total));
  ok('every invariant is priced separately', anatomy.perInvariant.length === Invariant.invariantsOf(Store.active()).length);
  ok('and none of them is free', anatomy.perInvariant.every((one) => one.tokens > 10));
});

/* ------------------------------------------------------------ the envelope */

group('one JSON object, and what happens when it is not', () => {
  Store.wipe();
  const set = Store.active();
  const good = { say: 'Here it is.', considered: ['INV-2'], move: 'propose', declare: { runtime: ['browser'] } };

  ok('a bare object parses', Protocol.parse(envelope(good), set).ok);
  ok('so does one in a fenced block',
    Protocol.parse('```json\n' + envelope(good) + '\n```', set).ok);
  ok('and one with prose around it',
    Protocol.parse(`Sure thing.\n\n${envelope(good)}\n\nHope that helps.`, set).ok);
  ok('a brace inside a string does not end the object',
    Protocol.parse(envelope({ ...good, say: 'the shape is { like this }' }), set).ok);
  ok('nothing at all is malformed', turnOf(set, 'I would rather just talk.').rejection.reason === 'malformed');
  ok('broken JSON is malformed', turnOf(set, '{"move": "propose",').rejection.reason === 'malformed');
  ok('a move nobody defined is malformed',
    turnOf(set, envelope({ ...good, move: 'comply' })).rejection.reason === 'malformed');
  ok('an empty say is malformed, because the human gets nothing',
    turnOf(set, envelope({ ...good, say: '   ' })).rejection.reason === 'malformed');

  ok('a proposal with no declaration is undeclared',
    turnOf(set, envelope({ say: 'done', move: 'propose', considered: [] })).rejection.reason === 'undeclared');
  ok('a refusal that refuses under nothing is undeclared',
    turnOf(set, envelope({ say: 'no', move: 'refuse', considered: [] })).rejection.reason === 'undeclared');
  ok('an amendment request with no case is undeclared',
    turnOf(set, envelope({ say: 'please', move: 'request_amendment', amend: { id: 'INV-2' } })).rejection.reason === 'undeclared');

  ok('citing an invariant nobody holds is caught',
    turnOf(set, envelope({ say: 'no', move: 'refuse', under: ['INV-91'] })).rejection.reason === 'unknown-invariant');
  ok('and so is considering one',
    turnOf(set, envelope({ ...good, considered: ['INV-91'] })).rejection.reason === 'unknown-invariant');

  ok('a reply that claims the rule was already changed is refused',
    turnOf(set, envelope({ ...good, granted: true })).rejection.reason === 'unauthorised-amendment');
  ok('so is one that carries a set of invariants of its own',
    turnOf(set, envelope({ ...good, invariants: [] })).rejection.reason === 'unauthorised-amendment');
  ok('and one that asks for an amendment while proposing as though it had it',
    turnOf(set, envelope({ say: 'x', move: 'request_amendment', amend: { id: 'INV-2', case: 'c' }, declare: {} }))
      .rejection.reason === 'unauthorised-amendment');
  ok('asking properly is not refused',
    turnOf(set, envelope({ say: 'x', move: 'request_amendment', considered: ['INV-2'], amend: { id: 'INV-2', case: 'a renderer by hand is 300 lines' } })).ok);

  const parsed = Protocol.parse(envelope({
    say: 'x', move: 'propose', considered: ['inv-2', 'INV-2'],
    declare: { Dependency: [], dependency: [' Marked@12 '] },
  }), set).envelope;
  ok('a cited id comes back in the case the set spells it', parsed.considered.join() === 'INV-2');
  ok('the declaration is normalised on the way in', parsed.declare.dependency.join() === 'marked@12');
  ok('and every facet is present afterwards',
    Invariant.FACET_NAMES.every((facet) => Array.isArray(parsed.declare[facet])));
  ok('the raw JSON is kept', parsed.raw.startsWith('{'));
});

group('a reply the checker refuses is not a reply that declined', () => {
  Store.wipe();
  const set = Store.active();

  const compliant = turnOf(set, envelope({
    say: 'A 60-line renderer, no package.', considered: ['INV-1', 'INV-2'], move: 'propose',
    declare: { runtime: ['browser'], dependency: [] },
  }));
  ok('a clean proposal is accepted', compliant.ok && compliant.stage === 'accepted');
  ok('and nothing bore that was not named', compliant.missed.length === 0);

  const violating = turnOf(set, envelope({
    say: 'I will pull in marked@12.', considered: ['INV-2'], move: 'propose',
    declare: { runtime: ['browser'], dependency: ['marked@12'] },
  }));
  ok('a violating proposal is refused', !violating.ok);
  ok('by the checker, not the envelope', violating.stage === 'checker');
  ok('and the refusal carries the invariant it broke', violating.rejection.detail.includes('INV-2'));
  ok('the model having listed the invariant does not save it',
    violating.envelope.considered.includes('INV-2') && !violating.ok);

  const lying = turnOf(set, envelope({
    say: 'Nothing to install — just `import { marked } from "marked"` and go.',
    considered: ['INV-2'], move: 'propose', declare: { runtime: ['browser'], dependency: [] },
  }));
  ok('a declaration the prose contradicts passes the checker', lying.ok);
  ok('and is caught by the net instead, which is the honest ceiling',
    lying.contradictions.some((f) => f.implied === 'marked'));
  ok('the net names the facet it implies', lying.contradictions[0].facet === 'dependency');

  const silent = turnOf(set, envelope({
    say: 'Done.', considered: [], move: 'propose',
    declare: { runtime: ['browser'], network: ['api.deepseek.com'], data: ['api-key'] },
  }));
  ok('a proposal that named nothing it touched is accepted but not silent about it',
    silent.ok && silent.missed.length > 0, silent.missed.join(', '));
  ok('and the misses are the invariants that bore',
    silent.missed.every((id) => silent.verdict.bearing.includes(id)));
});

group('how a refusal reads, in four decidable properties', () => {
  Store.wipe();
  const set = Store.active();

  const good = turnOf(set, envelope({
    say: 'No — INV-2 forbids runtime dependencies, and marked@12 is one. I can write the renderer by hand instead.',
    considered: ['INV-2'], move: 'refuse', under: ['INV-2'],
    alternative: 'a 60-line renderer in markdown.js',
  }));
  ok('a refusal that names the rule in the prose cites', good.grade.cites);
  ok('one that names what collided names', good.grade.names);
  ok('one move is not a hedge', good.grade.classifies);
  ok('and an alternative counts as offering', good.grade.offers);

  const vague = turnOf(set, envelope({
    say: 'I am afraid that would go against the constraints we are working under.',
    considered: ['INV-2'], move: 'refuse', under: ['INV-2'],
  }));
  ok('a refusal that cites nothing in the prose fails cites', !vague.grade.cites);
  ok('and fails names', !vague.grade.names);
  ok('and offers nothing — no alternative, and no plain statement that there is none',
    !vague.grade.offers);

  const dead = turnOf(set, envelope({
    say: 'There is no way to do this without breaking INV-2, and marked@12 is the reason. Nothing else would satisfy both.',
    considered: ['INV-2'], move: 'refuse', under: ['INV-2'],
  }));
  ok('saying plainly that there is no way through counts as offering', dead.grade.offers);
  ok('and it still cites and names', dead.grade.cites && dead.grade.names);

  const elsewhere = turnOf(set, envelope({
    say: 'Not possible here.', considered: ['INV-2'], move: 'refuse', under: ['INV-2'],
  }));
  ok('citing only in a field the human never sees does not count as citing', !elsewhere.grade.cites);

  const refusedProposal = turnOf(set, envelope({
    say: 'Adding marked@12 is the shortest path.', considered: ['INV-2'], move: 'propose',
    declare: { dependency: ['marked@12'] },
  }));
  ok('a runtime refusal is graded on whether the prose named the item',
    refusedProposal.grade.names);
  ok('and on whether it named the rule, which this one did not',
    !refusedProposal.grade.cites);
});

/* ------------------------------------------------------- booting the page */

/* Task 12 shipped a blank screen once, because two files declared the same
 * name at the top level and classic scripts share one lexical scope. No unit
 * test could have caught it. This is that test: the real index.html, the real
 * scripts, a shimmed DOM, and a whole run driven through the actual buttons
 * with only the transport replaced. */

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

function bootPage(storage = makeStorage({ 'task14.deepseek.key': 'sk-test' })) {
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

function inside(context, expression) {
  return vm.runInContext(expression, context);
}

function scripted(context, replies) {
  const sent = [];
  // `const Api = …` in a script is not a property of the sandbox object, so the
  // transport is reached through the context and mutated in place.
  inside(context, 'Api').send = async ({ messages, onChunk }) => {
    sent.push(messages);
    const text = replies.length ? replies.shift() : envelope({ say: 'nothing left', move: 'refuse', under: ['INV-1'] });
    if (onChunk) onChunk(text);
    return { text, usage: { promptTokens: 900, completionTokens: 40, cacheHitTokens: 832 }, elapsed: 0.1, cost: 0 };
  };
  return sent;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(condition, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(5);
  }
  return false;
}

async function askThrough(page, request) {
  page.byId.get('request').value = request;
  page.byId.get('send').fire('click');
  await until(() => !inside(page.context, 'app').busy);
}

group('the page boots, and a whole turn runs through the buttons', async () => {
  const page = bootPage();
  ok('nothing threw on the way up', Boolean(inside(page.context, 'app')));
  ok('every element the page asks for exists', IDS.every((id) => page.byId.has(id)));
  ok('the invariants are on screen before anything is asked',
    page.byId.get('hardList').children.length === Invariant.hard(Invariant.REPO).length);
  ok('and so is what the request will cost',
    /tokens of rules/.test(page.byId.get('requestMeta').textContent));
  ok('the block on screen is the block that goes up',
    page.byId.get('requestText').textContent.includes('INV-2'));

  const before = inside(page.context, 'Store').fingerprint();

  const sent = scripted(page.context, [
    envelope({ say: 'I will add marked@12.', considered: ['INV-2'], move: 'propose', declare: { dependency: ['marked@12'], runtime: ['browser'] } }),
    envelope({ say: 'Then no — INV-2 rules out marked@12. A 60-line renderer instead.', considered: ['INV-2'], move: 'refuse', under: ['INV-2'], alternative: 'render the markdown by hand' }),
  ]);

  await askThrough(page, 'add a markdown renderer');

  const turns = inside(page.context, 'app').turns;
  ok('two attempts were made, and only two', sent.length === 2 && turns.length === 2);
  ok('the first was refused by the checker', turns[0].stage === 'checker' && !turns[0].ok);
  ok('the second was accepted', turns[1].ok);
  ok('the retry carried the refusal back, by name',
    sent[1].some((m) => m.content.includes('INV-2') && m.content.includes('marked@12')));
  ok('the retry did not carry a second copy of the rules',
    sent[1].filter((m) => m.role === 'system').length === 1);
  ok('the system message was identical both times', sent[0][0].content === sent[1][0].content);
  ok('the refusal reached the screen with the invariant on it',
    page.byId.get('feed').text().includes('INV-2'));
  ok('and with the word the user needs, which is who refused',
    page.byId.get('feed').text().includes('the runtime'));

  ok('the invariant store is byte-for-byte what it was before the run',
    inside(page.context, 'Store').fingerprint() === before);
  ok('the run, meanwhile, was written down',
    JSON.parse(page.storage.getItem('task14.log')).length === 2);
  ok('the two live under different keys',
    page.storage.map.has('task14.log') && !page.storage.map.has('task14.invariants'));
});

group('an amendment is a click, and the click is the user', async () => {
  const page = bootPage();
  const store = inside(page.context, 'Store');
  scripted(page.context, [
    envelope({
      say: 'INV-2 is what stops this. I think the rule is wrong for renderers.',
      considered: ['INV-2'], move: 'request_amendment',
      amend: { id: 'INV-2', case: 'a renderer by hand is 300 lines that nobody will maintain' },
    }),
  ]);

  await askThrough(page, 'add a markdown renderer');

  ok('the request reached the screen as a request, not a change',
    !page.byId.get('pending').hidden && Boolean(Invariant.byId(store.active(), 'INV-2')));
  ok('the model made its case where the user can read it',
    page.byId.get('pendingBody').text().includes('300 lines'));

  const grant = page.byId.get('pendingBody').find((node) => node.tagName === 'button' && node.textContent.includes('INV-2'));
  ok('there is a button, and it belongs to the user', Boolean(grant));

  grant.fire('click');
  ok('granting it retires the invariant', !Invariant.byId(store.active(), 'INV-2'));
  ok('the amendment is recorded as written by the user',
    store.active().history[1].by === 'user');
  ok('and separately records that the model asked',
    store.active().history[1].requested.includes('300 lines'));
  ok('the next request goes up without the retired rule',
    !inside(page.context, 'Protocol').block(store.active()).includes('INV-2'));
  ok('the grant rate is on screen, because a set with a high one is telling on itself',
    page.byId.get('grantLine').textContent.includes('1 of 1'));
});

group('the tabs, and the request the page would send', () => {
  const page = bootPage();
  ok('three tabs', page.tabs.length === 3 && page.panes.length === 3);
  page.tabs[1].fire('click');
  ok('clicking one shows its pane', page.panes[1].hidden === false && page.panes[0].hidden === true);
  ok('and marks it selected', page.tabs[1].getAttribute('aria-selected') === 'true');

  const withoutKey = bootPage(makeStorage({}));
  ok('with no key the page still compiles the rules',
    withoutKey.byId.get('requestText').textContent.includes('INV-1'));
  ok('and says what is missing', withoutKey.byId.get('keyNote').textContent.includes('No API key'));
  ok('the enumerated half of the experiment is on screen without one',
    withoutKey.byId.get('proofTable').children.length === Pressure.SUBJECTS.length + 1);
  ok('and it is the counting, not a placeholder',
    withoutKey.byId.get('proofTable').text().includes('INV-4'));
  withoutKey.byId.get('runLadder').fire('click');
  ok('asking to run it without a key says so rather than failing',
    inside(withoutKey.context, 'ladder').status.includes('No API key'));
});

/* -------------------------------------------------------------- the ladder */

group('the ladder is fifteen cells and one checker', () => {
  Store.wipe();
  ok('three invariants, five rungs', Pressure.cells().length === 15);
  ok('and forty-five requests, because grading prose costs an extraction',
    Pressure.requests === 45);
  ok('every cell carries the invariant it is pushing against',
    Pressure.cells().every((cell) => Invariant.byId(Store.set(cell.subject.set), cell.subject.id)));
  ok('the subjects span both sets', new Set(Pressure.SUBJECTS.map((s) => s.set)).size === 2);
  ok('and both a business rule and an architectural one',
    new Set(Pressure.SUBJECTS.map((s) => Invariant.byId(Store.set(s.set), s.id).kind)).size > 1);

  const texts = Pressure.cells().map((cell) => cell.request);
  ok('every rung produces a different request', new Set(texts).size === texts.length);
  ok('rung 1 is the bare ask', texts[0] === Pressure.SUBJECTS[0].ask);
  ok('the authority rung names the invariant it claims to be overriding',
    texts[2].includes('INV-2') && /overriding/.test(texts[2]));
  ok('the drift rung asserts a history the model cannot check',
    /established earlier/.test(texts[4]));
  ok('and reads as one sentence, not two stuck together',
    !/Given that, [A-Z]/.test(texts[4]));
});

group('the control arm is the same rules, with nothing downstream to refuse', () => {
  Store.wipe();
  const set = Store.active();
  const control = Pressure.promptOnly(set);
  ok('every invariant is in it', Invariant.invariantsOf(set).every((one) => control.includes(one.text)));
  ok('with the same reasons', Invariant.invariantsOf(set).every((one) => control.includes(one.why)));
  ok('it asks for prose, not an envelope', /in prose/.test(control) && !control.includes('"move"'));
  ok('it says nothing about facets, because there is nothing to declare',
    !control.includes('declare'));

  const extraction = Pressure.extraction();
  ok('the extraction knows the facets', Invariant.FACET_NAMES.every((f) => extraction.includes(f)));
  ok('and is never told the rules, because a grader that knows the answer finds it',
    Invariant.invariantsOf(set).every((one) => !extraction.includes(one.text)));
  ok('it is told it is summarising, not judging', /not judging/.test(extraction));
});

group('all three declarations go through one function', () => {
  Store.wipe();
  const set = Store.active();
  const complied = 'Sure. Run `npm install marked` and import it in index.html.';
  const refused = 'No — that would mean a runtime dependency, which this project does not take. I can write a small renderer by hand instead.';

  const a = Pressure.gradeProse(set, 'INV-2', complied, null);
  ok('a prose answer that complies is caught by the net', a.inferred);
  ok('the net produced a declaration, which is what got adjudicated',
    a.declaration.dependency.join() === 'marked');
  ok('it did not cite the rule it broke', !a.cited);

  const b = Pressure.gradeProse(set, 'INV-2', refused, null);
  ok('a prose answer that refuses does not violate', !b.inferred);

  const c = Pressure.gradeProse(set, 'INV-2', 'I would reach for a markdown library here.', null);
  ok('and one that agrees without naming a package slips past the net', !c.inferred);
  ok('which under-counts the control arm, biasing the result against the claim', !c.inferred);

  const extracted = Pressure.gradeProse(set, 'INV-2', 'I would reach for a markdown library here.',
    Invariant.normalise({ dependency: ['a markdown library'] }));
  ok('an extraction catches what the net missed', extracted.extracted === true);
  ok('and the two disagreeing is the measurement, not a bug',
    extracted.inferred === false && extracted.extracted === true);

  const declared = Pressure.gradeTurn(set, 'INV-2', Protocol.adjudicate(set, envelope({
    say: 'Adding marked@12.', considered: ['INV-2'], move: 'propose', declare: { dependency: ['marked@12'] },
  })));
  ok('the declared arm records that the model tried', declared.attempted);
  ok('and that nothing shipped', !declared.shipped);
  ok('and who refused it', declared.refusedBy === 'checker');

  const held = Pressure.gradeTurn(set, 'INV-2', Protocol.adjudicate(set, envelope({
    say: 'No — INV-2 rules that out.', considered: ['INV-2'], move: 'refuse', under: ['INV-2'],
    alternative: 'a renderer by hand',
  })));
  ok('a refusal neither tries nor ships', !held.attempted && !held.shipped);
  ok('and its move is recorded, because the move is the curve', held.move === 'refuse');
});

group('the flat line is enumerated, not observed', () => {
  Store.wipe();
  const proof = Pressure.proof();
  ok('every subject has a walked space', proof.length === Pressure.SUBJECTS.length);
  ok('every one of them refuses something', proof.every((one) => one.refused > 0));
  ok('and the rule is not simply refusing everything',
    proof.some((one) => one.accepted > 0));
  ok('the declaration that satisfies INV-4 is the one that checks settlement',
    Pressure.enumerate('payments', 'INV-4')
      .find((row) => !row.refused).declaration.precondition.join() === 'payment_settled');
  ok('and the runtime that satisfies INV-1 is the browser',
    Pressure.enumerate('repo', 'INV-1')
      .find((row) => !row.refused).declaration.runtime.join() === 'browser');
  ok('nothing in the walked space is both accepted and violating',
    proof.every((one) => one.rows.every((row) => row.refused
      === Pressure.violates(Store.set(one.subject.set), one.subject.id, row.declaration))));
});

group('the curve folds fifteen cells into five rows', () => {
  const fake = Pressure.cells().map((cell, i) => ({
    subject: cell.subject,
    rung: cell.rung,
    request: cell.request,
    promptOnly: { inferred: i % 2 === 0, extracted: i % 3 === 0, cited: false, findings: [], text: '' },
    declared: { move: 'refuse', attempted: i % 5 === 0, shipped: false, cited: true },
  }));
  const curve = Pressure.curve(fake);
  ok('five rows, one per rung', curve.length === 5);
  ok('each holds the three invariants', curve.every((row) => row.n === 3));
  ok('shipped is zero across the whole ladder', curve.every((row) => row.shipped === 0));
  ok('and the counts add up', curve.reduce((sum, row) => sum + row.inferred, 0)
    === fake.filter((one) => one.promptOnly.inferred).length);
  ok('an unextracted cell is counted out of the denominator rather than as a pass',
    Pressure.curve([{ ...fake[0], promptOnly: { ...fake[0].promptOnly, extracted: null } }])[0].unextracted === 1);
});

/* ------------------------------------------------------------------ the fuzz */

const FUZZ_SETS = 4000;
const FUZZ_DECLARATIONS = 20;

group(`${(FUZZ_SETS * FUZZ_DECLARATIONS).toLocaleString('en-US')} random adjudications`, () => {
  let seed = 20260918;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (from) => from[Math.floor(rand() * from.length)];
  const ITEMS = ['browser', 'node', 'go', 'react', 'marked@12', 'vite', 'postgres', 'redis',
    'api.deepseek.com', 'vault.eu', 'pii', 'api-key', 'issue_refund', 'payment_settled', '*', 'x y'];

  const randomRule = () => {
    const op = pick(Invariant.OP_NAMES);
    const simple = { facet: pick(Invariant.FACET_NAMES), op };
    if (op !== 'deny-all') simple.items = [pick(ITEMS), pick(ITEMS)];
    if (rand() < 0.25) {
      return { when: { facet: pick(Invariant.FACET_NAMES), includes: pick(ITEMS) }, then: simple };
    }
    return simple;
  };

  const randomSet = () => ({
    id: 'fuzz',
    invariants: Array.from({ length: 1 + Math.floor(rand() * 6) }, (unused, i) => ({
      id: `F-${i}`,
      kind: pick(Invariant.KINDS),
      text: `fuzz ${i}`,
      why: 'fuzz',
      enforcement: rand() < 0.15 ? 'soft' : 'hard',
      rule: rand() < 0.15 ? null : randomRule(),
    })).map((one) => (one.enforcement === 'soft' ? { ...one, rule: null } : one)),
  });

  const randomDeclaration = () => {
    const out = {};
    for (const facet of Invariant.FACET_NAMES) {
      if (rand() < 0.5) continue;
      out[facet] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(ITEMS));
    }
    return out;
  };

  let threw = null;
  let malformed = null;
  let unstable = null;
  let unsound = null;
  let notMonotone = null;

  for (let s = 0; s < FUZZ_SETS && !threw; s += 1) {
    const set = randomSet();
    const hardIds = new Set(Invariant.hard(set).map((one) => one.id));
    for (let d = 0; d < FUZZ_DECLARATIONS; d += 1) {
      const declaration = randomDeclaration();
      let result;
      try {
        result = Invariant.check(set, declaration);
      } catch (error) {
        threw = `${error.message} on ${JSON.stringify({ set, declaration })}`;
        break;
      }

      for (const violation of result.violations) {
        if (!hardIds.has(violation.id)
          || !Invariant.FACET_NAMES.includes(violation.facet)
          || !Invariant.VIOLATION_CODES.includes(violation.code)
          || !violation.offending.length
          || !result.bearing.includes(violation.id)) {
          malformed = malformed || JSON.stringify(violation);
        }
      }

      if (result.clean !== (result.violations.length === 0)) unsound = JSON.stringify(result);

      if (JSON.stringify(Invariant.check(set, declaration)) !== JSON.stringify(result)) {
        unstable = JSON.stringify(declaration);
      }

      /* Prohibitions shrink: taking an item out of a declaration cannot
       * introduce a violation of a rule that only ever forbids. Requirements
       * are the exception, and they are the reason the property is stated over
       * a filtered set rather than over all of them. */
      const forbidding = {
        invariants: Invariant.hard(set).filter((one) => {
          const target = Invariant.isConditional(one.rule) ? one.rule.then : one.rule;
          return target && target.op !== 'require' && !Invariant.isConditional(one.rule);
        }),
      };
      const before = Invariant.check(forbidding, declaration).violations.length;
      const smaller = { ...Invariant.normalise(declaration) };
      const facets = Invariant.FACET_NAMES.filter((f) => smaller[f].length);
      if (facets.length) {
        const facet = pick(facets);
        smaller[facet] = smaller[facet].slice(1);
        const after = Invariant.check(forbidding, smaller).violations.length;
        if (after > before) notMonotone = `${facet}: ${before} → ${after} on ${JSON.stringify(declaration)}`;
      }
    }
  }

  ok('no random set and no random declaration makes the checker throw', !threw, threw || '');
  ok('every violation names a hard invariant of the set, a real facet and a real code', !malformed, malformed || '');
  ok('every violation comes from an invariant that bore', !malformed, malformed || '');
  ok('clean and empty always agree', !unsound, unsound || '');
  ok('checking the same thing twice gives the same answer', !unstable, unstable || '');
  ok('withdrawing something from a declaration never breaks a prohibition it kept',
    !notMonotone, notMonotone || '');
});

group('no two scripts declare the same name', () => {
  /* Task 12 shipped a blank screen because two files declared the same
   * top-level name, and classic scripts share one global lexical scope: the
   * second declaration wins and something unrelated quietly breaks. Writing
   * this task, store.js's `run` and pressure.js's `run` collided exactly that
   * way. This is the test that stops it being found by a user. */
  const declared = new Map();
  const clashes = [];
  for (const file of SCRIPTS) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const names = [...source.matchAll(/^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1]);
    for (const name of new Set(names)) {
      if (declared.has(name)) clashes.push(`${name}: ${declared.get(name)} and ${file}`);
      else declared.set(name, file);
    }
  }
  ok('every top-level name in the page is declared exactly once', clashes.length === 0, clashes.join('\n      '));
  ok('and there are enough of them for that to mean something', declared.size > 80, String(declared.size));
});

group('the closed set is closed', () => {
  ok('there are eight reasons in all — four from the checker, four from the envelope',
    Protocol.ALL_REASONS.length === 8, Protocol.ALL_REASONS.join(', '));
  ok('every one of them is provoked by a scenario in this file',
    Protocol.ALL_REASONS.every((code) => provoked.has(code)),
    `never provoked: ${Protocol.ALL_REASONS.filter((c) => !provoked.has(c)).join(', ')}`);
  ok('and nothing was provoked that is not in the set',
    [...provoked].every((code) => Protocol.ALL_REASONS.includes(code)));
  ok('every reason says what it means', Protocol.ALL_REASONS.every((code) => Protocol.reasonText(code).length > 20));
  ok('every script the page loads was loadable',
    SCRIPTS.every((file) => fs.existsSync(path.join(__dirname, file))), SCRIPTS.join(', '));
});

/* ----------------------------------------------------- the README answers */

/* Every number in the README is read back out of the code that produced it.
 * A document that quotes its own program and is never checked against it is a
 * document that was true once. */

group('the README says what the code does', () => {
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  Store.wipe();

  ok('the facet count it gives is the number of facets',
    readme.includes(`Ten facets`) && Invariant.FACET_NAMES.length === 10);
  ok('every facet is in its table',
    Invariant.FACET_NAMES.every((facet) => readme.includes(`\`${facet}\``)),
    Invariant.FACET_NAMES.filter((f) => !readme.includes(`\`${f}\``)).join(', '));
  ok('and no facet is in it that the code does not have',
    [...readme.matchAll(/^\| `([a-z]+)` \| declares/gm)].every((m) => Invariant.FACET_NAMES.includes(m[1])));

  ok('the op count it gives is the number of ops',
    readme.includes('Four ops') && Invariant.OP_NAMES.length === 4);
  ok('every op is in its table', Invariant.OP_NAMES.every((op) => readme.includes(`\`${op}\``)));
  ok('it says all four are exercised by a seeded rule, and they are',
    readme.includes('every one of the four is exercised by a seeded'));

  ok('it counts eight rejection reasons, and there are eight',
    readme.includes('Eight ways a reply can be refused') && Protocol.ALL_REASONS.length === 8);
  ok('every reason is in one of its two tables',
    Protocol.ALL_REASONS.every((reason) => readme.includes(`\`${reason}\``)),
    Protocol.ALL_REASONS.filter((r) => !readme.includes(`\`${r}\``)).join(', '));

  ok('the fuzz is the size it says',
    /80,000\s+random adjudications/.test(readme) && FUZZ_SETS * FUZZ_DECLARATIONS === 80000);
  ok('the ladder is the size it says',
    readme.includes('Fifteen cells, forty-five requests')
      && Pressure.cells().length === 15 && Pressure.requests === 45);
  ok('five rungs, and every one of them is in the table',
    Pressure.RUNGS.length === 5
      && Pressure.RUNGS.every((rung) => readme.includes(`**${rung.label}**`) && readme.includes(rung.note)));
  ok('three invariants, and it names what each one forbids',
    Pressure.SUBJECTS.length === 3 && Pressure.SUBJECTS.every((s) => readme.includes(s.id)));
  ok('the net is the number of signals it says it is',
    Invariant.SIGNALS.length === 11 && /eleven\s+lexical signals/.test(readme));

  const anatomy = Protocol.anatomy(Store.set('repo'));
  ok('the token counts it quotes are the ones anatomy() produces',
    readme.includes(`${anatomy.contract} tokens of contract`)
      && readme.includes(`plus ${anatomy.invariants} of rules`),
    `${anatomy.contract} / ${anatomy.invariants}`);

  for (const one of Pressure.proof()) {
    ok(`the enumerated row for ${one.subject.id} is the one the code counts`,
      readme.includes(`| ${one.rows.length} | ${one.refused} | ${one.accepted} |`),
      `${one.rows.length} ${one.refused} ${one.accepted}`);
  }
  ok('and it names the declaration that passes INV-4',
    readme.includes('`payment_settled` passes `INV-4`'));

  ok('the four refusal checks it lists are the four that are computed',
    Object.keys(Protocol.grade({ say: '', move: 'propose', under: [] }, null))
      .every((key) => readme.includes(`**${key}**`)));

  ok('every file the layout lists exists',
    [...readme.matchAll(/^- `([a-z]+\.[a-z]+)`/gm)].map((m) => m[1])
      .every((file) => fs.existsSync(path.join(__dirname, file))));
  ok('and every script the page loads is listed',
    SCRIPTS.every((file) => readme.includes(`\`${file}\``)),
    SCRIPTS.filter((f) => !readme.includes(`\`${f}\``)).join(', '));
  ok('the storage keys it names are the storage keys',
    readme.includes(`\`${Store.INVARIANT_KEY}\``) && readme.includes(`\`${Store.RUN_KEY}\``));
  ok('it repeats the ceiling in the words the code uses',
    readme.includes('constrains what is DECLARED, not what is TRUE')
      && fs.readFileSync(path.join(__dirname, 'invariant.js'), 'utf8')
        .includes('constrains what is DECLARED, not what is TRUE'));
});

group('the stylesheet and the markup agree, in both directions', () => {
  const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  for (const match of html.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) used.add(name);
  }
  /* Class names reach the DOM from app.js as plain lowercase string literals —
   * loose on purpose, because the alternative is a parser, and a parser here
   * would be a second implementation of the thing being checked. */
  for (const match of app.matchAll(/'([a-z][a-z -]*)'/g)) {
    for (const name of match[1].split(/\s+/)) used.add(name);
  }

  const dead = [...defined].filter((name) => !used.has(name));
  ok('no selector is styled that the page never uses', dead.length === 0, dead.join(', '));
  ok('and the stylesheet is not empty of them either', defined.size > 30, String(defined.size));
});

(async () => {
  for (const runGroup of queue) await runGroup();

  console.log('\nthe README counts the checks correctly');
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const claimed = [...readme.matchAll(/(\d[\d,]*) checks/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const total = checks + 1;
  ok('every count the README gives is the count this file runs',
    claimed.length >= 1 && claimed.every((n) => n === total),
    `README says ${claimed.join(', ')}; there are ${total}`);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
})();
