// The store. It knows about slots, bytes, versions and corruption.
// It does not know what a message means, and it never touches the DOM.

const SCHEMA_VERSION = 1;
const SESSION_PREFIX = 'task9.session.';
const ACTIVE_KEY = 'task9.session.active';
const TITLE_LENGTH = 48;

function newId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
  } catch (error) {
    // falls through
  }
  return Math.random().toString(36).slice(2, 10);
}

// Backends are injected the same way transports are. `memoryBackend` is both a
// demonstration that the seam is real and the automatic fallback when the
// browser refuses to hand out localStorage at all.

const localBackend = {
  id: 'localStorage',
  label: 'localStorage (JSON)',

  available() {
    try {
      const probe = '__task9_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  },

  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  },

  set(key, value) {
    localStorage.setItem(key, value);
  },

  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // nothing to undo
    }
  },

  keys(prefix) {
    const found = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(prefix)) found.push(key);
      }
    } catch (error) {
      return [];
    }
    return found;
  },
};

function createMemoryBackend() {
  const cells = new Map();
  return {
    id: 'memory',
    label: 'memory (not persisted)',
    available: () => true,
    get: (key) => (cells.has(key) ? cells.get(key) : null),
    set: (key, value) => { cells.set(key, value); },
    remove: (key) => { cells.delete(key); },
    keys: (prefix) => [...cells.keys()].filter((key) => key.startsWith(prefix)),
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

// null until there is a first user message to name the conversation after.
// A record carrying null is one nobody has named yet, so every save gets
// another chance to derive one; a string is a decision and is left alone.
function titleFrom(messages) {
  const first = (messages || []).find((message) => message.role === 'user');
  if (!first) return null;
  const flat = String(first.content || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH)}…` : flat;
}

class SessionStore {
  constructor(backend, { onEvent } = {}) {
    this._backend = backend && backend.available() ? backend : createMemoryBackend();
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._corrupt = [];
    this._reported = new Set();
  }

  get backend() {
    return { id: this._backend.id, label: this._backend.label };
  }

  get persistent() {
    return this._backend.id !== 'memory';
  }

  get corrupt() {
    return this._corrupt.slice();
  }

  static get version() {
    return SCHEMA_VERSION;
  }

  _emit(type, detail) {
    this._onEvent({ type, ...detail });
  }

  _key(id) {
    return `${SESSION_PREFIX}${id}`;
  }

  // Every read goes through here, so absence, corruption and a version from the
  // future all arrive as the same thing: null, plus a reason on the way past.
  parse(raw, { source = 'store' } = {}) {
    if (raw == null) return null;

    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      throw new StoreError('Not valid JSON.', { kind: 'corrupt' });
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new StoreError('Not a session record.', { kind: 'corrupt' });
    }
    if (record.v == null) {
      throw new StoreError('No schema version — refusing to guess.', { kind: 'corrupt' });
    }
    if (record.v > SCHEMA_VERSION) {
      throw new StoreError(
        `Written by a newer version (v${record.v}, this build reads v${SCHEMA_VERSION}).`,
        { kind: 'version' }
      );
    }
    if (!Array.isArray(record.messages)) {
      throw new StoreError('No messages array.', { kind: 'corrupt' });
    }

    const messages = record.messages
      .filter((message) => message
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string')
      .map((message) => ({
        role: message.role,
        content: message.content,
        at: Number.isFinite(message.at) ? message.at : null,
      }));

    const now = Date.now();
    return {
      v: SCHEMA_VERSION,
      id: typeof record.id === 'string' && record.id ? record.id : newId(),
      title: typeof record.title === 'string' && record.title.trim()
        ? record.title.trim()
        : titleFrom(messages),
      named: typeof record.title === 'string' && Boolean(record.title.trim()),
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : now,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : now,
      provenance: record.provenance && typeof record.provenance === 'object'
        ? { ...record.provenance }
        : null,
      messages,
      pending: record.pending && typeof record.pending === 'object'
        ? {
          turn: Number(record.pending.turn) || 0,
          text: String(record.pending.text || ''),
          startedAt: Number.isFinite(record.pending.startedAt) ? record.pending.startedAt : now,
        }
        : null,
      source,
    };
  }

  serialise(record) {
    return JSON.stringify({
      v: SCHEMA_VERSION,
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      provenance: record.provenance || null,
      messages: record.messages,
      pending: record.pending || null,
    }, null, 2);
  }

  create({ messages = [], provenance = null, title = null } = {}) {
    const now = Date.now();
    return {
      v: SCHEMA_VERSION,
      id: newId(),
      title: title || titleFrom(messages),
      named: Boolean(title),
      createdAt: now,
      updatedAt: now,
      provenance,
      messages,
      pending: null,
    };
  }

  load(id) {
    const key = this._key(id);
    try {
      return this.parse(this._backend.get(key));
    } catch (error) {
      this._note(key, error);
      return null;
    }
  }

  // A scan, not an index. An index would be faster and would eventually
  // disagree with the records it indexes; this cannot drift.
  list() {
    this._corrupt = [];
    const records = [];

    for (const key of this._backend.keys(SESSION_PREFIX)) {
      if (key === ACTIVE_KEY) continue;
      let record = null;
      try {
        record = this.parse(this._backend.get(key));
      } catch (error) {
        this._note(key, error);
        continue;
      }
      if (record) records.push(record);
    }

    records.sort((a, b) => b.updatedAt - a.updatedAt);
    return records;
  }

  // list() runs on every render, so a slot that cannot be read is announced
  // once and then merely listed. The log records what happened, not how often
  // the panel was redrawn.
  _note(key, error) {
    const entry = { key, kind: error.kind || 'corrupt', message: error.message };
    this._corrupt.push(entry);
    if (this._reported.has(key)) return;
    this._reported.add(key);
    this._emit('store:unreadable', entry);
  }

  save(record) {
    const next = { ...record, v: SCHEMA_VERSION, updatedAt: Date.now() };
    if (!next.named) next.title = titleFrom(next.messages);

    const payload = this.serialise(next);
    try {
      this._backend.set(this._key(next.id), payload);
    } catch (error) {
      if (isQuotaError(error)) {
        // Freeing space here would mean deleting somebody's conversation to
        // make room for this one. Report it and let a person choose.
        throw new StoreError(
          'Storage is full. Delete or export a session to make room — '
          + 'nothing was removed automatically.',
          { kind: 'quota', key: next.id }
        );
      }
      throw new StoreError(`Could not write the session: ${error.message}`, { kind: 'write' });
    }

    this._emit('store:save', { id: next.id, messages: next.messages.length, bytes: payload.length });
    return next;
  }

  remove(id) {
    this._backend.remove(this._key(id));
    if (this.lastActiveId() === id) this.setLastActiveId(null);
    this._emit('store:remove', { id });
  }

  removeKey(key) {
    this._backend.remove(key);
    this._corrupt = this._corrupt.filter((entry) => entry.key !== key);
    this._reported.delete(key);
  }

  rename(id, title) {
    const record = this.load(id);
    if (!record) return null;
    // An empty rename is not a blank name, it is a withdrawal: the record goes
    // back to deriving its title from what was said in it.
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    record.title = clean ? clean.slice(0, 120) : null;
    record.named = Boolean(clean);
    return this.save(record);
  }

  markPending(id, pending) {
    const record = this.load(id);
    if (!record) return null;
    record.pending = pending;
    return this.save(record);
  }

  clearPending(id) {
    const record = this.load(id);
    if (!record || !record.pending) return record;
    record.pending = null;
    return this.save(record);
  }

  lastActiveId() {
    return this._backend.get(ACTIVE_KEY);
  }

  setLastActiveId(id) {
    if (id) {
      try {
        this._backend.set(ACTIVE_KEY, id);
      } catch (error) {
        // an unwritable pointer is not worth failing a turn over
      }
    } else {
      this._backend.remove(ACTIVE_KEY);
    }
  }

  // Imported records keep their content and lose their identity: a fresh id
  // unless the slot is genuinely free, so importing can never overwrite.
  import(raw) {
    const record = this.parse(raw, { source: 'import' });
    if (!record) throw new StoreError('The file was empty.', { kind: 'corrupt' });

    const taken = this._backend.get(this._key(record.id)) != null;
    const now = Date.now();
    const landed = {
      ...record,
      id: taken ? newId() : record.id,
      updatedAt: now,
      pending: null,
    };
    const saved = this.save(landed);
    this._emit('store:import', {
      id: saved.id,
      messages: saved.messages.length,
      renamed: taken,
    });
    return saved;
  }

  usage() {
    let bytes = 0;
    let sessions = 0;
    for (const key of this._backend.keys(SESSION_PREFIX)) {
      const raw = this._backend.get(key);
      if (raw == null) continue;
      bytes += key.length + raw.length;
      if (key !== ACTIVE_KEY) sessions += 1;
    }
    return { bytes, sessions, backend: this._backend.id, persistent: this.persistent };
  }
}
