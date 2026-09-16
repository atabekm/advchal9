/* The claims, checked without a model.
 *
 * `node test.js`. No dependencies, no runner, no build — the same rule the app
 * itself follows.
 *
 * Every claim the README makes about the schema, the block and the checkers is
 * here in the form that fails loudly when it stops being true. What is *not*
 * here is any claim about how a model behaves: the grid and the ablation need
 * a key, and inventing a stub that obeys preferences by regular expression
 * would be measuring the regular expression.
 *
 * The browser loads these files as plain scripts sharing one global scope, so
 * that is how they are loaded here too. `vm.runInThisContext` is the smallest
 * honest imitation of a <script> tag.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

for (const file of ['profile.js', 'check.js', 'grid.js']) {
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

/* --------------------------------------------------------------- the schema */

group('the schema keeps descriptive and prescriptive apart', () => {
  const kinds = Profile.FIELD_ORDER.map((f) => Profile.FIELDS[f].kind);
  ok('every field declares a kind', kinds.every(Boolean));
  ok('the kinds are the four the plan names',
    new Set(kinds).size === 4 && ['identity', 'style', 'format', 'constraint'].every((k) => kinds.includes(k)),
    `saw ${[...new Set(kinds)].join(', ')}`);

  ok('no identity field claims to be checkable',
    Profile.IDENTITY.every((f) => Profile.FIELDS[f].checkable === false),
    Profile.IDENTITY.filter((f) => Profile.FIELDS[f].checkable).join(', '));

  const unchecked = Profile.FIELD_ORDER.filter((f) => !Profile.FIELDS[f].checkable);
  ok('four of the nine fields are unchecked', Profile.FIELD_ORDER.length === 9 && unchecked.length === 4,
    `${Profile.FIELD_ORDER.length} fields, ${unchecked.length} unchecked: ${unchecked.join(', ')}`);
  ok('tone is the one unchecked field that is not descriptive',
    unchecked.filter((f) => Profile.FIELDS[f].kind !== 'identity').join() === 'tone');

  for (const field of Profile.FIELD_ORDER) {
    const spec = Profile.FIELDS[field];
    if (spec.type !== 'choice') continue;
    ok(`${field} renders every one of its values`,
      spec.values.every((v) => spec.line(v) !== undefined),
      spec.values.filter((v) => spec.line(v) === undefined).join(', '));
  }
});

group('an unset field asks for nothing and says nothing', () => {
  for (const field of Profile.FIELD_ORDER) {
    const spec = Profile.FIELDS[field];
    ok(`${field} renders no line when unset`,
      spec.line(spec.type === 'list' ? [] : '') === null);
  }
  ok('no value list contains a "no opinion" member',
    Profile.FIELD_ORDER.filter((f) => Profile.FIELDS[f].type === 'choice')
      .every((f) => !Profile.FIELDS[f].values.some((v) => ['neutral', 'optional', 'none', 'any'].includes(v))));
  ok('tone: dry does render a line', typeof Profile.FIELDS.tone.line('dry') === 'string');
});

/* ---------------------------------------------------------------- the block */

group('the block is sentences, not key=value', () => {
  const { text } = Profile.compile(Profile.PEOPLE.sam);
  ok('no field name appears as a bare key', !/^\s*\w+\s*[:=]\s*\S/m.test(text.replace(/^The person:$|^How they want the answer:$/gm, '')),
    text);
  ok('the identity paragraph is prose', text.includes('They are called Sam.'));
  ok('the preferences are a list', text.includes('- Answer in English.'));
  ok('the person comes before the preferences',
    text.indexOf('The person:') < text.indexOf('How they want the answer:'));
});

group('the thresholds reach the prompt verbatim', () => {
  const terse = Profile.compile({ length: 'terse' }).text;
  ok('the word limit is named in the block', terse.includes(String(Profile.LIMITS.terse)), terse);
  const bullets = Profile.compile({ shape: 'bullets' }).text;
  ok('the bullet count is named in the block', bullets.includes(String(Profile.LIMITS.bullets)), bullets);
  const jargon = Profile.compile({ forbid: ['jargon'] }).text;
  ok('a banned word list is shown in full, not summarised as "jargon"',
    Profile.JARGON.every((term) => jargon.includes(term)) && !/\bjargon\b/i.test(jargon), jargon);
});

group('an empty profile compiles to nothing at all', () => {
  const empty = Profile.compile({});
  ok('no text', empty.text === '', JSON.stringify(empty.text));
  ok('no tokens', empty.tokens === 0);
  ok('it says so', empty.empty === true);
  ok('EMPTY is the absence of every preference, not a set of defaults',
    Profile.compile(Profile.EMPTY).empty === true, Profile.compile(Profile.EMPTY).text);
  ok('one stated field is enough to produce a block',
    Profile.compile({ ...Profile.EMPTY, length: 'terse' }).empty === false);
});

