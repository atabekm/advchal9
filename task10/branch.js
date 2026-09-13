/* The tree.
 *
 * The first two strategies in this task answer the same question task 8 and
 * task 9 asked — *how much of the path goes up the wire* — and they answer it
 * with a slice and with a block. This file does not answer that question. It
 * changes what the path is.
 *
 * Up to here a conversation has been a stack: every message lands on top of the
 * last one, and the only way to try a second version of turn eleven is to
 * destroy the first. That is a strange restriction to have inherited, because
 * the thing people actually do with a requirements conversation is argue about
 * a fork in it — ship in March with less, or ship in April with all of it —
 * and a stack forces that argument to happen twice, in two chats, with the
 * first ten messages retyped.
 *
 * So: branches. A branch owns only what it added, and reads its parent for
 * everything before the fork. Two properties follow, and they are the reason
 * this is a context strategy rather than a piece of interface:
 *
 *   - the prefix is stored once and sent once. Continuing in branch B costs
 *     what continuing in branch A would have cost; the alternative to forking
 *     is a fresh session that has to be told the first ten messages again, and
 *     that is the number the benchmark puts beside it
 *   - a branch cannot write to its parent, and a fork carries the memory as it
 *     was *at the fork* rather than as it is now. Two branches then hold
 *     contradictory facts at the same time and neither of them is wrong, which
 *     is a thing a key/value store can do and a summary cannot
 *
 * It never touches the DOM, never sends anything, and does not know what a fact
 * or a summary is: `memory` here is an opaque blob that belongs to whoever made
 * it — the compressed half of the conversation, whatever that currently means.
 * The one thing it insists on is that a fork's blob was rewound to the fork,
 * which is the caller's job and is stated at both call sites.
 *
 *   tree.commit(id, { messages, memory })  what this branch holds now
 *   tree.path(id)                          the resolved conversation
 *   tree.mark(index, label)                a checkpoint: a named place
 *   tree.fork({ at, name, memory })        a second continuation from one place
 *   tree.checkout(id)                      messages and memory for the switch
 *   tree.lineage(id) / tree.shape()        what the panel draws
 */

const BRANCH_NAME_LIMIT = 32;

function branchId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function cleanName(raw, fallback) {
  const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return (name || fallback).slice(0, BRANCH_NAME_LIMIT);
}

function cleanMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((message) => message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string')
    .map((message) => ({
      role: message.role,
      content: message.content,
      at: Number.isFinite(message.at) ? message.at : null,
    }));
}

// A fork lands between turns or it lands inside one. Splitting a user message
// from the answer it got leaves a branch that opens on a question nobody
// answered, so a fork point walks back to the last complete exchange — the same
// rule the compressor uses for the edge of its window, for the same reason.
function alignToTurn(messages, index) {
  let cut = Math.max(0, Math.min(index, messages.length));
  while (cut > 0 && messages[cut] && messages[cut].role !== 'user') cut -= 1;
  return cut;
}

class BranchError extends Error {
  constructor(message, { code = 'branch' } = {}) {
    super(message);
    this.name = 'BranchError';
    this.code = code;
  }
}

class BranchTree {
  constructor({ name = 'main' } = {}) {
    this._branches = new Map();
    this._checkpoints = [];
    this._head = null;
    this._seq = 0;
    this._root = this._add({ name, parent: null, forkIndex: 0 });
    this._head = this._root;
  }

  _add({ name, parent, forkIndex, id = null, memory = null, messages = [], created = null, note = '' }) {
    const record = {
      id: id || branchId(),
      name: cleanName(name, `branch ${this._branches.size + 1}`),
      parent,
      forkIndex: Math.max(0, Number(forkIndex) || 0),
      messages: cleanMessages(messages),
      memory: memory || null,
      created: Number(created) || Date.now(),
      note: String(note || ''),
    };
    this._branches.set(record.id, record);
    return record.id;
  }

  get head() {
    return this._head;
  }

  get root() {
    return this._root;
  }

  get size() {
    return this._branches.size;
  }

  has(id) {
    return this._branches.has(id);
  }

  _require(id) {
    const record = this._branches.get(id);
    if (!record) throw new BranchError(`No branch ${id}.`, { code: 'missing' });
    return record;
  }

  branch(id) {
    const record = this._require(id);
    return Object.freeze({
      id: record.id,
      name: record.name,
      parent: record.parent,
      forkIndex: record.forkIndex,
      created: record.created,
      note: record.note,
      own: record.messages.length,
      length: this.path(record.id).length,
    });
  }

