/* The three layers.
 *
 * Task 10 had five context policies and one lifetime. The window, the summary
 * and the facts all lived inside a single session record and died with it,
 * which made all five of them answers to the same question: how much of this
 * conversation goes up the wire?
 *
 * This file asks the other question. Not *how much of the conversation* but
 * *which of the things the agent knows are about this conversation at all* —
 * and the answer to that is not a policy, it is three stores that are told
 * apart by how long they live and what they are about:
 *
 *   short-term   this dialogue   dies with the session
 *   working      this task       dies when the task is closed
 *   long-term    this user       dies when someone retracts it
 *
 * They share one interface so that `agent.js` can assemble a prompt without
 * knowing which of them it is reading from:
 *
 *   layer.put(item)          write, with provenance
 *   layer.all()              what is current, in eviction order
 *   layer.block(budget)      the payload block, under its ceiling
 *   layer.stats()            counts and tokens, for the panel
 *   layer.snapshot() / .restore(state) / .clear()
 *
 * They do not share a policy, and that is the point. A uniform interface over
 * three identical stores would be one store with a label column, which is what
 * this task exists not to build.
 *
 * Nothing here touches the DOM, sends anything, or knows what a transport is.
 * Nothing here decides which layer an item belongs to either — that is
 * router.js, and the separation is deliberate: a store that could choose its
 * own contents would make the routing rules unfalsifiable.
 */

const LAYER_DEFAULTS = {
  keepTurns: 6,          // short-term: message pairs kept verbatim
  workingBudget: 224,    // tokens the working block may occupy in a request
  longBudget: 160,       // tokens the long-term block may occupy
  maxWorking: 24,        // items held before the working layer evicts
  maxLongTerm: 48,       // items per long-term compartment
  maxValue: 140,         // characters: a value the length of a paragraph is prose
  staleDays: 60,         // after this, a long-term item is flagged, never deleted
};

/* Token estimate.
 *
 * Deliberately crude — this is a budget, not a bill, and there is no ledger in
 * this task to reconcile it against. The one thing it does take seriously is
 * script: a tokeniser trained mostly on English spends roughly twice as many
 * tokens per character on Cyrillic, and a budget that ignored that would give
 * a Russian conversation half the memory it gives an English one without ever
 * saying so.
 */
function estimate(text) {
  const source = String(text || '');
  if (!source) return 0;
  let latin = 0;
  let other = 0;
  for (const char of source) {
    if (/[Ѐ-ӿԀ-ԯ一-鿿぀-ヿ]/.test(char)) other += 1;
    else latin += 1;
  }
  return Math.ceil(latin / 3.8 + other / 2);
}

function now() {
  return Date.now();
}

/* Every working layer has an id, including the unfiled one.
 *
 * It would be tidier to leave the id null until a task is named, and it would
 * also mean the first few minutes of every session have a layer with nowhere
 * to be written — so the id comes first and the goal arrives later. */
function taskId() {
  return `t${Math.random().toString(36).slice(2, 9)}`;
}

function trim(raw, ceiling) {
  const value = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (value.length <= ceiling) return value;
  return value.slice(0, ceiling - 1).trimEnd() + '…';
}

/* A key names what a value is about. "deadline", "database", "staging_box" —
 * never "it", "that", "the one". A pronoun key is not a weak key, it is a key
 * that will collide with the next pronoun and overwrite a fact with an
 * unrelated one, which is worse than not storing either. */
const PRONOUN_KEYS = new Set([
  'it', 'that', 'this', 'one', 'thing', 'them', 'they', 'some', 'any',
  'то', 'это', 'оно', 'тот', 'такое',
]);

function normaliseKey(raw) {
  const key = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!key || PRONOUN_KEYS.has(key)) return '';
  return key;
}

/* ------------------------------------------------------------------ short */

/* Short-term memory holds messages, not items.
 *
 * There is no extraction here, no keys, no ranking and no ceiling beyond a
 * count of turns. That is not an omission. The moment short-term memory starts
 * deciding what is worth keeping it stops being the dialogue and becomes a
 * fourth store with a confusing name; its entire job is to be the last few
 * things that were actually said, in the order they were said, unedited.
 *
 * It never writes to storage on its own. It is saved inside the dialogue
 * record and dies with it, which is exactly the lifetime the layer claims.
 */