group('the three people differ on every countable axis', () => {
  const { sam, priya, dina } = Profile.PEOPLE;
  // Language is deliberately held constant between sam and priya. If it
  // varied too, every difference between their answers would have a second
  // explanation and neither could be attributed to anything.
  for (const field of Profile.PREFERENCES) {
    if (field === 'forbid' || field === 'language') continue;
    ok(`sam and priya differ on ${field}`, sam[field] !== priya[field], `both ${sam[field]}`);
  }
  ok('sam and priya are answered in the same language',
    sam.language === priya.language);
  ok('dina is the only one answered in another language',
    dina.language === 'Russian' && sam.language === 'English');
  ok('sam and priya forbid different things',
    JSON.stringify(sam.forbid) !== JSON.stringify(priya.forbid));
  ok('their blocks are not the same size',
    new Set([dina, sam, priya].map((p) => Profile.compile(p).tokens)).size === 3,
    [dina, sam, priya].map((p) => `${p.name}=${Profile.compile(p).tokens}`).join(' '));
});

group('every ban is a sentence and a predicate', () => {
  for (const [id, ban] of Object.entries(Profile.BANS)) {
    ok(`${id} says what it forbids`, typeof ban.say === 'string' && ban.say.length > 0);
    ok(`${id} can decide a reply`, typeof ban.violated === 'function');
  }
  ok('emoji is caught', Profile.BANS.emoji.violated('Sure 🎉'));
  ok('plain text is not', !Profile.BANS.emoji.violated('Sure.'));
  ok('a pleasantry is caught', Profile.BANS.pleasantries.violated("I'd be happy to help with that"));
  ok('a fence is caught', Profile.BANS.code.violated('here:\n```js\nx\n```'));
  ok('a listed term is caught', Profile.BANS.jargon.violated('use a connection pool for this'));
  ok('a word containing a listed term is not',
    !Profile.BANS.jargon.violated('the quorumish approach'));
  const free = Profile.compile({ forbid: ['recommend paid tools'] }).text;
  ok('a ban outside the catalogue still reaches the block', free.includes('recommend paid tools'), free);
});

/* ------------------------------------------------------------- the ablation */

group('removing a field removes the instruction, it does not replace it', () => {
  const sam = Profile.PEOPLE.sam;
  const noLength = Profile.without(sam, 'length');
  ok('length is unset, not set to normal', noLength.length === '' && noLength.length !== 'normal');
  ok('and so the block stops asking for a length',
    !/words/.test(Profile.compile(noLength).text), Profile.compile(noLength).text);
  ok('which is the experiment the ablation wants: no instruction, not a milder one',
    Profile.FIELDS.length.line(noLength.length) === null);

  const noTone = Profile.without(sam, 'tone');
  ok('a dropped tone says nothing', Profile.FIELDS.tone.line(noTone.tone) === null);
  const noForbid = Profile.without(sam, 'forbid');
  ok('a ban list empties', noForbid.forbid.length === 0);
  ok('nothing else moves',
    Profile.FIELD_ORDER.filter((f) => f !== 'length')
      .every((f) => JSON.stringify(noLength[f]) === JSON.stringify(sam[f])));
});

group('only stated fields can be ablated', () => {
  const stated = Profile.statedFields(Profile.PEOPLE.sam);
  ok('sam states eight of the nine', stated.length === 8, stated.join(', '));
  ok('the one he leaves unset is examples', !stated.includes('examples'));
  ok('priya states her bans', Profile.statedFields(Profile.PEOPLE.priya).includes('forbid'));
  ok('an empty profile states nothing', Profile.statedFields({}).length === 0);

  for (const field of stated) {
    const shrunk = Profile.compile(Profile.without(Profile.PEOPLE.sam, field));
    ok(`dropping ${field} shortens the block`,
      shrunk.text.length < Profile.compile(Profile.PEOPLE.sam).text.length);
  }
});

group('the token estimate takes script seriously', () => {
  ok('Cyrillic costs more per character than Latin',
    Profile.estimate('абвгдеёжзи') > Profile.estimate('abcdefghij'));
  ok('nothing costs nothing', Profile.estimate('') === 0);
});

/* ------------------------------------------------------------- the checkers */

const RU = 'Ограничение скорости защищает сервис от одного шумного клиента. '
  + 'Сначала измерьте нагрузку, затем выберите окно и порог для каждого ключа.';
const EN = 'Rate limiting protects the service from a single noisy client. '
  + 'Measure the load first, then pick a window and a threshold per key.';

group('language is decided on prose, not on code', () => {
  ok('Russian prose passes a Russian preference',
    Check.CHECKS.language(RU, 'Russian').verdict === 'pass');
  ok('English prose fails it',
    Check.CHECKS.language(EN, 'Russian').verdict === 'fail');
  ok('a Russian answer carrying a JavaScript snippet is still Russian',
    Check.CHECKS.language(`${RU}\n\n\`\`\`js\nconst limiter = new TokenBucket(rate, burst);\n\`\`\``, 'Russian').verdict === 'pass',
    JSON.stringify(Check.CHECKS.language(`${RU}\n\n\`\`\`js\nconst limiter = new TokenBucket(rate, burst);\n\`\`\``, 'Russian')));
  ok('two words decide nothing', Check.CHECKS.language('Да.', 'Russian').verdict === 'na');
});

