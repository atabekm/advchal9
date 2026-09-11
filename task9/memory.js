/* The compressor.
 *
 * One question, asked before every send: how much of the past goes up the wire?
 * Task 8 answered it with a slice — keep what fits, delete the rest. This file
 * adds the other answer: keep the recent turns exactly as they were said, and
 * replace everything older with prose that a model wrote about them.
 *
 * It owns three things nobody else may touch: the cut point between what is
 * still verbatim and what has been folded, the chain of summaries produced by
 * folding, and the arithmetic that says whether any of it was worth doing.
 *
 * It never touches the DOM and never sends anything. Folding needs a model, so
 * `fold()` is handed a `summarise` callback and does not know or care whether
 * it reaches an endpoint, a stub, or a test.
 *
 *   compressor.select(messages)       what would be sent, and what would not
 *   compressor.wire(...)              the payload, assembled
 *   compressor.due(messages)          is a fold owed, and why
 *   await compressor.fold(...)        do one; throws rather than losing anything
 *   compressor.counterfactual(...)    this turn's bill against `full`'s bill
 *   compressor.savings()              what folding has cost and bought so far
 *   compressor.snapshot() / .restore(...)
 */

/* The four answers. They are ordered by how much of the past survives, which is
 * also the order they cost money in — with one deliberate exception, and the
 * exception is the whole task: `compress` costs more than `window` and is
 * supposed to buy something with the difference. */
const MEMORY_POLICIES = ['none', 'full', 'window', 'compress'];

const MEMORY_DEFAULTS = {
  policy: 'compress',
  keepRecent: 6,
  compressEvery: 10,
  summaryBudget: 256,
};

/* The instruction that produces a summary.
 *
 * It lives here rather than in the agent because it is not a persona — it is a
 * specification of what a summary must not lose, and what a summary must not
 * lose is the compressor's business. Every clause in it is load-bearing:
 *
 *   - facts first, prose second, because the benchmark greps for facts
 *   - names, numbers, dates and identifiers verbatim, because paraphrasing
 *     "10.2.0.7" is the same as deleting it
 *   - nothing that was not said, because a summary sits in the system slot of
 *     every future request, where an invention is laundered into a premise
 *   - the summary is rewritten, not appended to, because an appended summary
 *     grows until it is the thing it replaced
 */
const SUMMARY_SYSTEM = [
  'You compress conversation history for another assistant that will only ever',
  'see your summary, never the original messages.',
  '',
  'Rules:',
  '1. Preserve every concrete fact: names, numbers, dates, identifiers, file',
  '   paths, decisions, preferences, and anything the user asked to be',
  '   remembered. Copy them exactly — never paraphrase an identifier.',
  '2. Preserve open threads: questions left unanswered, tasks left unfinished.',
  '3. Write nothing that was not in the source. If you are unsure whether',
  '   something was said, leave it out.',
  '4. Drop pleasantries, filler, and your own earlier phrasing.',
  '5. Terse notes, not prose. No preamble, no "the user asked". Just the facts,',
  '   one per line where that is natural.',
  '',
  'You are given the previous summary (if any) followed by newer messages.',
  'Return one rewritten summary covering both. Do not append; rewrite.',
].join('\n');

// How a fold is presented to the summariser. The previous summary goes in as a
// block that is clearly already-compressed, so the model knows which half of its
// input has been through the grinder before and which half is fresh.
function renderFoldSource(previous, messages) {
  const parts = [];
  if (previous) {
    parts.push('--- summary so far (generations 1-' + previous.generation + ') ---');
    parts.push(previous.text);
    parts.push('');
  }
  parts.push('--- newer messages ---');
  for (const message of messages) {
    parts.push(`${message.role}: ${message.content}`);
  }
  return parts.join('\n');
}

/* A fold must not cut a reply away from the question it answers. Messages
 * alternate, so the cut belongs on a user message; if it does not land on one,
 * move it back rather than forward. Folding less is always the safe direction —
 * it keeps a pair together at the cost of a few tokens, where folding more
 * leaves an assistant message verbatim with nothing to answer. */
function alignToTurn(messages, index) {
  let cut = Math.max(0, Math.min(index, messages.length));
  while (cut > 0 && messages[cut] && messages[cut].role !== 'user') cut -= 1;
  return cut;
}

class SummaryChain {
  constructor(entries) {
    this.entries = [];
    if (Array.isArray(entries)) this.restore(entries);
  }

  get length() {
    return this.entries.length;
  }

