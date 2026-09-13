/* The fact store.
 *
 * Task 9 kept the past by paying a model to write prose about it. Prose has one
 * property that cannot be fixed by asking nicely: a summariser can write a
 * sentence nobody said, and that sentence then sits in the system slot of every
 * future request, where it is indistinguishable from something that happened.
 *
 * This file is the other way of keeping the past. It holds key/value pairs, and
 * one rule makes it different in kind from a summary rather than in degree:
 *
 *     a value that is not a verbatim span of a cited message is not a fact
 *
 * That is checked on write, here, by string containment — not requested in a
 * prompt, not graded afterwards. Whatever writes to this store, a real model or
 * the stub or a test, cannot put text in it that nobody said. The confabulation
 * column in the benchmark is a consequence of this function rather than of an
 * instruction, which is the entire argument for structure over prose.
 *
 * Five rules stand behind it:
 *
 *   2. keys are canonical and the last write wins. Only the current value ever
 *      goes up the wire; superseded values are kept for the panel and are not
 *      sent, because sending both is what makes `full` unable to answer "when
 *      is the demo?" after the demo has moved.
 *   3. a revision is checked exactly like an original. No shortcut for updates.
 *   4. a retraction is a write. "Forget the budget" clears the key if the
 *      sentence that retracts it is cited and verbatim, and the key is
 *      tombstoned rather than deleted, so the panel can show it was dropped on
 *      purpose rather than lost.
 *   5. the block is bounded, and says so inside itself when it truncates. A
 *      fact store with no ceiling grows into the history it replaced, which was
 *      task 9's finding about summaries and is not a summary-specific fact.
 *   6. nothing here can cost a message. Facts are additive to the window; a
 *      failed extraction leaves the previous block standing and is logged.
 *
 * It never touches the DOM and never sends anything. It does not know what a
 * transport is, and it does not know how a fact was found — only whether the
 * message it was found in actually contains it, and which of the two speakers
 * that message belonged to.
 *
 *   store.apply(list, { sources })  one extraction's worth: written and rejected
 *   store.block(model)              the payload block, under its ceiling
 *   store.menu()                    the key list the extractor chooses from
 *   store.all() / store.cleared()   what is current, what was retracted
 *   store.fork()                    a copy that cannot write back (branching)
 *   store.snapshot() / .restore()
 */

/* The brief's own list of what belongs in a facts block — goal, constraints,
 * preferences, decisions, agreements — with two additions that earn their place
 * in a requirements conversation: an identifier is a fact whose exact
 * characters matter more than any other kind, and `other` exists so an
 * extractor is never forced to mislabel one to get it stored.
 *
 * The order is the eviction order. When the ceiling bites, a preference is
 * dropped before a constraint and a constraint before the goal, because a goal
 * stated once at the start and never repeated is the fact most likely to be
 * both the oldest and the most important — which is exactly the case a
 * recency-ranked store gets wrong.
 */
const FACT_KINDS = {
  goal: 6,
  constraint: 5,
  agreement: 4,
  decision: 4,
  identifier: 3,
  preference: 3,
  other: 1,
};

const FACT_DEFAULTS = {
  factsBudget: 192,   // tokens the block may occupy in every request
  maxFacts: 40,       // keys the store will hold before it evicts by rank
  maxValue: 120,      // characters: a value the length of a paragraph is prose
};

const BLOCK_HEADER = 'Facts established in this conversation (verbatim, from what was said):';
// Added to the header only when a marked line is actually in the block, so a
// conversation where the agent settled nothing does not pay for the sentence.
const BLOCK_MARK = '*';
const BLOCK_MARK_NOTE = ' — lines marked * are ones you settled yourself, the rest are the user\'s';

/* The instruction that produces a write.
 *
 * It lives here, beside the rule it has to satisfy, for the reason task 9's
 * summary prompt lived beside the compressor: it is not a persona, it is a
 * specification of what a fact is, and that is this file's business.
 *
 * Every clause is load-bearing, and the first one is the only one that is not
 * enforceable from here — which is why it is also enforced in `write()`. An
 * extractor that ignores it does not corrupt the store; it just produces
 * nothing, loudly, in the rejected column.
 */
