/* The agent.
 *
 * Everything the interface is not allowed to know lives here: the persona, the
 * conversation, the trimming rule, the payload shape, the retry policy, the
 * bookkeeping. `app.js` may call these methods and read these snapshots; it may
 * not reach in and set a field, and it never sees fetch, a status code or a
 * messages array it built itself.
 *
 *   agent.config              frozen snapshot of every constructor property
 *   agent.compressor          the memory policy, for panels that want to read it
 *   agent.configure(patch)    the only way to change one
 *   agent.send(text, opts)    one turn, start to finish
 *   agent.reset()             forget the conversation
 *   agent.history, .stats     frozen views
 *   Agent.schema              the field descriptors the config panel is built from
 */

const AGENT_SCHEMA = [
  {
    key: 'name',
    type: 'text',
    label: 'name',
    default: 'Ada',
    help: 'Shown on every reply.',
  },
  {
    key: 'model',
    type: 'select',
    label: 'model',
    default: 'deepseek-flash',
    options: ['deepseek-flash', 'deepseek-v4-pro', 'stub-16k'],
    help: 'Pro costs about four times flash. stub-16k is not a real model — it is a small window.',
  },
  {
    key: 'systemPrompt',
    type: 'textarea',
    label: 'system prompt',
    default: 'You are Ada, a precise and concise assistant. '
      + 'Answer in at most three short paragraphs. '
      + 'If a question is ambiguous, say what you assumed rather than asking.',
    help: 'Prepended to every request. Change it mid-conversation and watch the next turn.',
  },
  {
    key: 'thinking',
    type: 'select',
    label: 'thinking',
    default: 'off',
    options: ['off', 'low', 'high', 'max'],
    help: 'On by default upstream, at high effort. Reasoning is billed as output '
      + 'and spent from the same ceiling as the answer.',
  },
  {
    key: 'temperature',
    type: 'range',
    label: 'temperature',
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
    help: '0 is near-deterministic, 1.2 is loose.',
  },
  {
    key: 'maxTokens',
    type: 'number',
    label: 'max tokens',
    default: 800,
    min: 16,
    max: 8192,
    step: 16,
    help: 'Hitting it shows as finish_reason: length.',
  },
  {
    key: 'memoryPolicy',
    type: 'select',
    label: 'memory',
    default: 'compress',
    options: ['none', 'full', 'window', 'compress'],
    help: 'none is stateless. full resends everything. window keeps the last few '
      + 'and deletes the rest. compress keeps the last few and summarises the rest.',
  },
  {
    key: 'keepRecent',
    type: 'number',
    label: 'keep verbatim',
    default: 6,
    min: 2,
    max: 60,
    step: 2,
    help: 'Messages kept exactly as they were said. Everything older is summarised '
      + 'under compress, or deleted under window.',
  },
  {
    key: 'compressEvery',
    type: 'number',
    label: 'fold every',
    default: 10,
    min: 2,
    max: 60,
    step: 2,
    help: 'Messages that must pile up beyond the verbatim window before a fold is '
      + 'owed. Smaller folds more often and pays the summariser more often.',
  },
  {
    key: 'summaryModel',
    type: 'select',
    label: 'summariser',
    default: 'deepseek-flash',
    options: ['deepseek-flash', 'deepseek-v4-pro', 'stub-16k'],
    help: 'Writing the summary is a second request and it is billed. It does not '
      + 'have to be the model holding the conversation.',
  },
  {
    key: 'summaryBudget',
    type: 'number',
    label: 'summary ceiling',
    default: 256,
    min: 64,
    max: 2048,
    step: 32,
    help: 'A rolling summary with no ceiling grows until it is as long as the '
      + 'history it replaced, and then you are paying for both.',
  },
  {
    key: 'historyBudget',
    type: 'number',
    label: 'history cap',
    default: 0,
    min: 0,
    max: 120000,
    step: 500,
    help: 'A cap of your own, in tokens. 0 carries everything the window allows.',
  },
  {
    key: 'overflowPolicy',
    type: 'select',
    label: 'on overflow',
    default: 'trim',
    options: ['trim', 'refuse', 'send'],
    help: 'The last resort, after the memory policy has had its say: trim drops the '
      + 'oldest turns, refuse stops before the request, send lets the API say no.',
  },
  {
    key: 'retries',
    type: 'number',
    label: 'retries',
    default: 1,
    min: 0,
    max: 3,
    step: 1,
    help: 'Extra attempts after 429 or 5xx, inside the agent.',
  },
  {
    key: 'stream',
    type: 'toggle',
    label: 'stream',
    default: true,
    help: 'Read the reply token by token.',
  },
];