  get latest() {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  get generation() {
    return this.entries.length;
  }

  push(entry) {
    this.entries.push(entry);
    return entry;
  }

  clear() {
    this.entries = [];
  }

  snapshot() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  restore(entries) {
    this.entries = [];
    for (const entry of entries || []) {
      if (!entry || typeof entry.text !== 'string') continue;
      this.entries.push({
        generation: Number(entry.generation) || this.entries.length + 1,
        text: entry.text,
        tokens: Number(entry.tokens) || 0,
        model: entry.model || null,
        at: Number(entry.at) || Date.now(),
        covers: Number(entry.covers) || 0,
        foldedMessages: Number(entry.foldedMessages) || 0,
        foldedTokens: Number(entry.foldedTokens) || 0,
        savedPerTurn: Number(entry.savedPerTurn) || 0,
        spentTokens: Number(entry.spentTokens) || 0,
        spentCost: Number(entry.spentCost) || 0,
        reason: entry.reason || null,
        truncated: Boolean(entry.truncated),
      });
    }
  }
}

// A fold that could not be written. It exists so the agent can tell the
// difference between "the summariser failed" and "the turn failed": the first
// one is survivable, and the rule it enforces is that nothing is evicted until
// a summary exists to stand in for it.
class FoldError extends Error {
  constructor(message, { cause = null, reason = null } = {}) {
    super(message);
    this.name = 'FoldError';
    this.code = 'fold_failed';
    this.cause = cause;
    this.reason = reason;
    this.retryable = false;
  }
}

class Compressor {
  static get policies() {
    return MEMORY_POLICIES.slice();
  }

  static defaults() {
    return { ...MEMORY_DEFAULTS };
  }

  constructor({ counter, ...config } = {}) {
    if (!counter) throw new Error('The compressor needs a counter.');
    this._counter = counter;
    this._config = { ...MEMORY_DEFAULTS };
    this.configure(config);

    // The cut point: messages[0 .. _folded) are represented by the latest
    // summary and are never sent again. Everything from _folded onward is still
    // verbatim, including messages older than the keep-window that the schedule
    // has not got to yet.
    this._folded = 0;
    this._chain = new SummaryChain();
    // What folding has cost, in tokens actually billed by the summariser.
    this._spent = { folds: 0, tokens: 0, cost: 0, failures: 0 };
  }

  get config() {
    return Object.freeze({ ...this._config });
  }

  get chain() {
    return this._chain;
  }

  get summary() {
    return this._chain.latest;
  }

  get generation() {
    return this._chain.generation;
  }

