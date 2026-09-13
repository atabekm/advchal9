// The store. It knows about slots, bytes, versions and corruption.
// It does not know what a message means, and it never touches the DOM.

/* v2 added `memory`: the summary chain, the cut point that goes with it, and —
 * since task 10 — the facts, which live in the same field because they are the
 * same half of the conversation.
 *
 * v3 adds `branches`: the tree. `messages` stays exactly what it was, the head
 * branch's resolved conversation, so a v3 record is still a readable
 * conversation to anything that has never heard of a branch, and so that the
 * one field a person would go looking for in a JSON export is the one they
 * expect. The tree is beside it, not instead of it.
 *
 * Older records are not corrupt, they are older. A v1 loads with no memory,
 * which reads as "nothing folded yet". A v2 loads with no tree, which reads as
 * "one branch, and it is this conversation" — which is what every conversation
 * before this task was. Nothing is migrated eagerly and nothing is thrown
 * away. */
const SCHEMA_VERSION = 3;
const SESSION_PREFIX = 'task10.session.';
const ACTIVE_KEY = 'task10.session.active';
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
      const probe = '__task10_probe__';
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

/* A stored summary chain, validated the same way messages are: anything that
 * is not the right shape is dropped rather than trusted. A summary that has
 * been tampered with goes into the system slot of every future request, so this
 * is the one field in the record where a shrug would be expensive. */
/* The facts, validated as carefully as the summaries and for the same reason:
 * this is the one field where a shrug would be expensive, because a tampered
 * value lands in the system slot of every future request wearing the word
 * "verbatim". Restoring cannot re-check a value against a message that is no
 * longer in the record — the message may be four branches away — so what is
 * checked here is shape: a key, and either a value or a tombstone. */
function parseFacts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.facts)) {
    return null;
  }
  return {
    facts: raw.facts
      .filter((fact) => fact && typeof fact.key === 'string' && fact.key.trim()
        && (typeof fact.value === 'string' || fact.cleared))
      .map((fact) => ({
        key: fact.key,
        value: typeof fact.value === 'string' ? fact.value : null,
        kind: typeof fact.kind === 'string' ? fact.kind : 'other',
        cleared: Boolean(fact.cleared),
        first: Number(fact.first) || 0,
        confirmed: Number(fact.confirmed) || 0,
        source: fact.source && typeof fact.source === 'object'
          ? {
            index: Number(fact.source.index),
            turn: Number(fact.source.turn) || 0,
            // Who said it. A record written before this field existed is the
            // user's, because that is all the store could hold at the time.
            role: fact.source.role === 'assistant' ? 'assistant' : 'user',
          }
          : { index: null, turn: 0, role: 'user' },
        history: Array.isArray(fact.history)
          ? fact.history
            .filter((entry) => entry && typeof entry.value === 'string')
            .map((entry) => ({
              value: entry.value,
              turn: Number(entry.turn) || 0,
              index: Number.isFinite(Number(entry.index)) ? Number(entry.index) : null,
              role: entry.role === 'assistant' ? 'assistant' : 'user',
              until: Number(entry.until) || 0,
            }))
          : [],
      })),
    stats: raw.stats && typeof raw.stats === 'object' ? { ...raw.stats } : {},
  };
}

/* The tree.
 *
 * Two things are enforced rather than trusted, because both of them turn a bad
 * record into a broken program rather than a missing one: every branch keeps
 * its own messages only, so a branch with a rewritten prefix cannot be smuggled
 * in, and the parent links are left to BranchTree.restore to rebuild — it
 * plants parents before children and reattaches orphans, which is the only
 * place that knows how to refuse a cycle. Here the job is shape. */