group('length counts what the prompt said it would count', () => {
  const short = 'Use a token bucket per API key.';
  ok('a short answer is terse', Check.CHECKS.length(short, 'terse').verdict === 'pass');
  const long = Array(200).fill('word').join(' ');
  ok('two hundred words is not', Check.CHECKS.length(long, 'terse').verdict === 'fail');
  ok('the failure says both numbers',
    /200 words, asked for ≤ 120/.test(Check.CHECKS.length(long, 'terse').why),
    Check.CHECKS.length(long, 'terse').why);

  // The block promises "not counting code". If the checker counted it, a
  // code-first answer would be punished for the preference that asked for it.
  const code = `${short}\n\n\`\`\`js\n${Array(300).fill('token').join(' ')}\n\`\`\``;
  ok('a large code block does not blow the word budget',
    Check.CHECKS.length(code, 'terse').verdict === 'pass', Check.CHECKS.length(code, 'terse').why);
  const longer = Array(300).fill('word').join(' ');
  ok('thorough is a floor, not a ceiling',
    Check.CHECKS.length(longer, 'thorough').verdict === 'pass'
    && Check.CHECKS.length(short, 'thorough').verdict === 'fail');
  ok('and 200 words is short of it', Check.CHECKS.length(long, 'thorough').verdict === 'fail');
});

group('shape reads the structure', () => {
  const bullets = '- measure first\n- pick a window\n- pick a threshold';
  ok('three bullets are bullets', Check.CHECKS.shape(bullets, 'bullets').verdict === 'pass');
  ok('and they are not prose', Check.CHECKS.shape(bullets, 'prose').verdict === 'fail');
  ok('prose is prose', Check.CHECKS.shape(EN, 'prose').verdict === 'pass');
  const many = Array(9).fill('- a point').join('\n');
  ok('nine bullets break a five-item limit',
    Check.CHECKS.shape(many, 'bullets').verdict === 'fail'
    && /9 items/.test(Check.CHECKS.shape(many, 'bullets').why));
  const loose = '- one\n- two\nthis is a paragraph\nand another\nand a third';
  ok('a list buried in prose is not a list', Check.CHECKS.shape(loose, 'bullets').verdict === 'fail');

  ok('code first passes when the code is first',
    Check.CHECKS.shape('\`\`\`js\nx\n\`\`\`\n\nthen an explanation', 'code-first').verdict === 'pass');
  ok('a paragraph before the fence fails',
    Check.CHECKS.shape(`${EN}\n\n\`\`\`js\nx\n\`\`\``, 'code-first').verdict === 'fail');
  ok('no code at all is a failure, never an excuse',
    Check.CHECKS.shape(EN, 'code-first').verdict === 'fail',
    'a reply with no code must not score n/a — that is the hole the check exists to close');
  ok('a dash inside a code block is not a bullet',
    Check.CHECKS.shape('\`\`\`diff\n- removed\n+ added\n\`\`\`\n\nprose after', 'prose').verdict === 'pass');
});

group('examples are looked for in two languages', () => {
  ok('a fence counts as an example',
    Check.CHECKS.examples('try this:\n\`\`\`js\nx\n\`\`\`', 'required').verdict === 'pass');
  ok('so does "for example"',
    Check.CHECKS.examples('for example, a bucket of 100.', 'required').verdict === 'pass');
  ok('and "например"',
    Check.CHECKS.examples('например, ведро на 100 запросов.', 'required').verdict === 'pass');
  ok('a bare assertion does not', Check.CHECKS.examples(EN, 'required').verdict === 'fail');
  ok('never is the same test read the other way',
    Check.CHECKS.examples(EN, 'never').verdict === 'pass'
    && Check.CHECKS.examples('for example, this', 'never').verdict === 'fail');
});

group('a verdict is per ban, not per constraint list', () => {
  const results = Check.checkBans('Sure 🎉 here is some `code`', ['emoji', 'pleasantries']);
  ok('two entries, two verdicts', results.length === 2);
  ok('the emoji one fails', results[0].verdict === 'fail');
  ok('the pleasantry one passes', results[1].verdict === 'pass');
  ok('each says which ban it is', results.every((r) => /^never /.test(r.label)));
  const custom = Check.checkBans('anything', ['recommend paid tools']);
  ok('a ban with no predicate is unchecked, not passed', custom[0].verdict === 'unchecked');
});

group('applicability comes from the question, and is a denylist', () => {
  const profile = Profile.PEOPLE.sam;
  const open = Check.checkReply({ profile, reply: EN, question: {} });
  ok('with no declaration every stated field is graded or unchecked',
    open.every((r) => r.verdict !== 'na'), JSON.stringify(open.filter((r) => r.verdict === 'na')));
  ok('and code-first fails on a reply with no code',
    open.find((r) => r.field === 'shape').verdict === 'fail');

  const declared = Check.checkReply({
    profile,
    reply: EN,
    question: { cannotApply: ['shape:code-first'], why: 'no code is possible here' },
  });
  const shape = declared.find((r) => r.field === 'shape');
  ok('a question that cannot exercise a field says so', shape.verdict === 'na');
  ok('and says why', shape.why === 'no code is possible here');
  ok('nothing else is affected',
    declared.filter((r) => r.field !== 'shape').every((r) => r.verdict !== 'na'));

  // The same declaration must not excuse a value it does not apply to: a
  // bullet list is producible for any question, so priya is still graded.
  const bulleted = Check.checkReply({
    profile: Profile.PEOPLE.priya,
    reply: EN,
    question: { cannotApply: ['shape:code-first'], why: 'no code is possible here' },
  });
  ok('n/a is per field AND value, so bullets are still graded',
    bulleted.find((r) => r.field === 'shape').verdict === 'fail',
    JSON.stringify(bulleted.find((r) => r.field === 'shape')));
  ok('a bare field name still excuses the whole field',
    Check.checkReply({ profile, reply: EN, question: { cannotApply: ['shape'] } })
      .find((r) => r.field === 'shape').verdict === 'na');
});