const RETRY_BASE_MS = 600;

// Refusing before the request is a different failure from being refused by the
// endpoint, and the difference is the whole reason to count first: one of them
// costs nothing.
class ContextOverflowError extends Error {
  constructor(plan) {
    super(
      `This request does not fit. ${plan.prompt} prompt tokens plus ${plan.reserved} reserved `
      + `for the reply is ${plan.total}, and ${plan.model} holds ${plan.limit}. `
      + `Over by ${plan.overflowBy}.`
    );
    this.name = 'ContextOverflowError';
    this.code = 'context_length_exceeded';
    this.status = null;
    this.retryable = false;
    this.plan = plan;
  }
}

// A reply that never arrived is not the same failure as a request that never
// left: this one was paid for. The tokens are billed, the reasoning may even be
// worth reading, and the only thing missing is the answer.
class EmptyReplyError extends Error {
  constructor({ ceiling, usage = {}, finishReason }) {
    const reasoning = usage.reasoningTokens || 0;
    const wrote = usage.completionTokens || 0;
    const starved = finishReason === 'length';
    super(starved
      ? `The ${ceiling}-token ceiling ran out before the answer began — `
        + `${wrote} tokens written, ${reasoning} of them reasoning, none of them content. `
        + 'Raise the ceiling or ask for a shorter answer.'
      : 'The model returned no content at all — only an empty completion.');
    this.name = 'EmptyReplyError';
    this.code = starved ? 'reply_starved' : 'reply_empty';
    this.status = null;
    this.retryable = false;
    this.ceiling = ceiling;
    this.usage = usage;
    this.finishReason = finishReason || null;
  }
}

class Agent {
  static get schema() {
    return AGENT_SCHEMA;
  }

  static defaults() {
    const config = {};
    for (const field of AGENT_SCHEMA) config[field.key] = field.default;
    return config;
  }

  constructor(options = {}) {
    const { transport, onEvent, counter, compressor, ...config } = options;
    if (!transport) throw new Error('Agent needs a transport.');

    this._transport = transport;
    // The counter is injected for the same reason the transport is: it carries
    // what it has learned about this tokeniser, and that learning must outlive
    // any one agent object.
    this._counter = counter instanceof TokenCounter ? counter : new TokenCounter();
    // The compressor is injected for a third reason: it holds the summary, and
    // the summary is part of the conversation. Swapping transports must not
    // amnesia the compressed half any more than it amnesias the verbatim half.
    this._compressor = compressor instanceof Compressor
      ? compressor
      : new Compressor({ counter: this._counter });
    this._ledger = new TurnLedger();
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._config = Agent.defaults();
    this._messages = [];
    this._turn = 0;
    this._seq = 0;
    this._busy = false;
    this._stats = {
      turns: 0,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cost: 0,
      elapsed: 0,
      // Folding is billed. It is kept in its own columns so that a fold is
      // never mistaken for an expensive answer, and added into `cost` anyway
      // because the money left the account either way.
      folds: 0,
      foldFailures: 0,
      foldTokens: 0,
      foldCost: 0,
      foldElapsed: 0,
      // What `full` would have cost, accumulated turn by turn on this same
      // conversation. The honest version of "before and after".
      wouldHaveSent: 0,
      actuallySent: 0,
    };

    for (const [key, value] of Object.entries(config)) {
      if (key in this._config) this._config[key] = this._coerce(key, value);
    }
    this._syncCompressor();

    this._emit('agent:new', {
      transport: this._transport.id,
      endpoint: this._transport.endpoint,
      config: { ...this._config },
    });
  }

