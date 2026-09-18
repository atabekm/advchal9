/* Where the invariants live, which is not where the conversation lives.
 *
 * "Stored separately from the dialogue" is the brief's first bullet and it is
 * usually satisfied by putting the rules in a different variable. That is
 * filing, not separation. Three properties are:
 *
 *   a different key      — `task14.invariants`, never `task14.log`. The run can
 *                          be cleared without touching the rules, and the rules
 *                          can be exported on their own.
 *   append-only          — an amendment does not edit. It appends, with who,
 *                          when and why, and the set at any revision is a fold
 *                          over the amendments up to it.
 *   the model is not a   — there is no code path from a reply to this file. A
 *   writer                 granted amendment is a USER action; what the model
 *                          did was ask, and the record says so in a separate
 *                          field.
 *
 * The third is what the whole task turns on, so nothing here takes an author
 * as an argument. Every amendment is written `by: 'user'`, and `requested`
 * carries the model's case when there was one. A model cannot become an author
 * by passing a different string, because there is no string to pass.
 *
 * The set is a fold over its amendments for the same reason task 13's state
 * was a fold over its events: a stored current set would be a second source of
 * truth that could disagree with the history that produced it, and the history
 * is the only evidence that the rules were not quietly rewritten mid-run.
 */

const INVARIANT_KEY = 'task14.invariants';
const RUN_KEY = 'task14.log';
const SCHEMA = 1;

/* No localStorage means node, which means the tests. An in-memory fallback
 * keeps the store drivable without shimming a DOM, and it is not a second
 * implementation — it is the same code with a different Map underneath. */
const memory = new Map();

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem(INVARIANT_KEY);
    return localStorage;
  } catch (error) {
    return null;
  }
}