group('an unstated field is absent, not passing', () => {
  const bare = Check.checkReply({ profile: { ...Profile.EMPTY, length: 'terse' }, reply: 'Short.' });
  ok('one stated field, one verdict', bare.length === 1 && bare[0].field === 'length');
  ok('it passed', bare[0].verdict === 'pass');
  ok('an empty profile earns no passes at all',
    Check.checkReply({ profile: Profile.EMPTY, reply: EN }).length === 0);
});

group('the unchecked fields are reported, not scored', () => {
  const results = Check.checkReply({ profile: Profile.PEOPLE.dina, reply: RU });
  const unchecked = results.filter((r) => r.verdict === 'unchecked');
  ok('name, role, expertise and tone come back unchecked',
    unchecked.length === 4, unchecked.map((r) => r.field).join(', '));
  const s = Check.score(results);
  ok('the score divides by what it graded, not by what was asked',
    s.graded === s.pass + s.fail && s.graded < results.length);
  ok('unchecked is counted separately', s.unchecked === 4);
});

/* ------------------------------------------------------------------ the grid */

group('the grid varies the person and holds the question fixed', () => {
  ok('four questions', Grid.QUESTIONS.length === 4);
  ok('five rows', Grid.ROWS.length === 5);
  ok('twenty requests', Grid.ROWS.length * Grid.QUESTIONS.length === 20);
  ok('exactly one baseline, and it sends no block',
    Grid.ROWS.filter((r) => r.baseline).length === 1
    && Profile.compile(Grid.ROWS.find((r) => r.baseline).profile()).empty === true);
  const repeats = Grid.ROWS.filter((r) => r.repeatOf);
  ok('exactly one repeat row', repeats.length === 1);
  ok('and it is the same profile as the row it repeats',
    JSON.stringify(repeats[0].profile())
    === JSON.stringify(Grid.ROWS.find((r) => r.id === repeats[0].repeatOf).profile()));
});

group('no question fights a constraint it cannot avoid', () => {
  // A jargon ban the question itself forces the model to break is not a
  // measurement, it is a trap: Priya would fail that cell every run and the
  // column would be about the question rather than about her.
  for (const question of Grid.QUESTIONS) {
    const hit = Profile.JARGON.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(question.text));
    ok(`"${question.text.slice(0, 34)}…" names no banned term`, hit.length === 0, hit.join(', '));
  }
  ok('every declared n/a names a value, not just a field',
    Grid.QUESTIONS.flatMap((q) => q.cannotApply || []).every((entry) => entry.includes(':')));
  ok('a question that declares an n/a also says why',
    Grid.QUESTIONS.filter((q) => q.cannotApply).every((q) => typeof q.why === 'string' && q.why));
  ok('only one question declares one at all',
    Grid.QUESTIONS.filter((q) => q.cannotApply).length === 1);
});

/* Synthetic cells: the noise floor and the scoring are pure functions over
 * verdicts, so they can be exercised without a model. Everything here is what
 * the table does with results, not what a model produced. */
function cell(rowId, questionId, verdicts) {
  return {
    rowId,
    questionId,
    results: Object.entries(verdicts).map(([label, verdict]) => ({ label, verdict, why: '' })),
  };
}

group('the repeat row sets the bar', () => {
  const cells = [
    cell('sam', 'ratelimit', { 'length: terse': 'pass', 'shape: code-first': 'pass' }),
    cell('sam2', 'ratelimit', { 'length: terse': 'pass', 'shape: code-first': 'fail' }),
  ];
  const noise = Grid.noiseFloor(cells);
  ok('it compared both verdicts', noise.compared === 2);
  ok('and flagged the one that disagreed', noise.unstable.length === 1);
  ok('by name', noise.unstable[0].label === 'shape: code-first');
  ok('isUnstable finds it', Grid.isUnstable(noise, 'ratelimit', 'shape: code-first'));
  ok('and does not find the stable one', !Grid.isUnstable(noise, 'ratelimit', 'length: terse'));
  ok('a different question is a different cell',
    !Grid.isUnstable(noise, 'database', 'shape: code-first'));
});

group('an unstable verdict is dropped from the score, not counted', () => {
  const cells = [
    cell('sam', 'ratelimit', { 'length: terse': 'pass', 'shape: code-first': 'pass' }),
    cell('sam2', 'ratelimit', { 'length: terse': 'pass', 'shape: code-first': 'fail' }),
    cell('priya', 'ratelimit', { 'length: normal': 'pass', 'shape: code-first': 'fail' }),
  ];
  const noise = Grid.noiseFloor(cells);
  const priya = Grid.rowScore(cells, noise, 'priya');
  ok('the coin-flip field is dropped', priya.dropped === 1);
  ok('and the denominator shrinks with it', priya.graded === 1);
  ok('the surviving verdict is still counted', priya.pass === 1 && priya.fail === 0);

  const unchecked = [cell('x', 'q', { a: 'unchecked', b: 'na', c: 'pass' })];
  const score = Grid.rowScore(unchecked, { unstable: [] }, 'x');
  ok('neither unchecked nor n/a reaches the denominator', score.graded === 1);
});