  get transport() {
    return { id: this._transport.id, label: this._transport.label, endpoint: this._transport.endpoint };
  }

  get config() {
    return Object.freeze({ ...this._config });
  }

  get history() {
    return this._messages.map((message) => Object.freeze({ ...message }));
  }

  get stats() {
    return Object.freeze({ ...this._stats });
  }

  get busy() {
    return this._busy;
  }

  get counter() {
    return this._counter;
  }

  get ledger() {
    return this._ledger;
  }

  get compressor() {
    return this._compressor;
  }

  /* The memory policy is four fields in the config and one object underneath,
   * and the config is the one that a person edits. This keeps them in step —
   * called from the constructor and from configure(), and nowhere else. */
  _syncCompressor() {
    this._compressor.configure({
      policy: this._config.memoryPolicy,
      keepRecent: this._config.keepRecent,
      compressEvery: this._config.compressEvery,
      summaryBudget: this._config.summaryBudget,
    });
  }

  /* What the past looks like on the way out: the summary, if there is one, then
   * the messages still being sent verbatim. The counter takes a list of
   * messages and does not care that one of them is prose the agent wrote about
   * the others, so the summary goes in as a message here and as a system
   * message on the wire. Both are true; only one is billable arithmetic. */
  _carried(selection) {
    const carried = selection.verbatim.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    if (selection.summary) {
      carried.unshift({ role: 'system', content: selection.summary.text });
    }
    return carried;
  }

  // What the next request would cost, counted without sending it. `text` is
  // whatever is sitting in the composer, including nothing.
  plan(text = '') {
    const selection = this._compressor.select(this._messages);
    return this._planFor(this._carried(selection), text);
  }

  // The same question asked of the policy that keeps nothing back. Two numbers
  // side by side are the only honest way to say what compression is worth, and
  // measuring them on one conversation beats measuring them on two.
  counterfactual(text = '') {
    return this._compressor.counterfactual({
      messages: this._messages,
      systemPrompt: this._config.systemPrompt,
      next: text,
      model: this._config.model,
      maxTokens: this._config.maxTokens,
    });
  }

  ready() {
    return this._transport.ready();
  }

  _emit(type, detail) {
    this._seq += 1;
    this._onEvent({ seq: this._seq, at: Date.now(), turn: this._turn, type, ...detail });
  }

  _coerce(key, value) {
    const field = AGENT_SCHEMA.find((entry) => entry.key === key);
    if (!field) return value;

    if (field.type === 'toggle') return Boolean(value);

    if (field.type === 'number' || field.type === 'range') {
      let number = Number(value);
      if (!Number.isFinite(number)) number = field.default;
      if (field.min != null) number = Math.max(field.min, number);
      if (field.max != null) number = Math.min(field.max, number);
      if (field.step >= 1) number = Math.round(number);
      return number;
    }

    if (field.type === 'select') {
      return field.options.includes(value) ? value : field.default;
    }

    const text = String(value == null ? '' : value);
    return text.trim() ? text : field.default;
  }

  /* The only door into the configuration. Validates, clamps, logs what actually
   * changed, and hands back the snapshot the panel should re-render from. */
  configure(patch = {}) {
    const changed = [];
    for (const [key, raw] of Object.entries(patch)) {
      if (!(key in this._config)) continue;
      const value = this._coerce(key, raw);
      if (value === this._config[key]) continue;
      changed.push({ field: key, from: this._config[key], to: value });
      this._config[key] = value;
    }
    if (changed.length) {
      this._syncCompressor();
      this._emit('configure', { changed });
    }
    return this.config;
  }

