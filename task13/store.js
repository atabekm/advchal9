/* The log, and the one key it lives under.
 *
 * The state is a fold over this, so this file is the whole of persistence:
 * there is no serialised state anywhere, because a serialised state would be a
 * second source of truth that could disagree with the log that produced it.
 *
 * A reload replays. That is also why export is worth having — the log is a
 * complete, readable account of a run, including everything the model tried
 * and was refused, and it fits in a file you can send someone.
 */

const LOG_KEY = 'task13.log';
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
  return JSON.stringify({ task: 13, version: VERSION, saved: new Date().toISOString(), log }, null, 2);
}

/* An imported log is replayed, not trusted. Anything in it the guard would
 * refuse today is skipped and reported — which is also what happens to a log
 * written by an older version of the machine. */
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
  if (!log.every((entry) => entry && typeof entry === 'object' && typeof entry.kind === 'string')) {
    return { ok: false, log: [], error: 'every entry in a log has to be an object with a kind' };
  }
  const { skipped } = Machine.replay(log);
  return { ok: true, log, error: '', skipped };
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
  available: () => storage() !== null,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Store;