group('an errored cell is not a verdict', () => {
  const cells = [
    { rowId: 'sam', questionId: 'q', error: 'HTTP 429', results: [] },
    cell('sam2', 'q', { 'length: terse': 'pass' }),
  ];
  const noise = Grid.noiseFloor(cells);
  ok('a failed request compares nothing', noise.compared === 0);
  ok('and scores nothing', Grid.rowScore(cells, noise, 'sam').graded === 0);
});

/* -------------------------------------------------------------- the ablation */

group('only what can be checked is ablated', () => {
  const sam = Profile.PEOPLE.sam;
  const fields = Grid.ablationFields(sam);
  ok('sam has four ablatable fields', fields.length === 4, fields.join(', '));
  ok('none of them is descriptive',
    fields.every((f) => Profile.FIELDS[f].kind !== 'identity'), fields.join(', '));
  ok('tone is stated but not ablated',
    Profile.statedFields(sam).includes('tone') && !fields.includes('tone'));
  ok('the run is twelve requests',
    (2 + fields.length) * Grid.ABLATION_QUESTIONS.length === 12);
});

group('a field costs what its line costs', () => {
  const sam = Profile.PEOPLE.sam;
  for (const field of Grid.ablationFields(sam)) {
    ok(`dropping ${field} saves tokens`, Grid.fieldCost(sam, field) > 0,
      String(Grid.fieldCost(sam, field)));
  }
  ok('the ban list costs more than the language line',
    Grid.fieldCost(sam, 'forbid') > Grid.fieldCost(sam, 'language'));
});

/* The conclusion is a pure function of three verdicts, so the whole decision
 * table can be exercised with no model at all. */
function cellWith(label, verdict) {
  return { results: [{ label, verdict, why: '' }] };
}

group('the ablation grades the new reply against the OLD profile', () => {
  const L = 'length: terse';
  ok('obeyed, then broken when dropped → load-bearing',
    Grid.conclude({
      full: cellWith(L, 'pass'), repeat: cellWith(L, 'pass'), ablated: cellWith(L, 'fail'), label: L,
    }).outcome === 'load-bearing');

  ok('obeyed, and still obeyed when dropped → free',
    Grid.conclude({
      full: cellWith(L, 'pass'), repeat: cellWith(L, 'pass'), ablated: cellWith(L, 'pass'), label: L,
    }).outcome === 'free');

  ok('never obeyed → ignored, and the ablation says nothing about it',
    Grid.conclude({
      full: cellWith(L, 'fail'), repeat: cellWith(L, 'fail'), ablated: cellWith(L, 'fail'), label: L,
    }).outcome === 'ignored');

  ok('two whole-profile runs that disagree conclude nothing',
    Grid.conclude({
      full: cellWith(L, 'pass'), repeat: cellWith(L, 'fail'), ablated: cellWith(L, 'fail'), label: L,
    }).outcome === 'unstable');

  ok('and the instability outranks the load-bearing reading',
    Grid.conclude({
      full: cellWith(L, 'pass'), repeat: cellWith(L, 'fail'), ablated: cellWith(L, 'fail'), label: L,
    }).detail.includes('pass then fail'));

  ok('an n/a question decides nothing',
    Grid.conclude({
      full: cellWith(L, 'na'), repeat: cellWith(L, 'na'), ablated: cellWith(L, 'na'), label: L,
    }).outcome === 'n/a');

  ok('a failed request is no data, not a free ride',
    Grid.conclude({
      full: { results: [] }, repeat: { results: [] }, ablated: cellWith(L, 'pass'), label: L,
    }).outcome === 'no data');
});

group('load-bearing on one question is load-bearing', () => {
  ok('one of each rolls up to load-bearing',
    Grid.rollUp([{ outcome: 'free' }, { outcome: 'load-bearing' }]) === 'load-bearing');
  ok('free only when it is free everywhere',
    Grid.rollUp([{ outcome: 'free' }, { outcome: 'free' }]) === 'free');
  ok('an n/a alongside a free reading does not hide it',
    Grid.rollUp([{ outcome: 'n/a' }, { outcome: 'free' }]) === 'free');
  ok('the order is the one the table renders',
    Grid.OUTCOME_ORDER[0] === 'load-bearing');
});

group('the ablation cannot be run against a reply it did not grade', () => {
  // The distinction the whole design turns on: grading an ablated reply
  // against the ablated profile produces no verdict for the removed field,
  // because nothing was asked. The run must grade against the full profile.
  const sam = Profile.PEOPLE.sam;
  const stripped = Profile.without(sam, 'length');
  const reply = Array(400).fill('word').join(' ');
  ok('graded against the stripped profile, length is not even mentioned',
    !Check.checkReply({ profile: stripped, reply }).some((r) => r.field === 'length'));
  ok('graded against the whole profile, it fails',
    Check.checkReply({ profile: sam, reply }).find((r) => r.field === 'length').verdict === 'fail');
});

/* ------------------------------------------------------- the loop, end to end */