class ShortTerm {
  constructor(config = {}) {
    this._config = { ...LAYER_DEFAULTS, ...config };
    this._messages = [];
  }

  get id() { return 'short'; }
  get label() { return 'short-term'; }
  get scope() { return 'this dialogue'; }
  get lifetime() { return 'until the conversation is reset'; }

  configure(patch = {}) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in this._config && Number.isFinite(Number(value))) {
        this._config[key] = Math.max(1, Math.round(Number(value)));
      }
    }
  }

  put(message) {
    if (!message || !message.content) return null;
    const entry = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content),
      at: message.at || now(),
    };
    this._messages.push(entry);
    return entry;
  }

  // Everything the dialogue has said. The window is a view of this, not a
  // replacement for it: a message that falls out of the window is still in the
  // transcript on screen, and still the thing a stored fact was quoted from.
  all() {
    return this._messages.slice();
  }

  get length() {
    return this._messages.length;
  }

  at(index) {
    return this._messages[index] || null;
  }

  /* What actually goes up the wire.
   *
   * The cut is aligned to a user message. Messages alternate, so a cut that
   * lands on an assistant message would send a reply with nothing in front of
   * it to answer — the model then has to guess what the question was, and it
   * guesses from the facts blocks, which is precisely the confusion this task
   * is trying to keep out of the prompt. Keeping one extra message is always
   * the safe direction. */
  window() {
    const keep = this._config.keepTurns * 2;
    let from = Math.max(0, this._messages.length - keep);
    while (from > 0 && this._messages[from] && this._messages[from].role !== 'user') from -= 1;
    return this._messages.slice(from).map((m) => ({ role: m.role, content: m.content }));
  }

  // The index the window starts at, so the panel can mark which messages are
  // still being sent and which are only on screen.
  windowFrom() {
    return this._messages.length - this.window().length;
  }

  // Short-term memory is not a block. It goes up as messages, with speakers,
  // because those are things people actually said. Returning null here is the
  // honest answer and the assembler treats it as one.
  block() {
    return null;
  }

  stats() {
    const window = this.window();
    const tokens = window.reduce((sum, m) => sum + estimate(m.content), 0);
    return {
      layer: 'short',
      items: this._messages.length,
      sent: window.length,
      dropped: this._messages.length - window.length,
      tokens,
    };
  }

  snapshot() {
    return { messages: this._messages.slice() };
  }

  restore(state = {}) {
    this._messages = Array.isArray(state.messages)
      ? state.messages.filter((m) => m && m.content).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content),
        at: Number(m.at) || now(),
      }))
      : [];
  }

  clear() {
    this._messages = [];
  }
}

/* ---------------------------------------------------------------- working */

/* The kinds a working item can be, in eviction order — highest survives
 * longest.
 *
 * The order is an argument. A working layer that evicted the goal to keep an
 * artifact would have kept the wrong half: the goal is stated once, at the
 * start, and never repeated, which makes it simultaneously the oldest item and
 * the one the answer is least usable without. Recency ranking gets exactly
 * this case wrong, so recency is the tiebreak and never the rule.
 */
const WORKING_KINDS = {
  goal: 6,
  constraint: 5,
  open_question: 4,
  decision: 3,
  artifact: 1,
};

const WORKING_LABELS = {
  goal: 'goal',
  constraint: 'constraint',
  open_question: 'open',
  decision: 'decided',
  artifact: 'artifact',
};

/* Working memory is bound to a task.
 *
 * There is always one. Before anything is opened its goal is null and the
 * panel calls it *unfiled* — the alternative, holding candidates in a tray
 * until a task exists, is tidier on a diagram and means the agent silently
 * forgets everything said in the first minute of every session.
 *
 * Closing a task does two things that are easy to conflate and must not be:
 * it archives the record, and it offers the decisions inside it for promotion
 * to long-term. The first is bookkeeping. The second is the only moment in the
 * app where the boundary between two layers is a decision somebody makes
 * rather than a rule that already fired.
 */
class Working {
  constructor(config = {}) {
    this._config = { ...LAYER_DEFAULTS, ...config };
    this._task = { id: taskId(), goal: null, opened: now(), closed: null };
    this._items = new Map();
  }

  get id() { return 'working'; }
  get label() { return 'working'; }
  get scope() { return 'this task'; }
  get lifetime() { return 'until the task is closed'; }
  static get kinds() { return Object.keys(WORKING_KINDS); }

