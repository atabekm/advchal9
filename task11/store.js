/* Persistence.
 *
 * Three layers with three lifetimes, written to three key namespaces:
 *
 *   task11.dialogue.<id>   the messages, and the routing log that goes with
 *                          them. One per conversation.
 *   task11.task.<id>       one working-memory record per task, open or
 *                          archived.
 *   task11.profile         one record, shared by every conversation this
 *                          browser has ever had.
 *
 * This file is the place where "the layers are stored separately" stops being
 * a diagram and becomes something a person can check with the devtools open.
 * Delete `task11.profile` and the agent forgets your name and keeps the
 * deadline. Delete the task record and it forgets the deadline and still knows
 * your name. Nothing else in the app has to be consulted to know that, and
 * nothing else in the app could have made it true.
 *
 * One record with a `layer` column would have been less code. It would also
 * have made every one of those sentences a claim about a `WHERE` clause.
 *
 *   store.dialogues   .create .load .save .list .remove .active
 *   store.tasks       .save .load .list .open .archived .remove
 *   store.profile     .load .save .clear
 *   store.usage()     bytes per namespace, which is the demonstration
 *   store.wipe(which) delete one namespace and watch what is lost
 *
 * It knows about slots, bytes, versions and corruption. It does not know what
 * a message means and it never touches the DOM.
 */

const NS = {
  dialogue: 'task11.dialogue.',
  task: 'task11.task.',
  profile: 'task11.profile',
  active: 'task11.active',
};

const VERSION = 1;
const TITLE_LENGTH = 48;

function newId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
  } catch (error) {
    // falls through to the arithmetic
  }
  return Math.random().toString(36).slice(2, 10);
}

/* Backends are injected, and the in-memory one is not a test double — it is
 * what runs when a browser refuses to hand out localStorage at all (private
 * mode, a blocked origin, a thumbnail capture). The app still works; it just
 * forgets everything when the tab closes, and says so where the user can see
 * it rather than throwing on the first write. */
const localBackend = {
  id: 'localStorage',
  label: 'localStorage',
  available() {
    try {
      const probe = '__task11_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  },
  get(key) { try { return localStorage.getItem(key); } catch (error) { return null; } },
  set(key, value) { localStorage.setItem(key, value); },
  remove(key) { try { localStorage.removeItem(key); } catch (error) { /* gone already */ } },
  keys(prefix) {
    const found = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) found.push(key);
      }
    } catch (error) {
      return [];
    }
    return found;
  },
};

function createMemoryBackend() {
  const map = new Map();
  return {
    id: 'memory',
    label: 'memory (nothing survives this tab)',
    available() { return true; },
    get(key) { return map.has(key) ? map.get(key) : null; },
    set(key, value) { map.set(key, value); },
    remove(key) { map.delete(key); },
    keys(prefix) { return [...map.keys()].filter((key) => key.startsWith(prefix)); },
  };
}

class StoreError extends Error {
  constructor(message, { kind = 'write', key = null } = {}) {
    super(message);
    this.name = 'StoreError';
    this.kind = kind;
    this.key = key;
  }
}

function isQuotaError(error) {
  if (!error) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014;
}