const EXTRACT_SYSTEM = [
  'You maintain a key/value store of facts for another assistant, which will',
  'read your store instead of the messages it was built from.',
  '',
  'You are given one turn of a conversation — what the user said and what the',
  'assistant replied — and the facts already known. Reply with JSON and nothing',
  'else:',
  '',
  '{"facts":[{"key":"deadline","value":"11 March","kind":"decision","op":"set",'
    + '"from":"user"}]}',
  '',
  'Rules:',
  '1. Every value must be copied WORD FOR WORD from the message named in',
  '   "from" — "user" or "assistant". Do not rephrase, reformat a date, round a',
  '   number or expand an abbreviation, and do not quote one message while',
  '   naming the other. A value that is not in the message you named is',
  '   discarded before it reaches the store, so writing one loses the fact',
  '   entirely.',
  '2. Reuse a key from the known list whenever the message is about the same',
  '   thing. Invent a key only when nothing in the list fits.',
  '3. When the message changes something already known, write that same key',
  '   with the new value. That is how a decision is revised, and it is the',
  '   only way the store can stop believing the old one.',
  '4. Use op "clear", with no value, only when the message explicitly',
  '   withdraws a known fact.',
  '5. kind is one of: goal, constraint, decision, agreement, preference,',
  '   identifier, other.',
  '6. Keep values short — a few words. A value the length of a sentence is',
  '   prose, and prose is what this store exists to avoid.',
  '7. Small talk carries no facts. Reply {"facts":[]} rather than reaching.',
  '8. A question is a request, not a statement. Take nothing from one — the',
  '   words in "which database are we using?" are the user asking what you',
  '   already store, and writing them back would overwrite the answer with the',
  '   question.',
  '9. A key must name what the value is about — "deadline", "database",',
  '   "staging_box". Never a pronoun or a filler word: "that", "it", "this",',
  '   "one". If a sentence does not say what it is about, the fact is not in',
  '   that sentence and there is nothing to take from it.',
  '10. From the reply, take only what was settled or produced there: a',
  '   commitment the assistant made, a value it worked out, the wording of an',
  '   agreement that the user then accepted. Never an option it was offering,',
  '   a guess, a suggestion, or anything it was only asking about.',
  '11. When both halves of the turn carry the same fact, name "user". The',
  '    user states the thing and the assistant acknowledges it; the statement',
  '    is the commitment and the acknowledgement is not. A reply that quotes,',
  '    repeats or paraphrases the user has said nothing of its own, and a value',
  '    taken from it would be the user\'s words filed under the assistant\'s',
  '    name.',
].join('\n');

/* Comparison for the verbatim rule.
 *
 * Case and whitespace are allowed to differ because they carry no information
 * that a fact depends on, and curly quotes are folded because a model that
 * retypes a value will normalise them and it would be absurd to reject a fact
 * over an apostrophe. Nothing else is normalised. Substitution — a synonym, a
 * reformatted date, a rounded number — is precisely what the rule exists to
 * catch, so "4th of March" does not match "4 March" and must not.
 */
function flatten(text) {
  return String(text == null ? '' : text)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* Keys are normalised so that `Deadline`, `deadline ` and `due date` cannot
 * become three facts about one thing. The extractor is also handed the existing
 * key list on every call, so it chooses from a menu rather than inventing a
 * synonym — but a menu is a suggestion and this is the enforcement. */
/* Words that cannot be what a fact is about.
 *
 * A key is the question the value answers, so a key made only of these answers
 * nothing: `that = firm` is a fact about *that*, and by the time anyone reads it
 * back there is no way to find out what "that" was. It is not an invention —
 * the words really were said — which is why the verbatim rule lets it through,
 * and why it needs a rule of its own.
 */
const EMPTY_KEYS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'they',
  'them', 'their', 'he', 'she', 'him', 'her', 'his', 'we', 'us', 'our', 'you',
  'your', 'i', 'me', 'my', 'mine', 'one', 'ones', 'thing', 'things',
  'something', 'anything', 'everything', 'stuff', 'there', 'here', 'and', 'but',
  'so', 'then', 'now', 'ok', 'okay', 'yes', 'sure', 'fine', 'what', 'which',
  'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'some', 'any', 'all',
]);

