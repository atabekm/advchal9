/* The log in localStorage, and nothing clever.
 *
 * The state is a fold over this list, so this file holds the only durable
 * thing in the app. What it deliberately does not hold is worth naming: there
 * is no stored state, no stored offers, no stored "whose turn it is". Every one
 * of those is worked out again from the log on every read, which is what makes
 * "resuming re-derives rather than restores" a property of the architecture
 * rather than a claim in a README.
 */

const LOG_KEY = 'task15.log';
const VERSION = 1;

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch (error) {
    return null;
  }
}

function read() {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function write(log) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(LOG_KEY, JSON.stringify(log));
    return true;
  } catch (error) {
    return false;
  }
}

function append(log, entry) {
  const next = [...log, { at: Date.now(), ...entry }];
  write(next);
  return next;
}

function clear() {
  const store = storage();
  if (store) {
    try { store.removeItem(LOG_KEY); } catch (error) { /* nothing to do */ }
  }
  return [];
}

function serialise(log) {
  return JSON.stringify({ task: 15, version: VERSION, saved: new Date().toISOString(), log }, null, 2);
}

/* An imported log is replayed, not trusted. Anything in it the runtime would
 * refuse today is walked past and reported — which is also what happens to a
 * log written by an older version of the table. A log is a list of moves
 * somebody once made; it is not a certificate that they were legal. */
function parseLog(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, log: [], error: `that is not JSON: ${error.message}` };
  }
  const log = Array.isArray(parsed) ? parsed : parsed && parsed.log;
  if (!Array.isArray(log)) {
    return { ok: false, log: [], error: 'no log in there — expected an array, or an object with a log in it' };
  }
  const shaped = log.every((entry) => entry && typeof entry === 'object'
    && (entry.type === 'transition' || entry.type === 'action'));
  if (!shaped) {
    return { ok: false, log: [], error: 'every entry in a log is a move — an object with a type of transition or action' };
  }
  const { skipped } = Lifecycle.replay(log);
  return { ok: true, log, error: '', skipped };
}

/* A short hash of the log, so the page can show that a reload changed nothing
 * and a test can assert it. */
function logFingerprint(log = read()) {
  const source = JSON.stringify(log.map((entry) => {
    const { at, ...rest } = entry;
    return rest;
  }));
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const Store = {
  LOG_KEY,
  VERSION,
  read,
  write,
  append,
  clear,
  serialise,
  parse: parseLog,
  fingerprint: logFingerprint,
  available: () => storage() !== null,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Store;