function readKey(key, fallback) {
  const store = storage();
  try {
    const raw = store ? store.getItem(key) : memory.get(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (error) {
    return fallback;
  }
}

function writeKey(key, value) {
  const store = storage();
  const raw = JSON.stringify(value);
  try {
    if (store) store.setItem(key, raw);
    else memory.set(key, raw);
    return true;
  } catch (error) {
    return false;
  }
}

/* ------------------------------------------------------- the amendment log */

function now() {
  return Date.now();
}

/* The seed is an amendment like any other, so a set has no state that predates
 * its history. `by: 'code'` is the honest author: these were compiled in, not
 * decided by whoever opened the page. */
function seed(setId) {
  const source = Invariant.SETS[setId];
  if (!source) return null;
  return {
    action: 'seed',
    at: 0,
    by: 'code',
    requested: null,
    why: 'shipped with the page',
    invariants: JSON.parse(JSON.stringify(source.invariants)),
  };
}

function amendments(setId) {
  const all = readKey(INVARIANT_KEY, null);
  const stored = all && all.sets && Array.isArray(all.sets[setId]) ? all.sets[setId] : null;
  const head = seed(setId);
  if (!head) return [];
  if (!stored || !stored.length) return [head];
  /* The seed is never persisted — it comes from the code every time. A stored
   * seed would be a copy of the shipped set that could silently drift from it
   * across an edit to invariant.js. */
  return [head, ...stored.filter((one) => one.action !== 'seed')];
}

/* The fold. Nothing mutates a set; this is the only way one comes into being. */
function fold(log) {
  let invariants = [];
  const history = [];
  log.forEach((entry, index) => {
    const step = { ...entry, rev: index };
    if (entry.action === 'seed') {
      invariants = JSON.parse(JSON.stringify(entry.invariants || []));
    } else if (entry.action === 'add') {
      invariants = invariants.concat(JSON.parse(JSON.stringify(entry.invariant)));
    } else if (entry.action === 'amend') {
      invariants = invariants.map((one) => (one.id === entry.id
        ? { ...one, ...JSON.parse(JSON.stringify(entry.to)) }
        : one));
    } else if (entry.action === 'retire') {
      invariants = invariants.filter((one) => one.id !== entry.id);
    }
    history.push(step);
  });
  return { invariants, history, rev: log.length - 1 };
}

function set(setId) {
  const source = Invariant.SETS[setId];
  if (!source) return null;
  const folded = fold(amendments(setId));
  return {
    id: source.id,
    name: source.name,
    subject: source.subject,
    invariants: folded.invariants,
    rev: folded.rev,
    history: folded.history,
  };
}

/* The set as it stood at an earlier revision. The point of an append-only log
 * is that this is answerable at all — "what were the rules when that was
 * proposed" has an answer, and it is not "whatever they are now". */
function setAt(setId, rev) {
  const source = Invariant.SETS[setId];
  if (!source) return null;
  const folded = fold(amendments(setId).slice(0, rev + 1));
  return { id: source.id, name: source.name, subject: source.subject, invariants: folded.invariants, rev };
}

function activeId() {
  const all = readKey(INVARIANT_KEY, null);
  const wanted = all && all.active;
  return Invariant.SETS[wanted] ? wanted : 'repo';
}

function active() {
  return set(activeId());
}

function selectSet(setId) {
  if (!Invariant.SETS[setId]) return false;
  const all = readKey(INVARIANT_KEY, null) || { schema: SCHEMA, active: 'repo', sets: {} };
  all.active = setId;
  all.schema = SCHEMA;
  return writeKey(INVARIANT_KEY, all);
}

/* ------------------------------------------------------------- amendments */

const ACTIONS = ['add', 'amend', 'retire'];

/* The one door into the invariant store, and it is a user's door.
 *
 * `requested` is where a model's case goes when the user granted one. It is a
 * record of who asked, next to a record of who decided, and they are different
 * fields because they are different people.
 */
function amend(setId, change) {
  const current = set(setId);
  if (!current) return { ok: false, refusal: 'no such set' };
  if (!ACTIONS.includes(change && change.action)) return { ok: false, refusal: 'unknown action' };
  if (!String(change.why || '').trim()) return { ok: false, refusal: 'an amendment has to say why' };

  const entry = {
    action: change.action,
    at: now(),
    by: 'user',
    requested: change.requested ? String(change.requested).slice(0, 2000) : null,
    why: String(change.why).slice(0, 2000),
  };

  if (change.action === 'add') {
    const problems = Invariant.validate(change.invariant);
    if (problems.length) return { ok: false, refusal: problems.join('; ') };
    if (Invariant.byId(current, change.invariant.id)) return { ok: false, refusal: 'that id is taken' };
    entry.invariant = JSON.parse(JSON.stringify(change.invariant));
    entry.id = change.invariant.id;
  } else {
    const target = Invariant.byId(current, change.id);
    if (!target) return { ok: false, refusal: 'no invariant carries that id' };
    entry.id = target.id;
    if (change.action === 'amend') {
      const merged = { ...target, ...change.to };
      const problems = Invariant.validate(merged);
      if (problems.length) return { ok: false, refusal: problems.join('; ') };
      entry.to = JSON.parse(JSON.stringify(change.to));
      entry.before = JSON.parse(JSON.stringify(target));
    }
  }

  const all = readKey(INVARIANT_KEY, null) || { schema: SCHEMA, active: activeId(), sets: {} };
  all.schema = SCHEMA;
  all.sets = all.sets || {};
  const stored = Array.isArray(all.sets[setId]) ? all.sets[setId] : [];
  all.sets[setId] = stored.concat(entry);
  if (!writeKey(INVARIANT_KEY, all)) return { ok: false, refusal: 'the store would not take it' };
  return { ok: true, entry, set: set(setId) };
}

/* How often a request to lift a rule was granted.
 *
 * A user who grants every amendment has preferences, not invariants. The rate
 * is printed rather than hidden, because a set with a high one is telling on
 * itself and that is worth knowing before trusting anything downstream of it.
 */
function grantRate(setId) {
  const granted = amendments(setId).filter((one) => one.requested).length;
  const asked = runOf(setId).filter((turn) => turn.move === 'request_amendment').length;
  return { granted, asked, rate: asked ? granted / asked : null };
}

function resetSet(setId) {
  const all = readKey(INVARIANT_KEY, null) || { schema: SCHEMA, active: activeId(), sets: {} };
  all.sets = all.sets || {};
  delete all.sets[setId];
  return writeKey(INVARIANT_KEY, all);
}

/* ---------------------------------------------------------------- the run */

/* One log, filtered on read.
 *
 * A conversation belongs to a set, because the ids do: INV-2 is "no runtime
 * dependencies" in one of them and "services are written in Go" in the other.
 * A view that mixes the two will eventually offer to retire the wrong rule,
 * which it did, before this existed.
 *
 * Filtering on read rather than splitting the key keeps the log a complete
 * account of everything that happened — including the turns of a conversation
 * you have since cleared out of the other set — and keeps the run one
 * exportable object. `runOf` is the view; `run` is the record. */
function run() {
  const log = readKey(RUN_KEY, null);
  return Array.isArray(log) ? log : [];
}

function runOf(setId) {
  return run().filter((turn) => turn.set === setId);
}

function appendTurn(turn) {
  const log = run().concat({ at: now(), ...turn });
  return writeKey(RUN_KEY, log) ? log : run();
}

/* Clearing one conversation leaves the other standing, and leaves the
 * invariants alone in both cases — that is the whole reason they are under a
 * different key. Called with nothing, it clears everything. */
function clearRun(setId) {
  const kept = setId ? run().filter((turn) => turn.set !== setId) : [];
  return writeKey(RUN_KEY, kept) ? kept : run();
}

/* --------------------------------------------------------- in and out */

function exportInvariants() {
  const all = readKey(INVARIANT_KEY, null) || { schema: SCHEMA, active: activeId(), sets: {} };
  return JSON.stringify({ schema: SCHEMA, active: all.active || 'repo', sets: all.sets || {} }, null, 2);
}

function importInvariants(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, refusal: 'not JSON' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, refusal: 'not an object' };
  if (parsed.schema !== SCHEMA) return { ok: false, refusal: `schema ${parsed.schema} is not ${SCHEMA}` };
  const sets = parsed.sets && typeof parsed.sets === 'object' ? parsed.sets : {};
  for (const [setId, log] of Object.entries(sets)) {
    if (!Invariant.SETS[setId]) return { ok: false, refusal: `no such set: ${setId}` };
    if (!Array.isArray(log)) return { ok: false, refusal: `${setId} is not a log` };
    for (const entry of log) {
      if (!ACTIONS.includes(entry.action)) return { ok: false, refusal: `unknown action: ${entry.action}` };
      /* An import cannot smuggle in an authorship the app would never write. */
      if (entry.by !== 'user') return { ok: false, refusal: `amendments are written by the user, not by ${entry.by}` };
    }
  }
  const active = Invariant.SETS[parsed.active] ? parsed.active : 'repo';
  return writeKey(INVARIANT_KEY, { schema: SCHEMA, active, sets })
    ? { ok: true, active, sets: Object.keys(sets) }
    : { ok: false, refusal: 'the store would not take it' };
}

function exportRun() {
  return JSON.stringify({ schema: SCHEMA, log: run() }, null, 2);
}

/* A stable print of the RULES, for the one test worth running on them: drive a
 * whole adversarial run, then compare this before and after. Any run that has
 * not been granted an amendment must leave it identical.
 *
 * `active` is deliberately not in it. Which project you have open is not a
 * rule, and counting it as one would make switching tabs look like an
 * amendment — the loudest possible false positive on the one claim this
 * function exists to check. */
function fingerprint() {
  const all = readKey(INVARIANT_KEY, null) || {};
  return JSON.stringify(all.sets || {});
}

/* Used by the tests to start from nothing, and by the page's reset button.
 * Two keys, cleared independently, because that is the property being kept. */
function wipe(what) {
  if (what !== 'run') writeKey(INVARIANT_KEY, { schema: SCHEMA, active: 'repo', sets: {} });
  if (what !== 'invariants') writeKey(RUN_KEY, []);
}

const Store = {
  INVARIANT_KEY,
  RUN_KEY,
  SCHEMA,
  ACTIONS,
  seed,
  amendments,
  fold,
  set,
  setAt,
  activeId,
  active,
  selectSet,
  amend,
  grantRate,
  resetSet,
  run,
  runOf,
  appendTurn,
  clearRun,
  exportInvariants,
  importInvariants,
  exportRun,
  fingerprint,
  wipe,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Store;
