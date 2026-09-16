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

for (const file of ['profile.js']) {
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