function titleFrom(messages) {
  const first = (messages || []).find((m) => m && m.role === 'user' && m.content);
  if (!first) return 'Untitled';
  const line = String(first.content).replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

/* One namespace, one shape.
 *
 * Dialogues and tasks are both "many records under a prefix", so they share
 * this. The profile is not — it is exactly one record — and giving it a Shelf
 * with a single key would have been the tidier abstraction and the less honest
 * one. Their lifetimes differ, so their code differs.
 */
class Shelf {
  constructor(backend, { prefix, kind, parse, onEvent }) {
    this._backend = backend;
    this._prefix = prefix;
    this._kind = kind;
    this._parse = parse;
    this._onEvent = onEvent || (() => {});
    this._corrupt = [];
  }

  get prefix() { return this._prefix; }
  get corrupt() { return this._corrupt.slice(); }

  _key(id) { return `${this._prefix}${id}`; }

  read(id) {
    const key = this._key(id);
    const raw = this._backend.get(key);
    if (!raw) return null;
    try {
      const record = this._parse(JSON.parse(raw));
      if (!record) throw new Error('not a record of this kind');
      return record;
    } catch (error) {
      /* A record that will not parse is not deleted. It is listed, named, and
       * left where it is — the one thing worse than losing a conversation is
       * an app that tidies it away before anyone can look at it. */
      if (!this._corrupt.some((entry) => entry.key === key)) {
        this._corrupt.push({ key, reason: error.message });
        this._onEvent('storage', { kind: 'corrupt', key, reason: error.message });
      }
      return null;
    }
  }

  write(record) {
    const key = this._key(record.id);
    const body = JSON.stringify({ ...record, v: VERSION });
    try {
      this._backend.set(key, body);
    } catch (error) {
      if (isQuotaError(error)) {
        throw new StoreError(
          `Storage is full. ${this._kind} "${record.id}" was not saved.`,
          { kind: 'quota', key }
        );
      }
      throw new StoreError(`Could not save ${this._kind}: ${error.message}`, { key });
    }
    this._onEvent('storage', { kind: 'write', key, bytes: body.length });
    return record;
  }

  remove(id) {
    const key = this._key(id);
    this._backend.remove(key);
    this._onEvent('storage', { kind: 'remove', key });
  }

  ids() {
    return this._backend.keys(this._prefix).map((key) => key.slice(this._prefix.length));
  }

  list() {
    return this.ids()
      .map((id) => this.read(id))
      .filter(Boolean);
  }

  bytes() {
    return this._backend.keys(this._prefix)
      .reduce((sum, key) => sum + (this._backend.get(key) || '').length, 0);
  }

  wipe() {
    const keys = this._backend.keys(this._prefix);
    for (const key of keys) this._backend.remove(key);
    this._onEvent('storage', { kind: 'wipe', prefix: this._prefix, count: keys.length });
    return keys.length;
  }
}

/* ------------------------------------------------------------------ shapes */

/* A dialogue record: the short-term layer, plus what it is called and what the
 * router did while it was open.
 *
 * The routing log lives here rather than in its own namespace because it is a
 * record of *this conversation's* decisions and has exactly the conversation's
 * lifetime. Putting it in a fourth namespace would have implied it outlives
 * something, and it does not.
 */
function parseDialogue(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    v: VERSION,
    id: String(raw.id),
    title: String(raw.title || 'Untitled'),
    created: Number(raw.created) || Date.now(),
    updated: Number(raw.updated) || Date.now(),
    taskId: raw.taskId ? String(raw.taskId) : null,
    short: raw.short && typeof raw.short === 'object' ? raw.short : { messages: [] },
    log: Array.isArray(raw.log) ? raw.log : [],
  };
}

/* A task record: the working layer, whether it is open or archived.
 *
 * `closed` is the whole distinction. An open task is the one working layer
 * currently being written to; a closed one is a thing that happened, kept so
 * that a decision promoted to long-term can still name the task it was made
 * in. Archiving is not deletion, and a promoted decision whose origin had been
 * deleted would be a fact with a citation pointing at nothing.
 */
function parseTask(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    v: VERSION,
    id: String(raw.id),
    goal: raw.goal ? String(raw.goal) : null,
    opened: Number(raw.opened) || Date.now(),
    closed: raw.closed ? Number(raw.closed) : null,
    dialogueId: raw.dialogueId ? String(raw.dialogueId) : null,
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

function parseProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    v: VERSION,
    profile: Array.isArray(raw.profile) ? raw.profile : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
    knowledge: Array.isArray(raw.knowledge) ? raw.knowledge : [],
    retracted: Array.isArray(raw.retracted) ? raw.retracted : [],
    updated: Number(raw.updated) || Date.now(),
  };
}

/* ---------------------------------------------------------------- the store */

class Persistence {
  constructor(backend = localBackend, { onEvent } = {}) {
    this._backend = backend && backend.available() ? backend : createMemoryBackend();
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    const shelf = (prefix, kind, parse) => new Shelf(this._backend, {
      prefix, kind, parse, onEvent: this._onEvent,
    });
    this._dialogues = shelf(NS.dialogue, 'dialogue', parseDialogue);
    this._tasks = shelf(NS.task, 'task', parseTask);
  }

  static get version() { return VERSION; }
  static get namespaces() { return { ...NS }; }

  get backend() { return { id: this._backend.id, label: this._backend.label }; }
  get persistent() { return this._backend.id !== 'memory'; }
  get corrupt() { return [...this._dialogues.corrupt, ...this._tasks.corrupt]; }

  /* ---- short-term: one record per conversation ---- */

  createDialogue({ short = { messages: [] }, taskId = null } = {}) {
    const record = parseDialogue({
      id: newId(),
      title: titleFrom(short.messages),
      created: Date.now(),
      updated: Date.now(),
      taskId,
      short,
      log: [],
    });
    return record;
  }