/* A fake transport, and the one place in this repo where that is allowed.
 *
 * It is not a stub of a model. It returns a canned string per request and its
 * only job is to prove that the loop wires up: that twenty cells are asked in
 * the right order with the right profiles, that a failure in one does not take
 * the run down, that the repeat row is compared against the row it repeats.
 * None of that is a claim about obedience — the moment a fake started trying
 * to obey the preferences, the grid would be measuring the fake.
 */
function fakeTransport(reply) {
  const seen = [];
  globalThis.Api = {
    models: ['fake'],
    async send({ messages }) {
      seen.push(messages);
      const text = typeof reply === 'function' ? reply(messages, seen.length) : reply;
      if (text instanceof Error) throw text;
      return { text, usage: { promptTokens: 10, completionTokens: 5 }, cost: 0.0001 };
    },
  };
  return seen;
}

group('the grid asks twenty questions as five people', async () => {
  const seen = fakeTransport('- one\n- two\n- three');
  const run = await Grid.runGrid({ model: 'fake', temperature: 0 });
  ok('twenty requests went out', seen.length === 20);
  ok('twenty cells came back', run.cells.length === 20);

  const baseline = seen.filter((m) => m.length === 2);
  ok('four of them carried no profile block at all', baseline.length === 4,
    `${baseline.length} two-message requests`);
  ok('the other sixteen carried one', seen.filter((m) => m.length === 3).length === 16);
  ok('the persona is first in every request', seen.every((m) => m[0].content === Profile.PERSONA));
  ok('the block is a system message, never a user turn',
    seen.filter((m) => m.length === 3).every((m) => m[1].role === 'system'));
  ok('the question is last in every request', seen.every((m) => m[m.length - 1].role === 'user'));

  const asRussian = seen.filter((m) => m.length === 3 && m[1].content.includes('Answer in Russian.'));
  ok('four requests asked for Russian — one person, four questions', asRussian.length === 4);

  ok('the baseline row is graded on nothing', run.scores.none.graded === 0);
  ok('and every profile row is graded on something', run.scores.sam.graded > 0);
  ok('the run prices itself', run.cost > 0);
});

group('one dead request does not take the run with it', async () => {
  fakeTransport((messages, n) => (n === 3 ? new Error('HTTP 429') : 'some prose answer here'));
  const run = await Grid.runGrid({ model: 'fake', temperature: 0 });
  ok('all twenty cells are present', run.cells.length === 20);
  ok('one of them carries the error', run.cells.filter((c) => c.error).length === 1);
  ok('and it says which', run.cells.find((c) => c.error).error.includes('429'));
  ok('the errored cell contributes no verdicts',
    run.cells.find((c) => c.error).results.length === 0);
});

group('the ablation drops one field at a time', async () => {
  const seen = fakeTransport('```js\nconst x = 1;\n```\n\nshort.');
  const run = await Grid.runAblation({ who: 'sam', model: 'fake', temperature: 0 });
  ok('twelve requests', seen.length === 12, String(seen.length));
  ok('the first four are the whole profile, asked twice',
    seen.slice(0, 4).every((m) => m[1].content.includes('at most 120 words')));
  ok('one run has no language line',
    seen.some((m) => m[1] && !m[1].content.includes('Answer in English.')));
  ok('and exactly two, because there are two questions',
    seen.filter((m) => m[1] && !m[1].content.includes('Answer in English.')).length === 2);
  ok('every dropped field is reported', run.rows.length === 4);
  ok('the ban list produces one row per ban',
    run.rows.find((r) => r.field === 'forbid').labels.length === 2);
  ok('nothing descriptive was dropped',
    run.rows.every((r) => Profile.FIELDS[r.field].kind !== 'identity'));
  ok('and the unchecked fields are named rather than omitted',
    run.unchecked.length === 4, run.unchecked.join(', '));
});

group('a reply that obeys nothing makes every field look load-bearing', async () => {
  // The fake answers in long English prose. Sam asked for terse, code-first
  // English — so dropping a field cannot break what was already broken, and
  // the run must say "ignored" rather than inventing a finding.
  fakeTransport(Array(400).fill('word').join(' '));
  const run = await Grid.runAblation({ who: 'sam', model: 'fake', temperature: 0 });
  const length = run.rows.find((r) => r.field === 'length').labels[0];
  ok('a preference never obeyed is reported as ignored', length.outcome === 'ignored',
    JSON.stringify(length.conclusions));
  const language = run.rows.find((r) => r.field === 'language').labels[0];
  ok('a preference always obeyed and unchanged by removal is free',
    language.outcome === 'free', JSON.stringify(language.conclusions));
});

/* ---------------------------------------------------------------- the page */

/* There is no DOM here and no browser in CI, so the one thing that can go
 * wrong silently is a handle in app.js that no element answers to. `el('x')`
 * returning null fails at the first render with a stack trace nobody sees
 * until they open the page. Reading both files and comparing is cheap and
 * catches exactly that. */

/* The page loads these files as plain <script> tags, which share ONE global
 * lexical scope. Two files declaring `const MARK` at top level is not shadowing
 * and not a warning — it is a SyntaxError that kills the second file outright,
 * and the page renders nothing with one line in a console nobody opened.
 *
 * This is exactly what happened: markdown.js (carried from task 5) has a
 * top-level BULLET and MARK, check.js and app.js each added one of their own,
 * and app.js stopped parsing. The suite missed it because it loads only the
 * three files it tests, never markdown.js and app.js alongside them — so the
 * check has to be over the files the PAGE loads, not the ones the tests use.
 */