  branches() {
    return [...this._branches.keys()].map((id) => this.branch(id));
  }

  /* The resolved conversation: the parent's path up to the fork, then this
   * branch's own messages. The prefix is read, never copied — which is what
   * makes a second branch cost the messages it adds rather than the
   * conversation it starts from. */
  path(id) {
    const record = this._require(id);
    const lineage = [];
    for (let node = record; node; node = node.parent ? this._branches.get(node.parent) : null) {
      lineage.unshift(node);
      if (!node.parent) break;
    }

    let messages = [];
    for (const node of lineage) {
      messages = node.parent ? messages.slice(0, node.forkIndex) : [];
      messages = messages.concat(node.messages);
    }
    return messages;
  }

  // Where a branch's own messages start in its resolved path. The panel draws
  // the line here, and the checkpoint list counts from it.
  base(id) {
    const record = this._require(id);
    return record.parent ? record.forkIndex : 0;
  }

  lineage(id) {
    const out = [];
    for (let node = this._require(id); node; node = node.parent ? this._branches.get(node.parent) : null) {
      out.unshift({ id: node.id, name: node.name, forkIndex: node.forkIndex });
      if (!node.parent) break;
    }
    return out;
  }

  children(id) {
    return [...this._branches.values()]
      .filter((record) => record.parent === id)
      .map((record) => record.id);
  }

  /* Everything the branch panel draws: the tree in depth-first order, each row
   * knowing how deep it is and where it left its parent. */
  shape() {
    const rows = [];
    const walk = (id, depth) => {
      const record = this._require(id);
      rows.push({
        ...this.branch(id),
        depth,
        head: id === this._head,
        children: this.children(id).length,
      });
      for (const child of this.children(id)) walk(child, depth + 1);
    };
    walk(this._root, 0);
    return rows;
  }

  /* What a branch holds right now.
   *
   * The caller hands over the whole resolved conversation and the tree keeps
   * only the part past the fork. Storing the prefix again would work and would
   * quietly make every branch a copy, at which point "a branch never mutates
   * its parent" would be true by accident rather than by construction.
   */
  commit(id, { messages = [], memory = undefined } = {}) {
    const record = this._require(id);
    const resolved = cleanMessages(messages);
    const base = this.base(id);

    if (record.parent) {
      const parentPath = this.path(record.parent);
      if (resolved.length < base) {
        throw new BranchError(
          'That conversation is shorter than the point this branch forked at.',
          { code: 'short' }
        );
      }
      // The prefix is the parent's and is not this branch's to rewrite. It is
      // checked rather than trusted, because silently accepting an edited
      // prefix is how a branch starts mutating the branch it came from.
      for (let i = 0; i < base; i += 1) {
        if (!parentPath[i] || parentPath[i].content !== resolved[i].content) {
          throw new BranchError(
            'That conversation does not start with what this branch forked from.',
            { code: 'diverged' }
          );
        }
      }
    }

    record.messages = record.parent ? resolved.slice(base) : resolved;
    if (memory !== undefined) record.memory = memory;
    return this.branch(id);
  }

  memoryFor(id) {
    return this._require(id).memory;
  }

  /* A checkpoint is a named index on a branch. It exists so that "two branches
   * from one place" is one place with two children rather than two forks that
   * happen to have been made at the same number. */
  mark(index, { label = '', on = null } = {}) {
    const id = on || this._head;
    const record = this._require(id);
    const at = alignToTurn(this.path(id), index);
    const existing = this._checkpoints.find((point) => point.branch === id && point.at === at);
    if (existing) {
      if (label) existing.label = cleanName(label, existing.label);
      return { ...existing };
    }
    this._seq += 1;
    const point = {
      id: `c${this._seq}`,
      branch: id,
      at,
      label: cleanName(label, `checkpoint ${this._seq}`),
      created: Date.now(),
    };
    this._checkpoints.push(point);
    return { ...point };
  }

  checkpoints({ on = null } = {}) {
    return this._checkpoints
      .filter((point) => !on || point.branch === on)
      .map((point) => ({
        ...point,
        forks: [...this._branches.values()]
          .filter((record) => record.parent === point.branch && record.forkIndex === point.at)
          .map((record) => record.id),
      }));
  }

