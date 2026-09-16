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

/* ---------------------------------------------------------------- the page */

/* There is no DOM here and no browser in CI, so the one thing that can go
 * wrong silently is a handle in app.js that no element answers to. `el('x')`
 * returning null fails at the first render with a stack trace nobody sees
 * until they open the page. Reading both files and comparing is cheap and
 * catches exactly that. */

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

/* ------------------------------------------------------------------- run it */

(async () => {
  for (const run of queue) await run();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
})();