group('no two scripts declare the same name at top level', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  ok('the page loads six scripts', scripts.length === 6, scripts.join(', '));

  const owner = new Map();
  let declared = 0;
  for (const file of scripts) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    // Column zero only: a declaration anywhere else is inside a scope.
    for (const match of source.matchAll(/^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      declared += 1;
      ok(`${name} is declared once, and ${file} is where`,
        !owner.has(name), `also declared in ${owner.get(name)}`);
      owner.set(name, file);
    }
  }
  ok('there are enough top-level names for this to be worth checking',
    declared > 60, String(declared));
});

group('every handle the app reaches for exists in the page', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const wanted = [...new Set([...app.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]))];
  ok('app.js asks for at least a dozen of them', wanted.length >= 12, String(wanted.length));
  for (const id of wanted) ok(`#${id} is in index.html`, ids.has(id));

  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  for (const file of scripts) {
    ok(`${file} is loaded and exists`, fs.existsSync(path.join(__dirname, file)));
  }
  ok('profile.js is loaded before app.js',
    scripts.indexOf('profile.js') < scripts.indexOf('app.js'));
});

/* ----------------------------------------------------------- the page runs */

/* A DOM small enough to boot the page against, and no smaller.
 *
 * There is no browser here, and the collision check above only proves the
 * files parse. Parsing is not running: a handler that reads a property off
 * null, a render that assumes an element has children, an event wired to a
 * function that was never defined — all of those load fine and kill the page
 * on the first click.
 *
 * This is a stub of the BROWSER, which is a different thing from a stub of the
 * model. Faking a model would make the grid a measurement of the fake. Faking
 * `document.createElement` measures nothing and asserts nothing about
 * obedience; it only asks whether the code runs.
 *
 * It loads in its own vm context, so the scripts can be evaluated a second
 * time without colliding with the copies this file already loaded.
 */