  get task() {
    return Object.freeze({ ...this._task, unfiled: !this._task.goal });
  }

  configure(patch = {}) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in this._config && Number.isFinite(Number(value))) {
        this._config[key] = Math.max(0, Math.round(Number(value)));
      }
    }
  }

  /* Open a task.
   *
   * Whatever is already in the unfiled layer comes with it. Somebody who
   * states a deadline and then says "right, let's call this the migration" has
   * not changed their mind about the deadline, and making them repeat it would
   * be the app punishing them for naming the task second. */
  open(goal, { id = null } = {}) {
    this._task = {
      id: id || this._task.id || taskId(),
      goal: trim(goal, 160) || null,
      opened: now(),
      closed: null,
    };
    if (this._task.goal) {
      this.put({
        key: 'task_goal',
        value: this._task.goal,
        kind: 'goal',
        from: 'user',
        rule: 'opened',
      });
    }
    return this.task;
  }

  /* Close it, and say what might outlive it.
   *
   * Promotable items are the decisions and the agreements — rule 6's output.
   * They are *offered*, not moved: an agent that promoted its own decisions
   * would build a permanent record of every provisional thing said during an
   * afternoon, which is how a long-term store becomes a place nobody trusts. */
  close() {
    const record = {
      ...this._task,
      closed: now(),
      items: this.all(),
    };
    const promotable = record.items.filter((item) => item.promotable);
    this._task = { id: taskId(), goal: null, opened: now(), closed: null };
    this._items = new Map();
    return { record, promotable };
  }

  put(item = {}) {
    const key = normaliseKey(item.key);
    if (!key) return { written: false, reason: 'key names nothing' };
    const value = trim(item.value, this._config.maxValue);
    if (!value) return { written: false, reason: 'empty value' };
    const kind = WORKING_KINDS[item.kind] ? item.kind : 'artifact';

    const previous = this._items.get(key) || null;
    const entry = {
      key,
      value,
      kind,
      from: item.from === 'assistant' ? 'assistant' : 'user',
      source: item.source || null,
      rule: item.rule == null ? null : item.rule,
      proposed: item.proposed || null,
      promotable: Boolean(item.promotable),
      /* Typed, not quoted. The verbatim rule has nothing to check a
       * hand-written item against, and rather than pretend it passed, the item
       * carries the fact that nobody said it. A provenance column that cannot
       * tell the two apart is worse than none. */
      typed: Boolean(item.typed),
      at: now(),
      // Revisions are kept for the panel and never sent. Sending both the old
      // value and the new one is how `full` context ends up unable to say when
      // the demo is, after the demo has moved.
      history: previous ? [...previous.history, { value: previous.value, at: previous.at }] : [],
    };
    this._items.set(key, entry);
    this._evict();
    return { written: true, entry, revised: Boolean(previous), previous };
  }

  remove(key) {
    return this._items.delete(normaliseKey(key));
  }

  get(key) {
    return this._items.get(normaliseKey(key)) || null;
  }

  all() {
    return [...this._items.values()].sort((a, b) => {
      const rank = WORKING_KINDS[b.kind] - WORKING_KINDS[a.kind];
      return rank !== 0 ? rank : b.at - a.at;
    });
  }

  _evict() {
    const max = this._config.maxWorking;
    if (this._items.size <= max) return;
    const order = this.all();
    for (const item of order.slice(max)) this._items.delete(item.key);
  }

  /* The block.
   *
   * It names the task in its first line because a list of constraints with no
   * statement of what they constrain reads, to a model, like a list of
   * arbitrary prohibitions — and a model that cannot see why a rule exists is
   * a model that will find a clever way around it. */
  block(budget = this._config.workingBudget) {
    const items = this.all();
    if (!items.length) return null;

    const head = this._task.goal
      ? `The task at hand — "${this._task.goal}":`
      : 'The task at hand (not yet named):';
    const lines = [head];
    let tokens = estimate(head);
    let shown = 0;

    for (const item of items) {
      const line = `- ${WORKING_LABELS[item.kind]}: ${item.value}`;
      const cost = estimate(line);
      if (tokens + cost > budget) break;
      lines.push(line);
      tokens += cost;
      shown += 1;
    }

    // A block that truncates says so inside itself. The alternative is a model
    // that believes it has been given everything and answers with confidence
    // about the part it was not given.
    if (shown < items.length) {
      const note = `(${items.length - shown} more not shown — working memory is at its ceiling)`;
      lines.push(note);
      tokens += estimate(note);
    }

    return { text: lines.join('\n'), tokens, shown, held: items.length };
  }

  stats() {
    const block = this.block();
    return {
      layer: 'working',
      items: this._items.size,
      sent: block ? block.shown : 0,
      dropped: block ? block.held - block.shown : 0,
      tokens: block ? block.tokens : 0,
    };
  }

  snapshot() {
    return { task: { ...this._task }, items: this.all() };
  }

  restore(state = {}) {
    const task = state.task || {};
    this._task = {
      id: task.id || taskId(),
      goal: task.goal || null,
      opened: Number(task.opened) || now(),
      closed: task.closed || null,
    };
    this._items = new Map();
    for (const item of Array.isArray(state.items) ? state.items : []) {
      const key = normaliseKey(item && item.key);
      if (!key) continue;
      this._items.set(key, {
        key,
        value: trim(item.value, this._config.maxValue),
        kind: WORKING_KINDS[item.kind] ? item.kind : 'artifact',
        from: item.from === 'assistant' ? 'assistant' : 'user',
        source: item.source || null,
        rule: item.rule == null ? null : item.rule,
        proposed: item.proposed || null,
        promotable: Boolean(item.promotable),
        typed: Boolean(item.typed),
        at: Number(item.at) || now(),
        history: Array.isArray(item.history) ? item.history : [],
      });
    }
  }

  clear() {
    this._task = { id: taskId(), goal: null, opened: now(), closed: null };
    this._items = new Map();
  }
}