/* A key names something when at least one of its parts does. `no_cloud` is a
 * fact about the cloud; `that_one` is a fact about nothing at all, and the
 * difference is not how many words are in it. */
function namesSomething(key) {
  return String(key || '').split(/[_.]/).some((part) => part && !EMPTY_KEYS.has(part));
}

function normaliseKey(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '_')
    .replace(/[^a-z0-9_.]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 48);
}

function normaliseKind(raw) {
  const kind = String(raw == null ? '' : raw).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FACT_KINDS, kind) ? kind : 'other';
}

// Tidy the edges of a quoted span without touching its middle. A model that
// hands back "11 March." has quoted correctly and punctuated politely; the
// trailing stop is not part of the fact and its presence is not evidence of
// invention.
function trimValue(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘(\[]+/, '')
    .replace(/[)"'”’\].,;:!]+$/, '')
    .trim();
}

class FactStore {
  static get kinds() {
    return Object.keys(FACT_KINDS);
  }

  static defaults() {
    return { ...FACT_DEFAULTS };
  }

  constructor({ counter, ...config } = {}) {
    if (!counter) throw new Error('The fact store needs a counter.');
    this._counter = counter;
    this._config = { ...FACT_DEFAULTS };
    this.configure(config);
    this._facts = new Map();
    this._stats = this._zeroStats();
  }

  _zeroStats() {
    return {
      written: 0,      // keys that did not exist before
      updated: 0,      // keys whose value changed
      confirmed: 0,    // keys restated with the value they already had
      cleared: 0,      // retractions
      evicted: 0,      // dropped because the store was full
      rejected: {
        'not-verbatim': 0,
        'empty-key': 0,
        'no-key': 0,
        'no-value': 0,
        'too-long': 0,
        'no-source': 0,
        'unknown-key': 0,
      },
    };
  }

  get config() {
    return Object.freeze({ ...this._config });
  }

  get stats() {
    return { ...this._stats, rejected: { ...this._stats.rejected } };
  }

  get rejectedCount() {
    return Object.values(this._stats.rejected).reduce((sum, n) => sum + n, 0);
  }

  get size() {
    return this.all().length;
  }

  configure(patch = {}) {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in this._config)) continue;
      const number = Math.round(Number(raw));
      if (Number.isFinite(number) && number > 0) this._config[key] = number;
    }
    if (this._config.factsBudget < 32) this._config.factsBudget = 32;
    if (this._config.maxFacts < 4) this._config.maxFacts = 4;
    if (this._config.maxValue < 16) this._config.maxValue = 16;
    return this.config;
  }

  reset() {
    this._facts = new Map();
    this._stats = this._zeroStats();
  }

  /* One write, and the only door into the store.
   *
   * Returns a verdict rather than throwing, because a rejected write is a
   * normal event — it is the rule working — and the caller counts it rather
   * than recovering from it.
   */
  write({ key, value, kind = 'other', op = 'set', source = null } = {}) {
    const canonical = normaliseKey(key);
    if (!canonical) return this._reject('no-key', { key });
    /* The second door, beside the verbatim rule and independent of it. That one
     * asks whether anybody said this; this one asks whether it is about
     * anything. Both have to hold, because a store full of true statements
     * about "that" is as useless as one full of invented ones — and unlike an
     * invention, this arrives looking perfectly legitimate. */
    if (!namesSomething(canonical)) return this._reject('empty-key', { key: canonical });

    const text = source && typeof source.text === 'string' ? source.text : null;
    if (!text) return this._reject('no-source', { key: canonical });

    const turn = Number(source.turn) || 0;
    const index = Number.isFinite(Number(source.index)) ? Number(source.index) : null;
    /* Who said it, recorded beside where. It is not decoration: a value the
     * agent settled and a value the user stated are different kinds of claim,
     * and a store that holds both without saying which is which is the door
     * the whole verbatim rule was built to shut — a model's own sentence,
     * quoted back to it later as something established. */
    const role = source.role === 'assistant' ? 'assistant' : 'user';

    if (op === 'clear') {
      const existing = this._facts.get(canonical);
      if (!existing || existing.cleared) return this._reject('unknown-key', { key: canonical });
      // A retraction is a write: the sentence that retracts has to be real too,
      // or "forget everything" becomes a way to edit the record from outside it.
      existing.cleared = true;
      existing.history.push({
        value: existing.value,
        turn: existing.confirmed,
        index: existing.source.index,
        role: existing.source.role,
        until: turn,
      });
      existing.value = null;
      existing.confirmed = turn;
      existing.source = { index, turn, role };
      this._stats.cleared += 1;
      return { ok: true, outcome: 'cleared', key: canonical, fact: this._public(existing) };
    }

    const cleaned = trimValue(value);
    if (!cleaned) return this._reject('no-value', { key: canonical });
    if (cleaned.length > this._config.maxValue) {
      return this._reject('too-long', { key: canonical, value: cleaned });
    }

    // The rule.
    if (!flatten(text).includes(flatten(cleaned))) {
      return this._reject('not-verbatim', { key: canonical, value: cleaned });
    }

    const existing = this._facts.get(canonical);
    if (existing && !existing.cleared && flatten(existing.value) === flatten(cleaned)) {
      // Said again, unchanged. Not a revision, but evidence the fact is still
      // live, which is what the eviction order tie-breaks on.
      existing.confirmed = turn;
      existing.source = { index, turn, role };
      existing.kind = existing.kind === 'other' ? normaliseKind(kind) : existing.kind;
      this._stats.confirmed += 1;
      return { ok: true, outcome: 'confirmed', key: canonical, fact: this._public(existing) };
    }

    if (existing) {
      const previous = existing.value;
      if (previous != null) {
        /* The index, not just the turn. A branch forks at a message, so the
         * question "what did this fact say back there" is asked in message
         * indices, and a version that does not know where it was written cannot
         * answer it. */
        existing.history.push({
          value: previous,
          turn: existing.confirmed,
          index: existing.source.index,
          role: existing.source.role,
          until: turn,
        });
      }
      existing.value = cleaned;
      existing.kind = normaliseKind(kind) === 'other' ? existing.kind : normaliseKind(kind);
      existing.confirmed = turn;
      existing.cleared = false;
      existing.source = { index, turn, role };
      this._stats.updated += 1;
      return {
        ok: true, outcome: 'updated', key: canonical, previous,
        fact: this._public(existing),
      };
    }

    const fact = {
      key: canonical,
      value: cleaned,
      kind: normaliseKind(kind),
      first: turn,
      confirmed: turn,
      cleared: false,
      source: { index, turn, role },
      history: [],
    };
    this._facts.set(canonical, fact);
    this._stats.written += 1;
    this._evict();
    return { ok: true, outcome: 'written', key: canonical, fact: this._public(fact) };
  }

  _reject(reason, detail) {
    if (reason in this._stats.rejected) this._stats.rejected[reason] += 1;
    return { ok: false, reason, ...detail };
  }

  /* One extraction's worth of writes, against one source message.
   *
   * The source is fixed by the caller and cannot be chosen per item: an
   * extractor that could name its own source could cite a message that says
   * what it wishes had been said. It is given one message and may only quote
   * from that one.
   */
  apply(list, { source = null, sources = null } = {}) {
    const written = [];
    const rejected = [];
    const pick = (from) => {
      if (source) return source;
      if (!sources) return null;
      return from === 'assistant' ? sources.assistant : sources.user;
    };

    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') {
        rejected.push(this._reject('no-key', { key: null }));
        continue;
      }
      /* The extractor may now choose between the two messages of this turn,
       * and that is the whole of the freedom it gets. Both are real, both are
       * from this turn, and the quote is checked against the one it named —
       * there is no falling back to the other message when the quote does not
       * match, because "it must be in one of them somewhere" is not provenance.
       */
      const chosen = pick(item.from);
      if (!chosen) {
        rejected.push(this._reject('no-source', { key: item.key || null }));
        continue;
      }
      const verdict = this.write({ ...item, source: { ...chosen, role: item.from === 'assistant' ? 'assistant' : 'user' } });
      (verdict.ok ? written : rejected).push(verdict);
    }
    return { written, rejected };
  }

  // Rank, highest first: kind, then most recently confirmed. Used by the
  // ceiling, by eviction and by the panel, so all three agree about which fact
  // matters more.
  _ranked() {
    return this.all().sort((a, b) => (
      (FACT_KINDS[b.kind] || 1) - (FACT_KINDS[a.kind] || 1)
      || b.confirmed - a.confirmed
      || a.key.localeCompare(b.key)
    ));
  }

  _evict() {
    const ranked = this._ranked();
    if (ranked.length <= this._config.maxFacts) return;
    for (const fact of ranked.slice(this._config.maxFacts)) {
      this._facts.delete(fact.key);
      this._stats.evicted += 1;
    }
  }

  _public(fact) {
    return { ...fact, source: { ...fact.source }, history: fact.history.map((entry) => ({ ...entry })) };
  }

  get(key) {
    const fact = this._facts.get(normaliseKey(key));
    return fact && !fact.cleared ? this._public(fact) : null;
  }

  all() {
    return [...this._facts.values()].filter((fact) => !fact.cleared).map((fact) => this._public(fact));
  }

  cleared() {
    return [...this._facts.values()].filter((fact) => fact.cleared).map((fact) => this._public(fact));
  }

  // Everything, tombstones included, in rank order — the panel's list.
  table() {
    const live = this._ranked();
    const dead = this.cleared().sort((a, b) => b.confirmed - a.confirmed);
    return [...live, ...dead];
  }

  /* The block that goes up the wire.
   *
   * One line per fact, `key = value`, because a line is the unit a reader — a
   * model, or the stub's retrieval oracle — can match a question against. The
   * superseded values are not here. That is the point of the strategy: the
   * store has an opinion about which value is current, and a payload that
   * carries both has no opinion at all.
   *
   * When the ceiling bites, the block says so in the block. A silent truncation
   * is a summary that lost a fact without telling anyone, which is the failure
   * task 9 could only catch with a benchmark.
   */
  block(model, { budget = null } = {}) {
    const ceiling = Math.max(32, Number(budget) || this._config.factsBudget);
    const ranked = this._ranked();
    if (!ranked.length) {
      return { text: '', tokens: 0, included: [], dropped: 0, truncated: false, ceiling };
    }

    const size = (text) => this._counter.estimate(text, model);
    const anyMarked = ranked.some((fact) => fact.source.role === 'assistant');
    const notice = (n) => `[${n} further ${n === 1 ? 'fact does' : 'facts do'} not fit the ${ceiling}-token ceiling]`;

    /* A line the agent settled is marked, and the header explains the mark
     * once — one token a line rather than a parenthesis a line. The model is
     * the reader here, and "you committed to this yourself" is a different
     * claim from "the user told you this", which is the distinction that makes
     * reading the reply safe enough to do at all. */
    const lines = ranked.map((fact) => (fact.source.role === 'assistant'
      ? `${BLOCK_MARK} ${fact.key} = ${fact.value}`
      : `${fact.key} = ${fact.value}`));
    let used = size(BLOCK_HEADER) + (anyMarked ? size(BLOCK_MARK_NOTE) : 0);
    let take = 0;
    while (take < lines.length) {
      const next = used + size(lines[take]) + 1;
      const remaining = lines.length - take - 1;
      // Reserve room for the notice if anything will be left behind, so that
      // admitting the truncation cannot itself be truncated.
      const reserve = remaining > 0 ? size(notice(remaining)) + 1 : 0;
      if (next + reserve > ceiling) break;
      used = next;
      take += 1;
    }

    const included = ranked.slice(0, take);
    const dropped = ranked.length - take;
    const marked = included.some((fact) => fact.source.role === 'assistant');
    const body = [
      marked ? `${BLOCK_HEADER.replace(/:$/, '')}${BLOCK_MARK_NOTE}:` : BLOCK_HEADER,
      ...lines.slice(0, take),
    ];
    if (dropped > 0) body.push(notice(dropped));
    const text = body.join('\n');

    return {
      text,
      tokens: size(text),
      included: included.map((fact) => this._public(fact)),
      dropped,
      truncated: dropped > 0,
      ceiling,
    };
  }

  /* What the extractor is shown of the store: the keys it may write to and
   * what they currently say. This is the anti-drift measure — a model handed
   * `deadline = 4 March` writes `deadline` when the date moves, where a model
   * handed nothing writes `due_date` and the store ends up believing both.
   *
   * It is also the whole input, beside one message. That is what makes
   * extraction O(1) in the length of the conversation where a fold was O(n).
   */
  menu({ limit = 30 } = {}) {
    return this._ranked().slice(0, limit).map((fact) => (fact.source.role === 'assistant'
      ? `${fact.key} = ${fact.value} (you settled this)`
      : `${fact.key} = ${fact.value}`));
  }

  /* What the extractor is sent, built here so that the agent — which owns the
   * request but not the contract — cannot quietly change the deal.
   *
   * One message and the key list. Nothing else, and specifically not the
   * conversation: a fold read the whole history and cost O(n), which is why it
   * could only be afforded every ten messages. This costs the same on turn two
   * and turn two hundred, which is what makes "after every user message"
   * something other than a slogan.
   */
  request({ said = [], turn = 0 } = {}) {
    const known = this.menu();
    const half = (role, label) => {
      const found = (Array.isArray(said) ? said : []).find((entry) => entry && entry.role === role);
      return found && String(found.text || '').trim()
        ? [label, String(found.text)]
        : [];
    };
    return {
      system: EXTRACT_SYSTEM,
      user: [
        known.length ? `Known facts:\n${known.join('\n')}` : 'Known facts: none yet.',
        '',
        `Turn ${turn}.`,
        ...half('user', 'The user said:'),
        ...half('assistant', 'The assistant replied:'),
      ].join('\n'),
    };
  }

  /* The reply, turned into write candidates.
   *
   * Deliberately forgiving about everything except content: a model that wraps
   * its JSON in a code fence or explains itself first has still answered, and
   * refusing it would make the store depend on formatting discipline instead of
   * on the verbatim rule. It is not forgiving about what a candidate is — that
   * is checked, one at a time, by `write()`.
   */
  static parse(raw) {
    const text = String(raw == null ? '' : raw)
      .replace(/^[\s\S]*?```(?:json)?/i, (match) => (/```/.test(match) ? '' : match))
      .replace(/```[\s\S]*$/, '')
      .trim();

    const start = text.search(/[[{]/);
    if (start < 0) return [];
    const open = text[start];
    const close = open === '[' ? ']' : '}';
    const end = text.lastIndexOf(close);
    if (end <= start) return [];

    let parsed;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch (error) {
      return [];
    }

    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.facts) ? parsed.facts : []);

    return list
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        key: item.key,
        value: item.value,
        kind: item.kind,
        from: item.from === 'assistant' ? 'assistant' : 'user',
        op: item.op === 'clear' || item.op === 'delete' ? 'clear' : 'set',
      }));
  }

  // Which messages are still speaking through the store. The panel's map uses
  // it to tell a message that was distilled into a fact apart from one that was
  // simply dropped, which under this policy are the two ways out of the window.
  sources() {
    const out = new Set();
    for (const fact of this._facts.values()) {
      if (!fact.cleared && fact.source && fact.source.index != null) out.add(fact.source.index);
    }
    return out;
  }

  /* What this store said when the conversation was `index` messages long.
   *
   * Branching forks the conversation at a message, so it has to fork the facts
   * at the same message or the second branch starts out believing decisions
   * that were only ever made in the first one. Handing a fork the *current*
   * facts is the most natural mistake available here and it is exactly the leak
   * the benchmark tests for.
   *
   * Every version of every fact knows the message it was written at, so this is
   * a lookup rather than a replay: take the last version written before the
   * cut, and drop the fact entirely if it has none — at that point in the
   * conversation, nobody had said it yet.
   */
  rewind(index) {
    const cut = Number(index);
    if (!Number.isFinite(cut)) return this.snapshot();

    const facts = [];
    for (const fact of this.table()) {
      const versions = [
        ...fact.history.map((entry) => ({
          value: entry.value,
          turn: entry.turn,
          index: entry.index,
          role: entry.role,
        })),
        {
          value: fact.value,
          turn: fact.confirmed,
          index: fact.source.index,
          role: fact.source.role,
        },
      ].filter((version) => version.index != null && version.index < cut);

      const live = versions[versions.length - 1];
      // Either it had not been said yet, or the last thing that happened to it
      // before the cut was a retraction.
      if (!live || live.value == null) continue;

      facts.push({
        key: fact.key,
        value: live.value,
        kind: fact.kind,
        cleared: false,
        first: fact.first,
        confirmed: live.turn,
        source: { index: live.index, turn: live.turn, role: live.role || 'user' },
        history: fact.history
          .filter((entry) => entry.index != null && entry.index < live.index)
          .map((entry) => ({ ...entry })),
      });
    }

    // The counters are not rewound. They measure extraction, extraction
    // happened, and a branch is not a way to un-spend the tokens it cost.
    return { facts, stats: this.stats };
  }

  // A copy that shares nothing. Branching needs facts to fork with the
  // conversation: two branches from one checkpoint hold contradictory values
  // at the same time and neither of them is wrong, which is only true if
  // neither can write to the other.
  fork() {
    const copy = new FactStore({ counter: this._counter, ...this._config });
    copy.restore(this.snapshot());
    return copy;
  }

  snapshot() {
    return {
      facts: this.table().map((fact) => this._public(fact)),
      stats: this.stats,
    };
  }

  restore(snapshot) {
    this.reset();
    if (!snapshot || typeof snapshot !== 'object') return;

    for (const raw of Array.isArray(snapshot.facts) ? snapshot.facts : []) {
      const key = normaliseKey(raw && raw.key);
      if (!key) continue;
      const cleared = Boolean(raw.cleared);
      const value = cleared ? null : trimValue(raw.value);
      // A restored fact is not re-checked against a source it no longer has.
      // What it is checked for is shape: a stored record is the one place a
      // value could re-enter the block without ever passing the rule, so an
      // entry with no value and no tombstone is dropped rather than trusted.
      if (!cleared && !value) continue;
      this._facts.set(key, {
        key,
        value,
        kind: normaliseKind(raw.kind),
        first: Number(raw.first) || 0,
        confirmed: Number(raw.confirmed) || Number(raw.first) || 0,
        cleared,
        source: {
          index: Number.isFinite(Number(raw.source && raw.source.index)) ? Number(raw.source.index) : null,
          turn: Number(raw.source && raw.source.turn) || 0,
          // A record written before roles existed is the user's: that is what
          // the store held at the time, and guessing otherwise would invent
          // provenance rather than restore it.
          role: raw.source && raw.source.role === 'assistant' ? 'assistant' : 'user',
        },
        history: (Array.isArray(raw.history) ? raw.history : [])
          .filter((entry) => entry && typeof entry.value === 'string')
          .map((entry) => ({
            value: entry.value,
            turn: Number(entry.turn) || 0,
            index: Number.isFinite(Number(entry.index)) ? Number(entry.index) : null,
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            until: Number(entry.until) || 0,
          })),
      });
    }

    const stats = snapshot.stats || {};
    this._stats = {
      ...this._zeroStats(),
      written: Number(stats.written) || 0,
      updated: Number(stats.updated) || 0,
      confirmed: Number(stats.confirmed) || 0,
      cleared: Number(stats.cleared) || 0,
      evicted: Number(stats.evicted) || 0,
      rejected: { ...this._zeroStats().rejected, ...(stats.rejected || {}) },
    };
  }
}