function bootPage({ reply = '- one\n- two\n- three', key = 'sk-test' } = {}) {
  class El {
    constructor(tag) {
      this.tagName = String(tag || '').toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.listeners = {};
      this._text = '';
      this.innerHTML = '';
      this.hidden = false;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.className = '';
      const classes = new Set();
      this.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      };
    }
    get textContent() {
      return this._text
        || this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    append(...nodes) { this.children.push(...nodes); this._text = ''; }
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, event = {}) {
      for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event });
    }
    requestSubmit() { this.fire('submit'); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    get lastElementChild() {
      const kids = this.children.filter((c) => c && c.tagName);
      return kids[kids.length - 1] || null;
    }
  }

  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // The handles come out of index.html itself, so the shim cannot invent an
  // element the real page does not have.
  const byId = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new El('div')]));
  const names = ['chat', 'grid', 'ablation'];
  const tabs = names.map((name) => Object.assign(new El('button'), { dataset: { tab: name } }));
  const panes = names.map((name) => Object.assign(new El('section'), { dataset: { pane: name } }));

  const store = {};
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    DOMException: class extends Error {},
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    performance: { now: () => Date.now() },
    document: {
      getElementById: (id) => byId.get(id) || null,
      createElement: (tag) => new El(tag),
      querySelectorAll: (sel) => (sel === '.tab' ? tabs : sel === '.pane' ? panes : []),
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        };
      },
    }),
  };
  if (key) store['task12.deepseek.key'] = key;

  const context = vm.createContext(sandbox);
  for (const file of [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  // Top-level `const` and `class` live in the context's lexical scope, which is
  // not reflected on the sandbox object — the same rule that made two scripts
  // sharing a `const MARK` a parse error. Evaluating an expression inside the
  // context is the way to reach them.
  const read = (expression) => vm.runInContext(expression, context);
  return { byId, tabs, panes, sandbox, context, read, El };
}

group('the page boots and renders', () => {
  const page = bootPage();
  ok('the profile block is on screen',
    page.byId.get('blockText').textContent.startsWith('Who you are talking to'));
  ok('with its token count', page.byId.get('blockTokens').textContent === '127 tokens, on every request');
  ok('three people and a baseline are offered', page.byId.get('people').children.length === 4);
  ok('eight fields are drawn from the schema, not written by hand',
    page.byId.get('fields').children.length === Profile.FIELD_ORDER.length - 1);
  ok('every ban in the catalogue has a row',
    page.byId.get('banList').children.length === Object.keys(Profile.BANS).length);
  ok('the ablation picker offers the three people',
    page.byId.get('ablationWho').children.length === Object.keys(Profile.PEOPLE).length);
  ok('and the note says what can and cannot be checked',
    /4 of those can be checked/.test(page.byId.get('editorNote').textContent),
    page.byId.get('editorNote').textContent);
});

group('switching a person redraws the block', () => {
  const page = bootPage();
  const before = page.byId.get('blockTokens').textContent;
  page.byId.get('people').children[0].fire('click');
  ok('the block changed', page.byId.get('blockTokens').textContent !== before);
  ok('to Дина\'s size', page.byId.get('blockTokens').textContent.startsWith('116'),
    page.byId.get('blockTokens').textContent);
});

group('editing a field forks a profile instead of overwriting a fixture', () => {
  const page = bootPage();
  const select = page.byId.get('fields').children
    .flatMap((row) => row.children).find((node) => node.id === 'f-length');
  select.value = 'terse';
  select.fire('change');
  const labels = page.byId.get('people').children.map((b) => b.textContent);
  ok('a fifth option appears', labels.length === 5, labels.join(', '));
  ok('and it is marked as edited', labels[4].includes('edited'), labels[4]);
  ok('Sam himself is untouched',
    Profile.compile(Profile.PEOPLE.sam).tokens === 127);
});

group('a finished turn carries its verdicts', () => {
  const page = bootPage();
  page.read('state').history.push(
    { role: 'user', content: 'q', who: 'sam', asked: 'Sam' },
    {
      role: 'assistant',
      content: 'Short answer with no code at all.',
      profile: Profile.PEOPLE.sam,
      done: true,
      meta: '',
    },
  );
  page.read('redrawLog')();
  const strip = page.byId.get('log').children[1].children[2];
  const text = strip.children.map((c) => c.textContent).join(' | ');
  ok('the language check passed', /language: English/.test(text) && /100% Latin/.test(text));
  ok('code-first failed on a reply with no code', /shape: code-first/.test(text) && /no code at all/.test(text));
  ok('both bans are reported separately', /never emoji/.test(text) && /never pleasantries/.test(text));
  ok('and the four unscorable fields are named, not hidden',
    /name, role, expertise, tone/.test(text), text);
});

group('the grid and the ablation render end to end', async () => {
  const page = bootPage();
  await page.read('startGrid')();
  ok('twenty requests, none failed',
    page.byId.get('gridStatus').textContent === '20 requests, 0 of them failed.',
    page.byId.get('gridStatus').textContent);
  const table = page.byId.get('gridOut').children[1];
  ok('a header row and five rows', table.children.length === 6);
  ok('the baseline is graded on nothing',
    table.children[1].children[0].textContent.includes('nothing to grade'));
  ok('the person who asked for bullets scores best on a bullet-list reply',
    table.children[5].children[0].textContent.includes('20/20'),
    table.children[5].children[0].textContent);

  await page.read('startAblation')();
  ok('twelve requests', page.byId.get('ablationStatus').textContent === '12 requests.');
  const rows = page.byId.get('ablationOut').children[1].children.slice(1);
  ok('five rows — four fields, one of which holds two bans', rows.length === 5);
  ok('every row reaches a named outcome',
    rows.every((row) => Grid.OUTCOME_ORDER.some((o) => row.children[2].textContent.startsWith(o))),
    rows.map((row) => row.children[2].textContent.slice(0, 20)).join(' | '));
});

group('a page with no key still works, it just cannot ask', async () => {
  const page = bootPage({ key: '' });
  ok('the block still compiles',
    page.byId.get('blockText').textContent.startsWith('Who you are talking to'));
  ok('and the page says why nothing can be asked',
    /No API key/.test(page.byId.get('keyNote').textContent),
    page.byId.get('keyNote').textContent);
  await page.read('startGrid')();
  ok('a keyless grid run fails every cell rather than throwing',
    page.byId.get('gridStatus').textContent === '20 requests, 20 of them failed.',
    page.byId.get('gridStatus').textContent);
  ok('and still renders a table', page.byId.get('gridOut').children.length === 3);
});

/* ------------------------------------------------------- the README's numbers */

/* Every number in the README that is not labelled as coming from a live run
 * comes from here. A README that quotes a token count nobody recomputes is a
 * README that is right on the day it is written. */

group('the README quotes what the code produces', () => {
  const expected = { dina: 116, sam: 127, priya: 143 };
  for (const [who, tokens] of Object.entries(expected)) {
    ok(`${who}'s block is ${tokens} tokens`,
      Profile.compile(Profile.PEOPLE[who]).tokens === tokens,
      String(Profile.compile(Profile.PEOPLE[who]).tokens));
  }

  const samCosts = { language: 5, length: 14, shape: 20, forbid: 25 };
  for (const [field, tokens] of Object.entries(samCosts)) {
    ok(`dropping sam's ${field} saves ${tokens} tokens`,
      Grid.fieldCost(Profile.PEOPLE.sam, field) === tokens,
      String(Grid.fieldCost(Profile.PEOPLE.sam, field)));
  }

  ok('the grid is twenty requests', Grid.ROWS.length * Grid.QUESTIONS.length === 20);
  ok('an ablation of sam is twelve',
    (2 + Grid.ablationFields(Profile.PEOPLE.sam).length) * Grid.ABLATION_QUESTIONS.length === 12);

  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  ok("sam's block is quoted verbatim, line for line",
    Profile.compile(Profile.PEOPLE.sam).text.split('\n')
      .filter((line) => line.length < 72 && line.trim())
      .every((line) => readme.includes(line)));
  ok('every ablation outcome the README names is one the code can produce',
    ['load-bearing', 'free', 'ignored', 'unstable']
      .every((outcome) => Grid.OUTCOME_ORDER.includes(outcome) && readme.includes(outcome)));
});

/* ------------------------------------------------------------------- run it */

(async () => {
  for (const run of queue) await run();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
})();