  reset() {
    const forgotten = this._messages.length;
    const generations = this._compressor.generation;
    this._messages = [];
    this._turn = 0;
    this._ledger.clear();
    // The summary is part of the conversation, so it goes when the
    // conversation goes. A summary that outlived its messages would be a
    // description of something that no longer exists, sitting in the system
    // slot of every request in a conversation it never saw.
    this._compressor.reset();
    this._stats = {
      turns: 0,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cost: 0,
      elapsed: 0,
      folds: 0,
      foldFailures: 0,
      foldTokens: 0,
      foldCost: 0,
      foldElapsed: 0,
      wouldHaveSent: 0,
      actuallySent: 0,
    };
    this._emit('reset', { forgotten, generations });
  }

  // The only doors into memory. app.js may open them; it may not climb through
  // a window, and _messages stays private on the other side of both.

  snapshot() {
    return Object.freeze({
      messages: this._messages.map((message) => Object.freeze({ ...message })),
      // The compressed half. Stored beside the messages, never inside them:
      // restoring a conversation without its summary would silently re-expand
      // it to full price, and restoring a summary without its cut point would
      // send the folded messages twice.
      memory: this._compressor.snapshot(),
      config: { ...this._config },
      transport: this._transport.id,
    });
  }

  restore(snapshot) {
    if (this._busy) throw new Error('The agent is mid-turn — nothing was restored.');
    if (!snapshot || !Array.isArray(snapshot.messages)) {
      throw new Error('That is not a snapshot.');
    }

    const messages = snapshot.messages
      .filter((message) => message
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string')
      .map((message) => ({
        role: message.role,
        content: message.content,
        at: Number.isFinite(message.at) ? message.at : null,
      }));

    const replaced = this._messages.length;
    this._messages = messages;

    /* A restored summary is only meaningful against the messages it was made
     * from, so the cut point is clamped to what actually came back. A snapshot
     * with no memory — every task 8 record, and every conversation that has
     * never been folded — restores as "nothing folded yet", which is true. */
    this._compressor.reset();
    if (snapshot.memory) {
      this._compressor.restore({
        ...snapshot.memory,
        folded: Math.min(Number(snapshot.memory.folded) || 0, messages.length),
      });
    }

    // Stats and the turn counter are pointedly left alone. They measure this
    // run, and this run has just started; the conversation has not.
    this._emit('agent:restored', {
      messages: messages.length,
      replaced,
      generations: this._compressor.generation,
      folded: this._compressor.snapshot().folded,
      savedAt: snapshot.savedAt || null,
      heldUnder: snapshot.config
        ? { model: snapshot.config.model, name: snapshot.config.name, transport: snapshot.transport }
        : null,
    });

    return this.history;
  }

  _planFor(kept, text) {
    return this._counter.plan({
      model: this._config.model,
      systemPrompt: this._config.systemPrompt,
      history: kept,
      next: text,
      maxTokens: this._config.maxTokens,
    });
  }

  /* Everything that decides what goes up the wire happens here, and all of it
   * is arithmetic done before a byte is sent.
   *
   * Two questions in order, and task 8 ran them together. The first is the
   * standing one — how much of the past does this agent carry at all — and the
   * memory policy answers it. The second only comes up when the first answer
   * still does not fit, and the overflow policy answers that one. Folding
   * happens before either, in send(), because it needs the network. */
  _assemble(text) {
    const model = this._config.model;
    const selection = this._compressor.select(this._messages);
    const summary = selection.summary;
    // The summary is held out of everything that slices below. It is the
    // densest thing in the payload — hundreds of messages for the price of one
    // — so trimming it to make room would be the worst available trade, and
    // trimming it by accident, which is what slicing a combined array does,
    // would silently undo the fold that produced it.
    let kept = selection.verbatim.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const held = this._messages.length;
    const reasons = [];
    const withSummary = (list) => (summary
      ? [{ role: 'system', content: summary.text }, ...list]
      : list);

    // A cap of the caller's own goes first. It is a preference; the window is
    // a fact, and preferences are applied before facts get a say.
    const cap = this._config.historyBudget;
    if (cap > 0) {
      const fit = this._counter.fit(kept, model, cap);
      if (fit.dropped > 0) {
        kept = kept.slice(fit.from);
        reasons.push('history cap');
      }
    }

    let plan = this._planFor(withSummary(kept), text);

    if (plan.overflow) {
      const policy = this._config.overflowPolicy;
      // Room left for the past once the fixed costs are paid. The summary is a
      // fixed cost now: it has already been written and paid for, and the
      // alternative to carrying it is not carrying less, it is forgetting.
      const summaryTokens = summary
        ? this._counter.countMessage({ content: summary.text }, model)
        : 0;
      const room = plan.limit - plan.reserved - plan.system - plan.next
        - plan.priming - summaryTokens;

      this._emit('tokens:overflow', {
        policy,
        memoryPolicy: this._config.memoryPolicy,
        prompt: plan.prompt,
        reserved: plan.reserved,
        total: plan.total,
        limit: plan.limit,
        over: plan.overflowBy,
        roomForHistory: room,
        summaryTokens,
        held,
      });

      if (policy === 'refuse') throw new ContextOverflowError(plan);

      if (policy === 'trim') {
        // Nothing to trim: the system prompt, this message, the summary and the
        // reserved reply already exceed the window. Dropping verbatim history
        // cannot save this one, so say so rather than sending a request that
        // must fail.
        if (room <= 0) throw new ContextOverflowError(plan);
        const fit = this._counter.fit(kept, model, room);
        kept = kept.slice(fit.from);
        reasons.push('context window');
        plan = this._planFor(withSummary(kept), text);
      }
      // 'send' falls through on purpose: the endpoint gets to be the one that
      // refuses, which is the only way to see what that actually looks like.
    }

    /* Two ways for a message not to be in this request, and they are not the
     * same event. One of them is recoverable — the text is still in memory and
     * a summary of it is going up the wire — and one of them is the model
     * losing the start of the conversation for good. */
    const sent = kept.length;
    const summarised = selection.folded;
    const dropped = held - sent - summarised;

    if (dropped > 0) {
      this._emit('memory:trim', {
        dropped,
        because: reasons.length ? reasons.join(' then ') : this._config.memoryPolicy,
        droppedPreview: this._messages.slice(summarised, summarised + dropped)
          .map((message) => ({
            role: message.role,
            preview: message.content.slice(0, 60),
          })),
        kept: sent,
        recoverable: false,
        estimatedTokens: plan.history,
        budget: cap || plan.limit,
      });
    }

    this._emit('tokens:preflight', {
      model: plan.model,
      system: plan.system,
      history: plan.history,
      next: plan.next,
      priming: plan.priming,
      prompt: plan.prompt,
      reserved: plan.reserved,
      total: plan.total,
      limit: plan.limit,
      headroom: plan.headroom,
      fraction: plan.fraction,
      overflow: plan.overflow,
      messages: sent,
      summarised,
      dropped,
      memoryPolicy: this._config.memoryPolicy,
      generation: summary ? summary.generation : 0,
      worstCaseCost: plan.worstCaseCost,
      calibration: this._counter.status(plan.model),
    });

    /* The payload. The summary goes in as a *system* message, never as a
     * fabricated user or assistant turn: it is not something anybody said, so
     * giving it a speaker would be a lie the model then reasons from. */
    const wire = this._compressor.wire({
      messages: this._messages,
      systemPrompt: this._config.systemPrompt,
      next: text,
    });
    // The compressor does not know about the history cap or the overflow trim,
    // so when either of them cut something, the payload is rebuilt from what
    // actually survived rather than from what the policy would have sent.
    const messages = (dropped > 0)
      ? [
        { role: 'system', content: this._config.systemPrompt },
        ...withSummary(kept).map((message) => (message.role === 'system'
          ? {
            role: 'system',
            content: `Earlier in this conversation (compressed, generation `
              + `${summary.generation}):\n${summary.text}`,
          }
          : message)),
        { role: 'user', content: text },
      ]
      : wire.messages;

    return { messages, plan, selection, summarised, dropped };
  }

  // Everything that happens to a turn once the transport has answered: the
  // estimator is marked, the ledger gets a row, the stats move, and the reply
  // is logged. `counted` is false when the turn produced no answer — the money
  // still counts, the turn does not.
  _settle(plan, result, { counted }) {
    const usage = result.usage || {};
    const learned = this._counter.observe(this._config.model, plan.prompt, result.usage);

    const entry = this._ledger.record({
      turn: this._turn,
      at: Date.now(),
      model: this._config.model,
      estimatedPrompt: plan.prompt,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedTokens: usage.cacheHitTokens,
      cost: result.cost,
      historyLength: this._messages.length,
      dropped: plan.messages != null
        ? Math.max(0, this._messages.length - plan.messages)
        : 0,
      finishReason: result.finishReason,
      windowFraction: plan.limit
        ? ((usage.promptTokens || plan.prompt) + (usage.completionTokens || 0)) / plan.limit
        : 0,
    });

    this._emit('tokens:settled', {
      estimated: plan.prompt,
      actual: usage.promptTokens || 0,
      drift: entry.drift,
      completion: usage.completionTokens || 0,
      billed: entry.billed,
      cost: result.cost,
      cumulativeTokens: entry.cumulativeTokens,
      cumulativeCost: entry.cumulativeCost,
      calibration: learned ? this._counter.status(this._config.model) : null,
    });

    if (result.finishReason === 'length') {
      this._emit('tokens:truncated', {
        ceiling: this._config.maxTokens,
        wrote: usage.completionTokens || 0,
        characters: result.text.length,
      });
    }

    if (counted) this._stats.turns += 1;
    this._stats.promptTokens += usage.promptTokens || 0;
    this._stats.completionTokens += usage.completionTokens || 0;
    this._stats.reasoningTokens += usage.reasoningTokens || 0;
    this._stats.cacheHitTokens += usage.cacheHitTokens || 0;
    if (typeof result.cost === 'number') this._stats.cost += result.cost;
    this._stats.elapsed += result.elapsed || 0;

    /* The reply itself goes into the log too, so an exported log is a
     * complete record of the session rather than half of one. */
    this._emit('response', {
      finishReason: result.finishReason,
      usage: result.usage,
      cost: result.cost,
      ttft: result.ttft,
      elapsed: result.elapsed,
      characters: result.text.length,
      text: result.text,
      reasoning: result.reasoning || '',
    });

    return entry;
  }

  /* Writing a summary is a request. It has a model, a prompt, a ceiling and a
   * bill, and pretending otherwise is how a technique that saves tokens gets
   * demonstrated without anyone counting the tokens it spends.
   *
   * It is deliberately the plainest request this agent ever makes: temperature
   * zero because a summary is not a creative act, no streaming because nobody
   * is reading it, and thinking off because reasoning would be billed at output
   * rates out of the same ceiling the summary itself has to fit in. */
  async _summarise(source, { system, budget, generation }) {
    const model = this._config.summaryModel;
    const started = Date.now();

    this._emit('memory:summarise', {
      generation,
      model,
      budget,
      sourceCharacters: source.length,
      estimatedPrompt: this._counter.estimate(`${system}\n${source}`, model),
    });

    const result = await this._transport.send({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: source },
      ],
      temperature: 0,
      maxTokens: budget,
      stream: false,
      thinking: 'off',
      signal: null,
      onChunk: null,
    });