/* -------------------------------------------------------------- long-term */

/* The profile is typed and the other two compartments are not.
 *
 * Free keys in a profile turn it into a second knowledge store within a week —
 * `name`, then `user_name`, then `what_to_call_them`, each holding a slightly
 * different string and none of them wrong enough to delete. Five fields, fixed,
 * is a smaller promise that can actually be kept.
 *
 * They are also the five things whose *shape* the block wants to know, because
 * the block renders them as sentences. "The user's name is Atabek" is a
 * sentence a model will use; "name=Atabek" is a row in a table it may or may
 * not decide is about the person it is talking to.
 */
const PROFILE_FIELDS = {
  name: (v) => `they are called ${v}`,
  language: (v) => `they want answers in ${v}`,
  tone: (v) => `they prefer answers that are ${v}`,
  timezone: (v) => `they are in ${v}`,
  role: (v) => `they work as ${v}`,
};

const COMPARTMENTS = ['profile', 'decisions', 'knowledge'];

const COMPARTMENT_HEADS = {
  profile: 'About the person you are talking to',
  decisions: 'Standing decisions, from earlier conversations',
  knowledge: 'Things established earlier and still true',
};

/* Long-term memory is one record, shared by every session.
 *
 * Nothing in it is evicted by age. `last_confirmed` is kept and shown, and an
 * item nobody has mentioned in two months is flagged stale rather than
 * deleted — an agent that quietly forgets is worse than one that is visibly
 * out of date, because the second can be corrected and the first cannot even
 * be noticed.
 *
 * A retraction is a write. The key is tombstoned, not deleted, so the panel
 * can show that something was dropped on purpose rather than lost, and so that
 * the same fact arriving again can be told apart from a fact that was never
 * seen.
 */
class LongTerm {
  constructor(config = {}) {
    this._config = { ...LAYER_DEFAULTS, ...config };
    this._items = { profile: new Map(), decisions: new Map(), knowledge: new Map() };
    this._retracted = [];
  }

  get id() { return 'long'; }
  get label() { return 'long-term'; }
  get scope() { return 'this user, every conversation'; }
  get lifetime() { return 'until retracted'; }
  static get compartments() { return COMPARTMENTS.slice(); }
  static get profileFields() { return Object.keys(PROFILE_FIELDS); }