  loadDialogue(id) { return this._dialogues.read(id); }

  saveDialogue(record) {
    const next = {
      ...record,
      title: record.title && record.title !== 'Untitled'
        ? record.title
        : titleFrom(record.short && record.short.messages),
      updated: Date.now(),
      // The log is a record of this run and it is not allowed to grow into the
      // conversation it describes.
      log: (record.log || []).slice(0, 200),
    };
    this._dialogues.write(next);
    return next;
  }

  listDialogues() {
    return this._dialogues.list().sort((a, b) => b.updated - a.updated);
  }

  removeDialogue(id) { this._dialogues.remove(id); }

  /* ---- working: one record per task ---- */

  saveTask(record) {
    if (!record || !record.id) return null;
    const next = parseTask(record);
    this._tasks.write(next);
    return next;
  }

  loadTask(id) { return id ? this._tasks.read(id) : null; }

  listTasks() {
    return this._tasks.list().sort((a, b) => (b.closed || b.opened) - (a.closed || a.opened));
  }

  openTasks() { return this.listTasks().filter((task) => !task.closed); }

  archivedTasks() { return this.listTasks().filter((task) => task.closed); }

  removeTask(id) { this._tasks.remove(id); }

  /* ---- long-term: exactly one record, for everyone ---- */

  loadProfile() {
    const raw = this._backend.get(NS.profile);
    if (!raw) return null;
    try {
      return parseProfile(JSON.parse(raw));
    } catch (error) {
      this._onEvent('storage', { kind: 'corrupt', key: NS.profile, reason: error.message });
      return null;
    }
  }

  saveProfile(snapshot) {
    const record = parseProfile({ ...snapshot, updated: Date.now() });
    const body = JSON.stringify(record);
    try {
      this._backend.set(NS.profile, body);
    } catch (error) {
      if (isQuotaError(error)) {
        throw new StoreError('Storage is full. The profile was not saved.', { kind: 'quota', key: NS.profile });
      }
      throw new StoreError(`Could not save the profile: ${error.message}`, { key: NS.profile });
    }
    this._onEvent('storage', { kind: 'write', key: NS.profile, bytes: body.length });
    return record;
  }

  clearProfile() {
    this._backend.remove(NS.profile);
    this._onEvent('storage', { kind: 'remove', key: NS.profile });
  }

  /* ---- which conversation was last open ---- */

  lastActive() {
    const raw = this._backend.get(NS.active);
    return raw ? String(raw) : null;
  }

  setLastActive(id) {
    try {
      if (id) this._backend.set(NS.active, String(id));
      else this._backend.remove(NS.active);
    } catch (error) {
      // A pointer is not worth failing a turn over.
    }
  }

  /* ---- the demonstration ---- */

  /* Bytes per namespace.
   *
   * The panel draws this as three bars, and the three bars are the argument:
   * they move independently, because they are three keys. A `layer` column in
   * one record would draw one bar and a caption asking to be believed. */
  usage() {
    const dialogues = this._dialogues.bytes();
    const tasks = this._tasks.bytes();
    const profile = (this._backend.get(NS.profile) || '').length;
    return {
      backend: this.backend,
      persistent: this.persistent,
      total: dialogues + tasks + profile,
      layers: [
        { layer: 'short', namespace: NS.dialogue + '*', bytes: dialogues, records: this._dialogues.ids().length },
        { layer: 'working', namespace: NS.task + '*', bytes: tasks, records: this._tasks.ids().length },
        { layer: 'long', namespace: NS.profile, bytes: profile, records: profile ? 1 : 0 },
      ],
    };
  }

  /* Delete one layer's storage and nothing else.
   *
   * This exists to be used in front of an audience. "The layers are separate"
   * is a claim; this button is the experiment, and the experiment is only
   * meaningful because the three namespaces were separate before anybody
   * pressed it. */
  wipe(which = 'all') {
    if (which === 'short') return { removed: this._dialogues.wipe() };
    if (which === 'working') return { removed: this._tasks.wipe() };
    if (which === 'long') {
      const had = Boolean(this._backend.get(NS.profile));
      this.clearProfile();
      return { removed: had ? 1 : 0 };
    }
    const removed = this._dialogues.wipe() + this._tasks.wipe() + (this._backend.get(NS.profile) ? 1 : 0);
    this.clearProfile();
    this._backend.remove(NS.active);
    return { removed };
  }
}
