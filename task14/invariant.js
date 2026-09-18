/* The invariants, and the checker that adjudicates them.
 *
 * Nothing here talks to a model, reads storage, or touches the DOM. That is
 * the whole point: the thing that decides whether a proposal violates a rule
 * has to be something other than the party being constrained, and a function
 * with no I/O is the strongest form of "something other".
 *
 * The problem this file exists to solve is that architectural invariants are
 * prose — "stays a static page", "Postgres, never a second datastore" — and
 * prose is not checkable. There is no regular expression for *this design
 * introduces a server*.
 *
 * So the proposal is structured rather than the rule being clever. A proposal
 * declares what it touches across ten fixed facets, and an invariant is a
 * predicate over that declaration. What the model writes in its prose is not
 * the subject. What it declares is.
 *
 * The ceiling is exact and is printed wherever this runs: the checker
 * constrains what is DECLARED, not what is TRUE. A proposal that adds React
 * and writes `dependency: []` walks straight through. `contradiction()` at the
 * bottom of this file is a lexical net under that hole, and it is a heuristic
 * — it catches the obvious lie and will not catch a careful one.
 */

/* Ten, fixed at build time. Neither the model nor the user can add one.
 *
 * A closed vocabulary is a ceiling and it is chosen deliberately: a facet set
 * the user could extend would need a rule language to match, and a rule
 * language that can express anything is a programming language with the
 * invariant set as a program to debug. An invariant that does not project onto
 * these ten can still be carried — as `soft`, graded by nobody, printed as
 * unverified. */
const FACETS = {
  runtime: 'where the code runs',
  language: 'languages the solution introduces',
  dependency: 'third-party packages present at runtime',
  build: 'toolchain steps the solution requires before it can run',
  service: 'new deployable units the solution stands up',
  network: 'hosts contacted at runtime',
  storage: 'where state is written',
  data: 'classes of data the solution handles',
  operation: 'business actions the solution performs',
  precondition: 'what the solution checks before it acts',
};

const FACET_NAMES = Object.keys(FACETS);

/* Four.
 *
 * There were five. `max` — at most n items in a facet — was written, and then
 * nothing needed it: every real limit turned out to be `allow-only` with a
 * short list, or `deny-all`, which is the same thing said plainly. An op that
 * no invariant uses is an op that no test exercises, so it went. Task 13 cut a
 * rejection reason the same way and for the same reason. */
const OPS = {
  'deny-all': 'the facet must be declared empty',
  'allow-only': 'every declared item must match one of these',
  deny: 'no declared item may match one of these',
  require: 'every one of these must be declared',
};

const OP_NAMES = Object.keys(OPS);

/* The four ways a hard invariant can be violated. Closed, so the README has
 * rows to print and the tests have exact strings to assert. */
const VIOLATIONS = {
  'denied-all': 'the facet admits nothing, and something was declared in it',
  'not-allowed': 'a declared item is outside what the invariant allows',
  'denied-item': 'a declared item is one the invariant names and forbids',
  'missing-required': 'something the invariant requires was not declared',
};

const VIOLATION_CODES = Object.keys(VIOLATIONS);

const KINDS = ['architecture', 'stack', 'decision', 'business'];

/* ------------------------------------------------------------ declarations */

/* Items are compared case-insensitively and with the surrounding space gone,
 * because `Marked@12` and `marked@12 ` are the same dependency and an
 * invariant that could be defeated by a capital letter is not one. */