  configure(patch = {}) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in this._config && Number.isFinite(Number(value))) {
        this._config[key] = Math.max(0, Math.round(Number(value)));
      }
    }
  }

  put(item = {}) {
    const compartment = COMPARTMENTS.includes(item.compartment) ? item.compartment : 'knowledge';
    const key = compartment === 'profile'
      ? (PROFILE_FIELDS[item.key] ? item.key : '')
      : normaliseKey(item.key);
    if (!key) {
      return {
        written: false,
        reason: compartment === 'profile'
          ? `the profile has no field called "${item.key}"`
          : 'key names nothing',
      };
    }
    const value = trim(item.value, this._config.maxValue);
    if (!value) return { written: false, reason: 'empty value' };

    const bucket = this._items[compartment];
    const previous = bucket.get(key) || null;

    /* The same value arriving again is a confirmation, not a revision. It
     * updates the clock and the counter and leaves the provenance pointing at
     * the first time it was said — which is the citation a person actually
     * wants when they ask where a fact came from. */
    if (previous && previous.value === value) {
      previous.lastConfirmed = now();
      previous.confirmations += 1;
      return { written: true, entry: previous, confirmed: true };
    }

    const entry = {
      compartment,
      key,
      value,
      from: item.from === 'assistant' ? 'assistant' : 'user',
      source: item.source || null,
      rule: item.rule == null ? null : item.rule,
      proposed: item.proposed || null,
      promotedFrom: item.promotedFrom || null,
      typed: Boolean(item.typed),
      firstSeen: previous ? previous.firstSeen : now(),
      lastConfirmed: now(),
      confirmations: previous ? previous.confirmations : 0,
      history: previous ? [...previous.history, { value: previous.value, at: previous.lastConfirmed }] : [],
    };
    bucket.set(key, entry);
    this._evict(compartment);
    return { written: true, entry, revised: Boolean(previous), previous };
  }

  retract(compartment, key, { reason = 'retracted' } = {}) {
    const bucket = this._items[compartment];
    if (!bucket) return false;
    const entry = bucket.get(key);
    if (!entry) return false;
    bucket.delete(key);
    this._retracted.unshift({ ...entry, retractedAt: now(), reason });
    this._retracted = this._retracted.slice(0, 40);
    return true;
  }

  get(compartment, key) {
    const bucket = this._items[compartment];
    return bucket ? bucket.get(key) || null : null;
  }

  // Stale is a fact about the item, computed rather than stored, so that
  // changing the threshold does not require rewriting every record.
  stale(entry) {
    const days = (now() - entry.lastConfirmed) / 86400000;
    return days > this._config.staleDays;
  }

  all(compartment = null) {
    const take = (name) => [...this._items[name].values()]
      .sort((a, b) => b.lastConfirmed - a.lastConfirmed)
      .map((entry) => ({ ...entry, stale: this.stale(entry) }));
    if (compartment) return take(compartment);
    return COMPARTMENTS.flatMap(take);
  }

  get retracted() {
    return this._retracted.slice();
  }

  _evict(compartment) {
    const bucket = this._items[compartment];
    const max = compartment === 'profile' ? Object.keys(PROFILE_FIELDS).length : this._config.maxLongTerm;
    if (bucket.size <= max) return;
    /* Eviction from long-term memory is the one place this file is uneasy.
     * There is no good rule — everything here was, by construction, judged
     * worth keeping forever. Oldest-confirmed-first is the least bad: it drops
     * the thing nobody has mentioned in longest, and it drops it loudly into
     * the retracted list rather than into nothing. */
    const order = [...bucket.values()].sort((a, b) => a.lastConfirmed - b.lastConfirmed);
    for (const entry of order.slice(0, bucket.size - max)) {
      this.retract(compartment, entry.key, { reason: 'evicted — long-term store at its ceiling' });
    }
  }

  block(budget = this._config.longBudget) {
    const groups = COMPARTMENTS
      .map((name) => ({ name, items: this.all(name) }))
      .filter((group) => group.items.length);
    if (!groups.length) return null;

    const lines = [];
    let tokens = 0;
    let shown = 0;
    let held = 0;
    let truncated = false;

    for (const group of groups) {
      held += group.items.length;
      if (truncated) continue;
      const head = `${COMPARTMENT_HEADS[group.name]}:`;
      const pending = [head];
      let cost = estimate(head);
      for (const item of group.items) {
        const line = group.name === 'profile'
          ? `- ${PROFILE_FIELDS[item.key](item.value)}`
          : `- ${item.key}: ${item.value}`;
        const lineCost = estimate(line);
        if (tokens + cost + lineCost > budget) { truncated = true; break; }
        pending.push(line);
        cost += lineCost;
        shown += 1;
      }
      if (pending.length > 1) {
        lines.push(...pending);
        tokens += cost;
      }
    }

    if (!lines.length) return null;
    if (shown < held) {
      const note = `(${held - shown} more not shown — long-term block is at its ceiling)`;
      lines.push(note);
      tokens += estimate(note);
    }

    return { text: lines.join('\n'), tokens, shown, held };
  }

  stats() {
    const block = this.block();
    return {
      layer: 'long',
      items: COMPARTMENTS.reduce((sum, name) => sum + this._items[name].size, 0),
      sent: block ? block.shown : 0,
      dropped: block ? block.held - block.shown : 0,
      tokens: block ? block.tokens : 0,
      retracted: this._retracted.length,
    };
  }

  snapshot() {
    return {
      profile: this.all('profile'),
      decisions: this.all('decisions'),
      knowledge: this.all('knowledge'),
      retracted: this._retracted.slice(),
    };
  }

  restore(state = {}) {
    this._items = { profile: new Map(), decisions: new Map(), knowledge: new Map() };
    for (const compartment of COMPARTMENTS) {
      for (const item of Array.isArray(state[compartment]) ? state[compartment] : []) {
        if (!item || !item.key) continue;
        const key = compartment === 'profile'
          ? (PROFILE_FIELDS[item.key] ? item.key : '')
          : normaliseKey(item.key);
        if (!key) continue;
        this._items[compartment].set(key, {
          compartment,
          key,
          value: trim(item.value, this._config.maxValue),
          from: item.from === 'assistant' ? 'assistant' : 'user',
          source: item.source || null,
          rule: item.rule == null ? null : item.rule,
          proposed: item.proposed || null,
          promotedFrom: item.promotedFrom || null,
          typed: Boolean(item.typed),
          firstSeen: Number(item.firstSeen) || now(),
          lastConfirmed: Number(item.lastConfirmed) || now(),
          confirmations: Number(item.confirmations) || 0,
          history: Array.isArray(item.history) ? item.history : [],
        });
      }
    }
    this._retracted = Array.isArray(state.retracted) ? state.retracted.slice(0, 40) : [];
  }

  clear() {
    this._items = { profile: new Map(), decisions: new Map(), knowledge: new Map() };
    this._retracted = [];
  }
}