  /* A second continuation from one place.
   *
   * `memory` is whatever the caller decided the compressed half said at that
   * index, and the caller is expected to have rewound it rather than handed
   * over the current one. The tree cannot check that — it does not know what a
   * fact is — so it is written down here instead: a fork carrying present-day
   * facts is the leak this whole file exists to make visible.
   */
  fork({ from = null, at = null, name = '', memory = null, note = '' } = {}) {
    const parent = from || this._head;
    const record = this._require(parent);
    const parentPath = this.path(parent);
    const index = alignToTurn(parentPath, at == null ? parentPath.length : at);

    if (index < this.base(parent)) {
      // Forking before the parent's own first message would produce a branch
      // whose prefix belongs to the grandparent. That is a fork of the
      // grandparent, and saying so beats silently making one.
      throw new BranchError(
        `That point belongs to ${this.branch(record.parent).name}, not to ${record.name}.`,
        { code: 'above' }
      );
    }

    const id = this._add({
      name: cleanName(name, `${record.name} +${this.children(parent).length + 1}`),
      parent,
      forkIndex: index,
      memory,
      note,
    });
    return this.branch(id);
  }

  rename(id, name) {
    const record = this._require(id);
    record.name = cleanName(name, record.name);
    return this.branch(id);
  }

  /* Switching. Returns what the conversation should become, and nothing else:
   * the tree does not know who is holding the agent and has no business
   * reaching for it. */
  checkout(id) {
    this._require(id);
    this._head = id;
    return {
      id,
      messages: this.path(id),
      memory: this.memoryFor(id),
      base: this.base(id),
    };
  }

  remove(id) {
    const record = this._require(id);
    if (!record.parent) throw new BranchError('The root branch is the conversation.', { code: 'root' });
    if (this.children(id).length) {
      throw new BranchError('That branch has branches of its own.', { code: 'children' });
    }
    this._branches.delete(id);
    this._checkpoints = this._checkpoints.filter((point) => point.branch !== id);
    if (this._head === id) this._head = record.parent;
    return this._head;
  }

  snapshot() {
    return {
      head: this._head,
      root: this._root,
      seq: this._seq,
      branches: [...this._branches.values()].map((record) => ({
        ...record,
        messages: record.messages.map((message) => ({ ...message })),
      })),
      checkpoints: this._checkpoints.map((point) => ({ ...point })),
    };
  }

  /* Restoring is where a tree can be made impossible, so it is rebuilt rather
   * than assigned: parents before children, a missing parent demotes a branch
   * to a child of the root instead of leaving it pointing at nothing, and a
   * head that is not in the tree falls back to the root. A conversation that
   * comes back with one branch missing is a bad day; one that comes back with a
   * cycle in it is an infinite loop in `path()`. */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const incoming = Array.isArray(snapshot.branches) ? snapshot.branches : [];
    if (!incoming.length) return false;

    const roots = incoming.filter((record) => record && !record.parent);
    if (!roots.length) return false;

    this._branches = new Map();
    this._checkpoints = [];
    this._seq = Number(snapshot.seq) || 0;

    const root = roots[0];
    this._root = this._add({ ...root, id: root.id, parent: null, forkIndex: 0 });
    this._head = this._root;

    const pending = incoming.filter((record) => record && record.parent && record.id);
    let placed = true;
    while (pending.length && placed) {
      placed = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const record = pending[i];
        if (!this._branches.has(record.parent)) continue;
        if (this._branches.has(record.id)) { pending.splice(i, 1); continue; }
        this._add({ ...record });
        pending.splice(i, 1);
        placed = true;
      }
    }
    // Whatever is left points at a parent that never arrived — orphans of a
    // half-written record. They keep their messages and lose their prefix,
    // which is a loss worth admitting rather than a crash worth having.
    for (const record of pending) {
      if (this._branches.has(record.id)) continue;
      this._add({ ...record, parent: this._root, forkIndex: 0, note: 'reattached — its parent was missing' });
    }

    for (const point of Array.isArray(snapshot.checkpoints) ? snapshot.checkpoints : []) {
      if (!point || !this._branches.has(point.branch)) continue;
      this._seq += 1;
      this._checkpoints.push({
        id: point.id || `c${this._seq}`,
        branch: point.branch,
        at: Math.max(0, Number(point.at) || 0),
        label: cleanName(point.label, `checkpoint ${this._seq}`),
        created: Number(point.created) || Date.now(),
      });
    }

    this._head = this._branches.has(snapshot.head) ? snapshot.head : this._root;
    return true;
  }
}