  configure(patch = {}) {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in this._config)) continue;
      if (key === 'policy') {
        this._config.policy = MEMORY_POLICIES.includes(raw) ? raw : MEMORY_DEFAULTS.policy;
        continue;
      }
      const number = Math.round(Number(raw));
      if (Number.isFinite(number) && number >= 0) this._config[key] = number;
    }
    // A keep-window of zero under `compress` would fold a message the instant it
    // was said, including the one being answered. Two is the floor: one exchange.
    if (this._config.keepRecent < 2) this._config.keepRecent = 2;
    if (this._config.compressEvery < 2) this._config.compressEvery = 2;
    return this.config;
  }

  reset() {
    this._folded = 0;
    this._chain.clear();
    this._spent = { folds: 0, tokens: 0, cost: 0, failures: 0 };
  }

  /* What would go up the wire, as counts and slices, without building it.
   *
   * The four policies differ only here. Everything downstream — the meter, the
   * ledger, the benchmark — reads this one shape, which is why adding a fifth
   * answer later would be a change to one function. */
  select(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const { policy, keepRecent } = this._config;

    if (policy === 'none') {
      return {
        policy, summary: null, verbatim: [], folded: 0, pending: 0,
        dropped: list.length, held: list.length,
      };
    }

    if (policy === 'full') {
      return {
        policy, summary: null, verbatim: list.slice(), folded: 0, pending: 0,
        dropped: 0, held: list.length,
      };
    }

    if (policy === 'window') {
      const from = alignToTurn(list, Math.max(0, list.length - keepRecent));
      return {
        policy, summary: null, verbatim: list.slice(from), folded: 0, pending: 0,
        dropped: from, held: list.length,
      };
    }

    // compress: the summary stands in for everything before the cut, and
    // everything after it is verbatim — including the messages the schedule has
    // not folded yet. That backlog is why the prompt sawtooths instead of
    // staying flat, and pretending otherwise would make the meter lie.
    const folded = Math.min(this._folded, list.length);
    const pending = Math.max(0, list.length - keepRecent - folded);
    return {
      policy,
      summary: this._chain.latest,
      verbatim: list.slice(folded),
      folded,
      pending,
      dropped: 0,
      held: list.length,
    };
  }

  /* The payload. The summary is a system message, not a fabricated turn: it is
   * not something anybody said, so giving it a speaker would be a lie the model
   * reasons from, and it has to survive every future fold without being mistaken
   * for history that can be folded again. */
  wire({ messages = [], systemPrompt = '', next = '' } = {}) {
    const selection = this.select(messages);
    const payload = [];

    if (systemPrompt) payload.push({ role: 'system', content: systemPrompt });
    if (selection.summary) {
      payload.push({
        role: 'system',
        content: `Earlier in this conversation (compressed, generation `
          + `${selection.summary.generation}):\n${selection.summary.text}`,
      });
    }
    for (const message of selection.verbatim) {
      payload.push({ role: message.role, content: message.content });
    }
    if (next) payload.push({ role: 'user', content: next });

    return { messages: payload, selection };
  }

  // The same list the panel draws: one row per message in the conversation,
  // labelled with what happens to it on the next send.
  map(messages = []) {
    const selection = this.select(messages);
    const list = Array.isArray(messages) ? messages : [];
    const verbatimFrom = list.length - selection.verbatim.length;
    return list.map((message, index) => ({
      index,
      role: message.role,
      state: index >= verbatimFrom
        ? 'sent'
        : (selection.policy === 'compress' ? 'summarised' : 'dropped'),
    }));
  }

  /* Is a fold owed?
   *
   * Two triggers, one answer. The schedule is the brief's "every 10 messages";
   * pressure is the window filling up before the schedule gets there, and it
   * folds early rather than letting the request fail on principle. */
  due(messages = [], { pressure = false } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (this._config.policy !== 'compress') return { due: false, reason: null, count: 0 };

    const cut = alignToTurn(list, Math.max(0, list.length - this._config.keepRecent));
    const count = Math.max(0, cut - Math.min(this._folded, list.length));
    if (count <= 0) return { due: false, reason: null, count: 0 };

    if (count >= this._config.compressEvery) return { due: true, reason: 'schedule', count };
    if (pressure) return { due: true, reason: 'pressure', count };
    return { due: false, reason: null, count };
  }

  // What the summariser will be asked to read, built without sending it. The
  // agent needs this to count the fold before paying for it.
  foldSource(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const cut = alignToTurn(list, Math.max(0, list.length - this._config.keepRecent));
    const from = Math.min(this._folded, list.length);
    const slice = list.slice(from, cut);
    if (!slice.length) return null;
    return {
      from,
      to: cut,
      slice,
      previous: this._chain.latest,
      text: renderFoldSource(this._chain.latest, slice),
    };
  }

  /* Do a fold.
   *
   * `summarise` is injected: (sourceText, { system, budget, generation }) ->
   * { text, usage, cost, finishReason }. This function does not know what is on
   * the other end of it.
   *
   * The rule this function exists to enforce: **nothing is evicted until a
   * summary exists to stand in for it.** A summariser that 429s, times out, or
   * comes back empty leaves the conversation byte-for-byte as it was and throws.
   * Losing messages to a network error is not a trade-off, it is data loss. */
  async fold(messages = [], { model, summarise, reason = 'schedule' } = {}) {
    if (typeof summarise !== 'function') throw new Error('fold needs a summarise callback.');

    const source = this.foldSource(messages);
    if (!source) return null;

    const previous = source.previous;
    const budget = this._config.summaryBudget;

    let result;
    try {
      result = await summarise(source.text, {
        system: SUMMARY_SYSTEM,
        budget,
        generation: this._chain.generation + 1,
      });
    } catch (error) {
      this._spent.failures += 1;
      throw new FoldError(
        `The summariser failed, so nothing was folded: ${error.message}`,
        { cause: error, reason },
      );
    }

    const text = String((result && result.text) || '').trim();
    if (!text) {
      this._spent.failures += 1;
      throw new FoldError(
        'The summariser returned nothing, so nothing was folded — the conversation '
        + 'is untouched and this turn goes out uncompressed.',
        { reason },
      );
    }

    // Arithmetic, in the only order that makes it honest. What the fold removes
    // from every future request is the messages *plus* the summary it replaces;
    // what it adds back is the new summary. The difference is what each
    // subsequent turn no longer carries.
    // Per-message, not countMessages: the reply priming that countMessages adds
    // is paid once per request, not once per message, and counting it here
    // would credit the fold with tokens it did not save.
    const foldedTokens = source.slice
      .reduce((sum, message) => sum + this._counter.countMessage(message, model), 0)
      + (previous ? this._counter.countMessage({ content: previous.text }, model) : 0);
    const tokens = this._counter.countMessage({ content: text }, model);
    const savedPerTurn = foldedTokens - tokens;

    const usage = (result && result.usage) || {};
    const spentTokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
    const spentCost = typeof result.cost === 'number' ? result.cost : 0;

    const entry = this._chain.push({
      generation: this._chain.generation + 1,
      text,
      tokens,
      model: model || null,
      at: Date.now(),
      covers: source.to,
      foldedMessages: source.slice.length,
      foldedTokens,
      savedPerTurn,
      spentTokens,
      spentCost,
      reason,
      // A summary cut off at its ceiling is a summary that stopped mid-fact.
      // It is still better than nothing and it is not allowed to be quiet.
      truncated: (result && result.finishReason) === 'length',
    });

    this._folded = source.to;
    this._spent.folds += 1;
    this._spent.tokens += spentTokens;
    this._spent.cost += spentCost;

    return entry;
  }

  /* This turn's bill against the bill `full` would have run up.
   *
   * The counterfactual is the honest version of "tokens before vs after",
   * because it is measured on the same conversation rather than on two
   * different ones. It is cheap: the counter caches per message text, and a
   * message never changes after it is said. */
  counterfactual({ messages = [], systemPrompt = '', next = '', model, maxTokens = 0 } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const full = this._counter.plan({
      model, systemPrompt, history: list, next, maxTokens,
    });

    const selection = this.select(list);
    const carried = selection.verbatim.slice();
    if (selection.summary) {
      carried.unshift({ role: 'system', content: selection.summary.text });
    }
    const actual = this._counter.plan({
      model, systemPrompt, history: carried, next, maxTokens,
    });

    return {
      full: full.prompt,
      actual: actual.prompt,
      saved: full.prompt - actual.prompt,
      ratio: full.prompt > 0 ? (full.prompt - actual.prompt) / full.prompt : 0,
      summaryTokens: selection.summary
        ? this._counter.countMessage({ content: selection.summary.text }, model)
        : 0,
      messagesSent: selection.verbatim.length,
      messagesHeld: selection.held,
    };
  }

  /* What folding has cost, what it buys per turn, and when those two meet.
   *
   * The number most demonstrations of this technique leave out is the first
   * one. A summary is written by a model, in a second request, and it is
   * billed. Compression that has not yet paid for itself is a cost, not a
   * saving, and for a short conversation it never will be. */
  savings({ turnsSinceFold = 0 } = {}) {
    const latest = this._chain.latest;
    const savedPerTurn = latest ? latest.savedPerTurn : 0;
    const spentTokens = this._spent.tokens;
    const breakEven = savedPerTurn > 0 ? Math.ceil(spentTokens / savedPerTurn) : null;

    return {
      folds: this._spent.folds,
      failures: this._spent.failures,
      spentTokens,
      spentCost: this._spent.cost,
      savedPerTurn,
      generation: this._chain.generation,
      summaryTokens: latest ? latest.tokens : 0,
      // Tokens not carried since the last fold, against tokens spent making it
      // possible. Negative means the fold has not paid for itself yet.
      net: savedPerTurn * turnsSinceFold - spentTokens,
      breakEvenTurns: breakEven,
      paidOff: breakEven != null && turnsSinceFold >= breakEven,
    };
  }

  // How the summary itself has grown across folds. A rolling summary with no
  // ceiling converges on the length of the history it replaced, at which point
  // you are paying for both.
  growth() {
    return this._chain.entries.map((entry) => ({
      generation: entry.generation,
      tokens: entry.tokens,
      foldedMessages: entry.foldedMessages,
      foldedTokens: entry.foldedTokens,
      savedPerTurn: entry.savedPerTurn,
      spentTokens: entry.spentTokens,
      spentCost: entry.spentCost,
      truncated: entry.truncated,
      reason: entry.reason,
      at: entry.at,
    }));
  }

  snapshot() {
    return {
      folded: this._folded,
      summaries: this._chain.snapshot(),
      spent: { ...this._spent },
    };
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this._folded = Number(snapshot.folded) || 0;
    this._chain.restore(snapshot.summaries);
    const spent = snapshot.spent || {};
    this._spent = {
      folds: Number(spent.folds) || 0,
      tokens: Number(spent.tokens) || 0,
      cost: Number(spent.cost) || 0,
      failures: Number(spent.failures) || 0,
    };
  }
}