/* ------------------------------------------------------------------ facade */

/* One object that owns the three, so that everything downstream can be handed
 * `memory` and still not be able to conflate the layers — `memory.short`,
 * `memory.working`, `memory.long` are separate objects with separate
 * lifetimes, and there is deliberately no `memory.put()` that would let a
 * caller write without saying where. */
class Memory {
  constructor(config = {}) {
    this._config = { ...LAYER_DEFAULTS, ...config };
    this.short = new ShortTerm(this._config);
    this.working = new Working(this._config);
    this.long = new LongTerm(this._config);
  }

  static get defaults() { return { ...LAYER_DEFAULTS }; }
  static estimate(text) { return estimate(text); }
  // The key rule, exposed so router.js can ask whether a candidate names
  // anything before it decides where to put it. One implementation, because
  // two would eventually disagree about what a pronoun is.
  static key(raw) { return normaliseKey(raw); }

  get config() { return Object.freeze({ ...this._config }); }

  get layers() { return [this.short, this.working, this.long]; }

  configure(patch = {}) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in this._config)) continue;
      const number = Math.round(Number(value));
      if (Number.isFinite(number) && number >= 0) this._config[key] = number;
    }
    if (this._config.keepTurns < 1) this._config.keepTurns = 1;
    for (const layer of this.layers) layer.configure(this._config);
    return this.config;
  }

  stats() {
    return {
      short: this.short.stats(),
      working: this.working.stats(),
      long: this.long.stats(),
    };
  }

  /* Deliberately three snapshots rather than one.
   *
   * `store.js` writes each of them to a different key with a different
   * lifetime, and a single combined snapshot would make that impossible
   * without taking it apart again — which is the seam this whole task is
   * about, so it is not going to be sealed here for tidiness. */
  snapshot() {
    return {
      short: this.short.snapshot(),
      working: this.working.snapshot(),
      long: this.long.snapshot(),
    };
  }

  restore(state = {}) {
    if (state.short) this.short.restore(state.short);
    if (state.working) this.working.restore(state.working);
    if (state.long) this.long.restore(state.long);
  }

  // Resetting the conversation does not reset the user. This method is the
  // one-line statement of what the three layers are for, and the fact that it
  // only touches two of them is the entire design.
  resetDialogue() {
    this.short.clear();
  }
}