function item(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function list(value) {
  const source = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    const cleaned = item(entry);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.sort();
}

/* Every facet present, always, even the empty ones. A declaration where a
 * facet is *absent* and one where it is *empty* would otherwise be two
 * different things, and the difference between "I add no dependencies" and "I
 * did not think about dependencies" is exactly what `undeclared` exists to
 * catch at the protocol layer — not something to leave to an `undefined`. */
function normalise(declaration) {
  const source = declaration && typeof declaration === 'object' ? declaration : {};
  const out = {};
  for (const facet of FACET_NAMES) out[facet] = list(source[facet]);
  return out;
}

/* Reported rather than dropped. A facet the model invented is a signal that it
 * is answering a schema it imagined, and silently discarding it would hide
 * that. */
function unknownFacets(declaration) {
  const source = declaration && typeof declaration === 'object' ? declaration : {};
  return Object.keys(source).filter((key) => !FACET_NAMES.includes(key)).sort();
}

function declaredAnything(declaration) {
  return FACET_NAMES.some((facet) => normalise(declaration)[facet].length > 0);
}

/* ------------------------------------------------------------------- globs */

/* `*` only. Not a regex: invariants are read by people deciding whether to
 * adopt them, and `^(?:localStorage:task14\..*)$` is not a thing anyone
 * adopts. */
function matches(value, pattern) {
  const target = item(value);
  const glob = item(pattern);
  if (!glob) return false;
  if (glob === '*') return true;
  if (!glob.includes('*')) return target === glob;
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*');
  return new RegExp(`^${escaped}$`).test(target);
}

function matchesAny(value, patterns) {
  return (patterns || []).some((pattern) => matches(value, pattern));
}

/* ------------------------------------------------------------------- rules */

function isConditional(rule) {
  return Boolean(rule && rule.when && rule.then);
}

function readsFacet(rule) {
  if (!rule) return null;
  return isConditional(rule) ? rule.then.facet : rule.facet;
}

/* Does this invariant have anything to say about this declaration?
 *
 * Not the same question as "is it violated". An invariant that bears and holds
 * is the interesting case — it is the one the model should have listed as
 * considered, and the gap between what bears and what was listed is the only
 * mechanical thing "explicitly considered in reasoning" can be turned into.
 *
 * `require` always bears, because you can always fail to include something.
 * Everything else bears only when its facet has something in it: an invariant
 * about dependencies has no opinion on a proposal that adds none. This is the
 * same asymmetry task 12's checker found between a prohibition, which is
 * always applicable, and a requirement, which is not. */
function bears(rule, declared) {
  if (!rule) return false;
  if (isConditional(rule)) {
    if (!declared[rule.when.facet]) return false;
    if (!declared[rule.when.facet].some((entry) => matches(entry, rule.when.includes))) return false;
    return bears({ ...rule.then }, declared);
  }
  if (!FACET_NAMES.includes(rule.facet)) return false;
  if (rule.op === 'require') return true;
  return declared[rule.facet].length > 0;
}

/* One predicate, one facet. Returns the violation code and the items to blame,
 * or null. Every code names something you can point at in the declaration,
 * which is what makes a refusal quotable rather than atmospheric. */
function evaluate(rule, declared) {
  const facet = rule.facet;
  if (!FACET_NAMES.includes(facet)) return null;
  const items = declared[facet];

  if (rule.op === 'deny-all') {
    return items.length ? { code: 'denied-all', offending: items } : null;
  }
  if (rule.op === 'allow-only') {
    const bad = items.filter((entry) => !matchesAny(entry, rule.items));
    return bad.length ? { code: 'not-allowed', offending: bad } : null;
  }
  if (rule.op === 'deny') {
    const bad = items.filter((entry) => matchesAny(entry, rule.items));
    return bad.length ? { code: 'denied-item', offending: bad } : null;
  }
  if (rule.op === 'require') {
    const missing = (rule.items || []).map(item)
      .filter((wanted) => !items.some((entry) => matches(entry, wanted)));
    return missing.length ? { code: 'missing-required', offending: missing } : null;
  }
  return null;
}

/* ----------------------------------------------------------------- the set */

function hard(set) {
  return invariantsOf(set).filter((one) => one.enforcement !== 'soft');
}

function soft(set) {
  return invariantsOf(set).filter((one) => one.enforcement === 'soft');
}

function invariantsOf(set) {
  if (Array.isArray(set)) return set;
  return set && Array.isArray(set.invariants) ? set.invariants : [];
}

function byId(set, id) {
  const wanted = String(id || '').trim().toUpperCase();
  return invariantsOf(set).find((one) => String(one.id).toUpperCase() === wanted) || null;
}

/* The whole adjudication, in one pure function.
 *
 *   check(set, declaration) → { violations, bearing, considered, clean }
 *
 * `bearing` is what the declaration touched. `violations` is where it went
 * wrong, each one carrying the invariant, the facet, the code and the items to
 * blame. Soft invariants appear in neither: they are not gradeable, and a
 * check that cannot fail is not a check. They are returned separately so the
 * page can print them as unverified instead of quietly passing them. */
function check(set, declaration) {
  const declared = normalise(declaration);
  const violations = [];
  const bearing = [];

  for (const one of hard(set)) {
    const rule = one.rule;
    if (!bears(rule, declared)) continue;
    bearing.push(one.id);
    const target = isConditional(rule) ? rule.then : rule;
    const failed = evaluate(target, declared);
    if (!failed) continue;
    violations.push({
      id: one.id,
      kind: one.kind,
      text: one.text,
      facet: target.facet,
      op: target.op,
      code: failed.code,
      offending: failed.offending,
      clause: clauseOf(one),
    });
  }

  return {
    violations,
    bearing,
    unverified: soft(set).map((one) => one.id),
    unknownFacets: unknownFacets(declaration),
    clean: violations.length === 0,
  };
}

/* The rule in one line of English, generated from the rule itself rather than
 * written beside it. Two sources for the same fact is how a clause ends up
 * describing a predicate that was changed underneath it. */
function clauseOf(one) {
  const rule = one && one.rule;
  if (!rule) return '';
  const said = (target) => {
    const where = target.facet;
    if (target.op === 'deny-all') return `no ${where} may be declared`;
    if (target.op === 'allow-only') return `${where} may only be ${(target.items || []).join(', ')}`;
    if (target.op === 'deny') return `${where} may not be ${(target.items || []).join(', ')}`;
    if (target.op === 'require') return `${where} must include ${(target.items || []).join(', ')}`;
    return where;
  };
  if (isConditional(rule)) {
    return `when ${rule.when.facet} includes ${rule.when.includes}, ${said(rule.then)}`;
  }
  return said(rule);
}

/* Which invariants bore on a declaration but were not named as considered.
 *
 * A proxy, and the README says so in those words: listing an id is not the
 * same as having reasoned about it. What it catches is the failure that
 * matters — an invariant that applied and went unmentioned. */
function missed(set, declaration, considered) {
  const named = new Set(list(considered));
  return check(set, declaration).bearing.filter((id) => !named.has(item(id)));
}

/* --------------------------------------------------- the net under the hole */

/* Signals that the prose is doing something the declaration did not admit to.
 *
 * Every entry is (a) a pattern that appears in the prose, (b) the facet it
 * implies, and (c) how to name the thing it found. A finding is a
 * contradiction only when what the prose implies is absent from what was
 * declared — the model is free to add a dependency it declared, and this file
 * has no opinion about that. Whether the invariants allow it is `check`'s job.
 *
 * This is a HEURISTIC. It is labelled as one everywhere it is printed. */
const LISTENS = /\b(?:app|server)\.listen\(|\bexpress\(\)|\bFastAPI\(|\bhttp\.createServer\(/g;

const SIGNALS = [
  { facet: 'dependency', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|add|install)\s+(?:-{1,2}\S+\s+)*([@\w][\w@/.-]*)/gi },
  { facet: 'dependency', re: /\bimport\s+(?:[\s\S]{0,80}?\sfrom\s+)?["']([^."'][^"']*)["']/g },
  { facet: 'dependency', re: /\brequire\(\s*["']([^."'][^"']*)["']\s*\)/g },
  { facet: 'dependency', re: /^\s*(?:from|import)\s+([a-z_][\w]*)/gim, langs: ['python'] },
  { facet: 'network', re: /https?:\/\/([\w.-]+)/gi },
  { facet: 'network', re: /<script[^>]+src=["']https?:\/\/([\w.-]+)/gi },
  { facet: 'build', re: /\b(webpack|vite|rollup|esbuild|parcel|tsc|babel|gradle|maven)\b/gi },
  { facet: 'storage', re: /\b(mongodb|mongo|redis|dynamodb|cassandra|sqlite|s3|elasticsearch)\b/gi },
  { facet: 'storage', re: /\bcreate\s+table\b/gi, names: 'a relational table',
    aliases: ['postgres', 'postgres:*', 'mysql', 'mariadb', 'sqlite'] },
  { facet: 'service', re: LISTENS, names: 'a listening process', anyOf: true },
  { facet: 'runtime', re: new RegExp(LISTENS.source, 'g'), names: 'server',
    aliases: ['server', 'node', 'deno', 'bun'] },
];

/* Things that match the patterns and are not what the pattern is for. A
 * heuristic with no exception list fires on its own documentation, which is
 * how a check ends up being switched off entirely. */
const BENIGN = new Set(['localhost', '127.0.0.1', 'example.com', 'developer.mozilla.org']);

function contradiction(declaration, prose) {
  const declared = normalise(declaration);
  const text = String(prose || '');
  const found = [];
  const seen = new Set();

  for (const signal of SIGNALS) {
    signal.re.lastIndex = 0;
    let match = signal.re.exec(text);
    while (match) {
      const named = signal.names || item(match[1] || match[0]);
      const key = `${signal.facet}:${named}`;
      /* Three ways a declaration can already admit to what the prose implies.
       * `anyOf` — the facet is the admission: any declared service covers a
       * listening process. `aliases` — the prose names a category and the
       * declaration names an instance of it. Otherwise the item itself, give
       * or take a version suffix. */
      const admitted = signal.anyOf
        ? declared[signal.facet].length > 0
        : signal.aliases
          ? declared[signal.facet].some((entry) => matchesAny(entry, signal.aliases))
          : declared[signal.facet].some((entry) => entry === named || entry.startsWith(`${named}@`)
            || named.startsWith(`${entry}@`) || entry.endsWith(`:${named}`));
      if (named && !BENIGN.has(named) && !admitted && !seen.has(key)) {
        seen.add(key);
        found.push({
          facet: signal.facet,
          implied: named,
          evidence: match[0].trim().slice(0, 80),
        });
      }
      match = signal.re.exec(text);
    }
  }
  return found;
}

/* ------------------------------------------------------------ seeded sets */

/* Two, because the brief names four kinds of invariant and one subject cannot
 * carry all four without inventing something. */

const REPO = {
  id: 'repo',
  name: 'this repo',
  subject: 'a single-page app in the ai-advent-challenge repo',
  invariants: [
    {
      id: 'INV-1',
      kind: 'architecture',
      text: 'No server. The page opens from the filesystem and runs in the browser.',
      why: 'Every task from 4 onward opens with a double-click. A server is a thing to install, run, and get wrong before anyone sees the subject of the task.',
      enforcement: 'hard',
      rule: { facet: 'runtime', op: 'allow-only', items: ['browser'] },
      since: 'task4',
    },
    {
      id: 'INV-2',
      kind: 'stack',
      text: 'No runtime dependencies. Everything ships as files you can open and read.',
      why: 'A dependency is a lockfile, a supply chain and a version that rots. The whole repo is meant to be readable a year later without an install step.',
      enforcement: 'hard',
      rule: { facet: 'dependency', op: 'deny-all' },
      since: 'task4',
    },
    {
      id: 'INV-3',
      kind: 'stack',
      text: 'No build step. What is written is what runs.',
      why: 'A build is a second program between the source and the behaviour, and it is the first thing to break when nobody has touched the project in months.',
      enforcement: 'hard',
      rule: { facet: 'build', op: 'deny-all' },
      since: 'task4',
    },
    {
      id: 'INV-4',
      kind: 'decision',
      text: 'One provider. The only host contacted at runtime is api.deepseek.com.',
      why: 'A second provider means a second key, a second failure mode, and a comparison nobody asked for.',
      enforcement: 'hard',
      rule: { facet: 'network', op: 'allow-only', items: ['api.deepseek.com'] },
      since: 'task5',
    },
    {
      id: 'INV-5',
      kind: 'decision',
      text: 'localStorage only, and every key namespaced task14.*',
      why: 'Fifteen tasks share one origin when they are opened from the same folder. An unnamespaced key is one task quietly reading another one’s state.',
      enforcement: 'hard',
      rule: { facet: 'storage', op: 'allow-only', items: ['localstorage:task14.*'] },
      since: 'task4',
    },
    {
      id: 'INV-6',
      kind: 'decision',
      text: 'The API key never leaves the browser. Nothing that handles it may contact anything but the provider.',
      why: 'The key is pasted into a page the user cannot audit. The one defence that survives not being audited is that there is nowhere else for it to go.',
      enforcement: 'hard',
      rule: {
        when: { facet: 'data', includes: 'api-key' },
        then: { facet: 'network', op: 'allow-only', items: ['api.deepseek.com'] },
      },
      since: 'task5',
    },
    {
      id: 'INV-7',
      kind: 'decision',
      text: 'No offline stub standing in for the model.',
      why: 'The subject of every one of these tasks is what a model actually does. A stub written to satisfy the checks would be measuring the checks.',
      enforcement: 'soft',
      rule: null,
      since: 'task11',
    },
  ],
};

const PAYMENTS = {
  id: 'payments',
  name: 'a payments service',
  subject: 'the refunds and settlement service of a European payments platform',
  invariants: [
    {
      id: 'INV-1',
      kind: 'architecture',
      text: 'Postgres is the only datastore.',
      why: 'Two datastores mean two truths and a reconciliation job that exists to decide which one is lying.',
      enforcement: 'hard',
      rule: { facet: 'storage', op: 'allow-only', items: ['postgres', 'postgres:*'] },
      since: '2023-04',
    },
    {
      id: 'INV-2',
      kind: 'stack',
      text: 'Services are written in Go.',
      why: 'One language is one set of on-call runbooks, one build pipeline and one pool of people who can be paged at three in the morning.',
      enforcement: 'hard',
      rule: { facet: 'language', op: 'allow-only', items: ['go', 'sql'] },
      since: '2022-09',
    },
    {
      id: 'INV-3',
      kind: 'architecture',
      text: 'No new services. Work goes into one of the four that exist.',
      why: 'Each service is a deploy, a dashboard, an alert route and an owner. The platform is at the number it can staff.',
      enforcement: 'hard',
      rule: { facet: 'service', op: 'deny-all' },
      since: '2024-01',
    },
    {
      id: 'INV-4',
      kind: 'business',
      text: 'No refund is issued against a payment that has not settled.',
      why: 'An unsettled payment can still fail. Refunding one sends money out against money that never came in, and the acquirer will not give it back.',
      enforcement: 'hard',
      rule: {
        when: { facet: 'operation', includes: 'issue_refund' },
        then: { facet: 'precondition', op: 'require', items: ['payment_settled'] },
      },
      since: '2022-11',
    },
    {
      id: 'INV-5',
      kind: 'business',
      text: 'Personal data never leaves the EU.',
      why: 'It is a licensing condition, not a preference. The regulator does not read design documents.',
      enforcement: 'hard',
      rule: {
        when: { facet: 'data', includes: 'pii' },
        then: { facet: 'network', op: 'allow-only', items: ['*.eu', '*.eu.internal', 'postgres'] },
      },
      since: '2021-06',
    },
    {
      id: 'INV-6',
      kind: 'architecture',
      text: 'The refunds service never captures or voids a payment. Those belong to payments.',
      why: 'Two services that can both move money against one authorisation is a race with a customer on the other end of it.',
      enforcement: 'hard',
      rule: { facet: 'operation', op: 'deny', items: ['capture_payment', 'void_payment'] },
      since: '2023-04',
    },
    {
      id: 'INV-7',
      kind: 'business',
      text: 'No order is ever charged twice, whatever the client retries.',
      why: 'Idempotency is a property of a whole path, not of a field. It is here to be argued about, because nothing in a declaration can settle it.',
      enforcement: 'soft',
      rule: null,
      since: '2022-11',
    },
  ],
};

const SETS = { repo: REPO, payments: PAYMENTS };

/* A shape check for hand-authored invariants, so the editor in the app can
 * refuse a rule rather than storing one the checker will silently ignore. A
 * rule that never fires is worse than one that fires wrongly, because the
 * second is visible. */
function validate(one) {
  const problems = [];
  if (!one || typeof one !== 'object') return ['not an object'];
  if (!String(one.id || '').trim()) problems.push('no id');
  if (!String(one.text || '').trim()) problems.push('no text');
  if (!KINDS.includes(one.kind)) problems.push(`kind must be one of ${KINDS.join(', ')}`);
  if (one.enforcement === 'soft') {
    if (one.rule) problems.push('a soft invariant carries no rule');
    return problems;
  }
  if (one.enforcement !== 'hard') problems.push('enforcement must be hard or soft');
  const rule = one.rule;
  if (!rule) return problems.concat('a hard invariant needs a rule');
  const targets = isConditional(rule) ? [rule.then] : [rule];
  if (isConditional(rule)) {
    if (!FACET_NAMES.includes(rule.when.facet)) problems.push(`unknown facet ${rule.when.facet}`);
    if (!String(rule.when.includes || '').trim()) problems.push('the when clause names nothing');
  }
  for (const target of targets) {
    if (!FACET_NAMES.includes(target.facet)) problems.push(`unknown facet ${target.facet}`);
    if (!OP_NAMES.includes(target.op)) problems.push(`unknown op ${target.op}`);
    if (['allow-only', 'deny', 'require'].includes(target.op) && !list(target.items).length) {
      problems.push(`${target.op} needs items`);
    }
  }
  return problems;
}

const Invariant = {
  FACETS,
  FACET_NAMES,
  OPS,
  OP_NAMES,
  VIOLATIONS,
  VIOLATION_CODES,
  KINDS,
  SETS,
  REPO,
  PAYMENTS,
  SIGNALS,
  normalise,
  unknownFacets,
  declaredAnything,
  matches,
  isConditional,
  readsFacet,
  bears,
  evaluate,
  check,
  clauseOf,
  missed,
  contradiction,
  hard,
  soft,
  invariantsOf,
  byId,
  validate,
  list,
  item,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Invariant;