function parseBranches(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = Array.isArray(raw.branches) ? raw.branches : [];
  const branches = list
    .filter((branch) => branch && typeof branch.id === 'string' && branch.id)
    .map((branch) => ({
      id: branch.id,
      name: typeof branch.name === 'string' ? branch.name : 'branch',
      parent: typeof branch.parent === 'string' && branch.parent ? branch.parent : null,
      forkIndex: Math.max(0, Number(branch.forkIndex) || 0),
      created: Number.isFinite(branch.created) ? branch.created : Date.now(),
      note: typeof branch.note === 'string' ? branch.note : '',
      messages: Array.isArray(branch.messages)
        ? branch.messages
          .filter((message) => message
            && (message.role === 'user' || message.role === 'assistant')
            && typeof message.content === 'string')
          .map((message) => ({
            role: message.role,
            content: message.content,
            at: Number.isFinite(message.at) ? message.at : null,
          }))
        : [],
      memory: parseMemory(branch.memory),
    }));

  if (!branches.length) return null;

  return {
    head: typeof raw.head === 'string' ? raw.head : null,
    root: typeof raw.root === 'string' ? raw.root : null,
    seq: Number(raw.seq) || 0,
    branches,
    checkpoints: (Array.isArray(raw.checkpoints) ? raw.checkpoints : [])
      .filter((point) => point && typeof point.branch === 'string')
      .map((point) => ({
        id: typeof point.id === 'string' ? point.id : null,
        branch: point.branch,
        at: Math.max(0, Number(point.at) || 0),
        label: typeof point.label === 'string' ? point.label : '',
        created: Number.isFinite(point.created) ? point.created : Date.now(),
      })),
  };
}

function parseMemory(memory) {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return null;

  const summaries = Array.isArray(memory.summaries)
    ? memory.summaries
      .filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
      .map((entry, index) => ({
        generation: Number(entry.generation) || index + 1,
        text: entry.text,
        tokens: Number(entry.tokens) || 0,
        model: typeof entry.model === 'string' ? entry.model : null,
        at: Number.isFinite(entry.at) ? entry.at : Date.now(),
        covers: Number(entry.covers) || 0,
        foldedMessages: Number(entry.foldedMessages) || 0,
        foldedTokens: Number(entry.foldedTokens) || 0,
        savedPerTurn: Number(entry.savedPerTurn) || 0,
        spentTokens: Number(entry.spentTokens) || 0,
        spentCost: Number(entry.spentCost) || 0,
        reason: typeof entry.reason === 'string' ? entry.reason : null,
        truncated: Boolean(entry.truncated),
      }))
    : [];

  const facts = parseFacts(memory.facts);

  // Either half is enough to be worth keeping. A conversation held under
  // `facts` has never folded, and one held under `compress` has no facts, and
  // both of them have a compressed half that a v1 record does not.
  if (!summaries.length && !(facts && facts.facts.length)) return null;

  const spent = memory.spent && typeof memory.spent === 'object' ? memory.spent : {};
  return {
    folded: Math.max(0, Number(memory.folded) || 0),
    summaries,
    facts,
    spent: {
      folds: Number(spent.folds) || summaries.length,
      tokens: Number(spent.tokens) || 0,
      cost: Number(spent.cost) || 0,
      failures: Number(spent.failures) || 0,
    },
  };
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
      /* The compressed half of the conversation. Stored beside the messages
       * rather than inside them, because a summary is not something anybody
       * said — and because the panel has to be able to show both at once.
       * A v1 record has none, which reads as "nothing folded yet". */
      memory: parseMemory(record.memory),
      /* The tree. A v2 record has none, which reads as "one branch, and it is
       * this conversation" — true of every conversation before task 10. */
      branches: parseBranches(record.branches),
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
      memory: record.memory || null,
      branches: record.branches || null,
      pending: record.pending || null,
    }, null, 2);
  }

  create({ messages = [], provenance = null, title = null, memory = null, branches = null } = {}) {
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
      memory: memory || null,
      branches: branches || null,
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

    this._emit('store:save', {
      id: next.id,
      messages: next.messages.length,
      summaries: next.memory ? next.memory.summaries.length : 0,
      branches: next.branches ? next.branches.branches.length : 1,
      bytes: payload.length,
    });
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