    const usage = result.usage || {};
    this._stats.foldElapsed += (Date.now() - started) / 1000;
    this._stats.foldTokens += (usage.promptTokens || 0) + (usage.completionTokens || 0);
    if (typeof result.cost === 'number') {
      this._stats.foldCost += result.cost;
      // Into the headline total as well. It is kept in its own column so a fold
      // is never mistaken for an expensive answer, and added here anyway
      // because the money left the account either way.
      this._stats.cost += result.cost;
    }

    return result;
  }

  /* Does the past need folding before this turn goes out, and if so, do it.
   *
   * Two triggers. The schedule is the ordinary one — enough messages have piled
   * up beyond the verbatim window. Pressure is the other: the request does not
   * fit, and folding early beats refusing on principle.
   *
   * A fold that fails is not a turn that fails. The conversation is untouched,
   * the turn proceeds uncompressed and more expensively, and the log says so.
   * The alternative — losing messages because a summariser timed out — is not a
   * trade-off, it is data loss. */
  async _maybeFold(text) {
    if (this._config.memoryPolicy !== 'compress') return null;

    let due = this._compressor.due(this._messages);
    if (!due.due) {
      if (!due.count) return null;
      // Nothing owed on schedule. Ask the cheaper question — would this request
      // fit as things stand? — and only fold early if the answer is no.
      const probe = this.plan(text);
      if (!probe.overflow) return null;
      due = this._compressor.due(this._messages, { pressure: true });
      if (!due.due) return null;
    }

    const source = this._compressor.foldSource(this._messages);
    if (!source) return null;

    this._emit('memory:fold', {
      reason: due.reason,
      messages: source.slice.length,
      from: source.from,
      to: source.to,
      previousGeneration: source.previous ? source.previous.generation : 0,
      preview: source.slice.slice(0, 3).map((message) => ({
        role: message.role,
        preview: message.content.slice(0, 60),
      })),
    });

    try {
      const entry = await this._compressor.fold(this._messages, {
        model: this._config.model,
        reason: due.reason,
        summarise: (sourceText, options) => this._summarise(sourceText, options),
      });
      if (!entry) return null;

      this._stats.folds += 1;
      this._emit('memory:summary', {
        generation: entry.generation,
        reason: entry.reason,
        text: entry.text,
        tokens: entry.tokens,
        foldedMessages: entry.foldedMessages,
        foldedTokens: entry.foldedTokens,
        savedPerTurn: entry.savedPerTurn,
        spentTokens: entry.spentTokens,
        spentCost: entry.spentCost,
        truncated: entry.truncated,
        breakEvenTurns: entry.savedPerTurn > 0
          ? Math.ceil(entry.spentTokens / entry.savedPerTurn)
          : null,
      });
      return entry;
    } catch (error) {
      this._stats.foldFailures += 1;
      // Deliberately not rethrown. The question was "can this be cheaper", the
      // answer came back "not right now", and that is not a reason to refuse to
      // answer the person who is waiting.
      this._emit('memory:fold-failed', {
        reason: due.reason,
        message: error.message,
        messagesAtRisk: source.slice.length,
        kept: true,
      });
      return null;
    }
  }

  async _attempt(messages, { onChunk, signal }) {
    const { model, temperature, maxTokens, stream, retries, thinking } = this._config;
    let attempt = 0;

    for (;;) {
      try {
        return await this._transport.send({
          model,
          messages,
          temperature,
          maxTokens,
          stream,
          thinking,
          signal,
          onChunk,
        });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (!error.retryable || attempt >= retries) throw error;

        const delay = RETRY_BASE_MS * 2 ** attempt;
        attempt += 1;
        this._emit('retry', {
          attempt,
          of: retries,
          status: error.status,
          reason: error.message,
          delayMs: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async send(text, { onChunk, signal } = {}) {
    const content = String(text || '').trim();
    if (!content) throw new Error('Nothing to send.');
    if (this._busy) throw new Error('The agent is already working on a turn.');

    const blocked = this._transport.ready();
    if (blocked) throw new Error(blocked);

    for (const key of ['model', 'summaryModel']) {
      const name = this._config[key];
      const facts = MODELS[name];
      if (facts && facts.stub && this._transport.id !== 'echo') {
        throw new Error(
          `${name} is not a real model — it is a small window kept for the `
          + 'offline transport. The API would refuse it. Switch model, or switch transport.'
        );
      }
      // The summariser only matters when something might be summarised.
      if (this._config.memoryPolicy !== 'compress') break;
    }

    this._busy = true;
    this._turn += 1;
    const started = Date.now();
    this._emit('turn:start', { text: content, historyLength: this._messages.length });

    // No listener, no wrapper: a transport that is handed a callback has to
    // behave as though someone is reading, and pacing a stream nobody reads is
    // how a twenty-turn measurement becomes a twenty-second one.
    let first = true;
    const wrapped = onChunk
      ? (chunk, kind) => {
        if (first) {
          first = false;
          this._emit('first-token', { afterMs: Date.now() - started, kind: kind || 'content' });
        }
        onChunk(chunk, kind || 'content');
      }
      : null;

    try {
      // Assembly counts, and counting can refuse. It belongs inside the try so
      // that a turn stopped by arithmetic ends the same way a turn stopped by
      // the network does — logged, counted as failed, and with the agent free
      // to take the next one.
      /* Before anything is counted, the past gets its chance to become
       * smaller. This is the one place in the agent where a turn makes two
       * requests, and it happens here — before the preflight — so that the
       * meter, the ledger and the refusal all see the conversation as it will
       * actually be sent rather than as it was a moment ago. */
      await this._maybeFold(content);

      // What `full` would have sent, against what is actually going out. Two
      // numbers on one conversation, which is the only comparison that is not
      // really a comparison of two different conversations.
      const versus = this.counterfactual(content);
      this._stats.wouldHaveSent += versus.full;
      this._stats.actuallySent += versus.actual;

      const { messages, plan, selection, summarised, dropped } = this._assemble(content);
      this._emit('memory:sent', {
        policy: this._config.memoryPolicy,
        generation: selection.summary ? selection.summary.generation : 0,
        held: this._messages.length,
        sentVerbatim: selection.verbatim.length - dropped,
        summarised,
        dropped,
        pending: selection.pending,
        wouldHaveSent: versus.full,
        actuallySent: versus.actual,
        saved: versus.saved,
        ratio: versus.ratio,
      });
      this._emit('request', {
        transport: this._transport.id,
        endpoint: this._transport.endpoint,
        headers: this._transport.displayHeaders(),
        body: {
          model: this._config.model,
          temperature: this._config.temperature,
          max_tokens: this._config.maxTokens,
          stream: this._config.stream,
          ...(this._config.thinking === 'off'
            ? { thinking: { type: 'disabled' } }
            : { thinking: { type: 'enabled' }, reasoning_effort: this._config.thinking }),
          messages,
        },
      });

      const result = await this._attempt(messages, { onChunk: wrapped, signal });
      const usage = result.usage || {};
      const answered = Boolean(String(result.text || '').trim());

      // Settle first. The tokens were spent whether or not an answer came back,
      // and an accounting that only runs on the happy path is not an accounting.
      this._settle(plan, result, { counted: answered });

      if (!answered) {
        this._emit('tokens:starved', {
          ceiling: this._config.maxTokens,
          finishReason: result.finishReason,
          completion: usage.completionTokens || 0,
          reasoning: usage.reasoningTokens || 0,
          cost: result.cost,
          reasoningCharacters: (result.reasoning || '').length,
        });
        // Not remembered, for the same reason a 402 is not remembered: an
        // assistant message with no content is a message that costs framing
        // tokens on every future turn and carries nothing back.
        throw new EmptyReplyError({
          ceiling: this._config.maxTokens,
          usage,
          finishReason: result.finishReason,
        });
      }

      this._messages.push({ role: 'user', content, at: started });
      this._messages.push({ role: 'assistant', content: result.text, at: Date.now() });

      this._emit('turn:end', {
        ok: true,
        historyLength: this._messages.length,
        totalMs: Date.now() - started,
      });

      return { reply: result.text, sentMessages: messages, ...result };
    } catch (error) {
      const aborted = error.name === 'AbortError';
      if (!aborted) this._stats.failed += 1;
      /* A failed turn is not remembered — the history stays clean so the same
       * question can simply be asked again. */
      this._emit(aborted ? 'aborted' : 'error', {
        message: error.message,
        status: error.status || null,
        code: error.code || null,
      });
      this._emit('turn:end', {
        ok: false,
        historyLength: this._messages.length,
        totalMs: Date.now() - started,
      });
      throw error;
    } finally {
      this._busy = false;
    }
  }
}
