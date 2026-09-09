/* The agent.
 *
 * Everything the interface is not allowed to know lives here: the persona, the
 * conversation, the trimming rule, the payload shape, the retry policy, the
 * bookkeeping. `app.js` may call these methods and read these snapshots; it may
 * not reach in and set a field, and it never sees fetch, a status code or a
 * messages array it built itself.
 *
 *   agent.config              frozen snapshot of every constructor property
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
    default: 'deepseek-v4-flash',
    options: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    help: 'Pro costs about three times flash.',
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
    key: 'historyBudget',
    type: 'number',
    label: 'history budget',
    default: 1200,
    min: 0,
    max: 32000,
    step: 100,
    help: 'Approx tokens of past turns kept. 0 makes it stateless.',
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

/* Rough enough to budget with, and it never has to agree with the provider —
 * the real counts come back in the usage block and are shown next to it. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4) + 4;
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
    const { transport, onEvent, ...config } = options;
    if (!transport) throw new Error('Agent needs a transport.');

    this._transport = transport;
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
    };

    for (const [key, value] of Object.entries(config)) {
      if (key in this._config) this._config[key] = this._coerce(key, value);
    }

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
    if (changed.length) this._emit('configure', { changed });
    return this.config;
  }

  reset() {
    const forgotten = this._messages.length;
    this._messages = [];
    this._turn = 0;
    this._stats = {
      turns: 0,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cost: 0,
      elapsed: 0,
    };
    this._emit('reset', { forgotten });
  }

  // The only doors into memory. app.js may open them; it may not climb through
  // a window, and _messages stays private on the other side of both.

  snapshot() {
    return Object.freeze({
      messages: this._messages.map((message) => Object.freeze({ ...message })),
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

    // Stats and the turn counter are pointedly left alone. They measure this
    // run, and this run has just started; the conversation has not.
    this._emit('agent:restored', {
      messages: messages.length,
      replaced,
      savedAt: snapshot.savedAt || null,
      heldUnder: snapshot.config
        ? { model: snapshot.config.model, name: snapshot.config.name, transport: snapshot.transport }
        : null,
    });

    return this.history;
  }

  /* System prompt, then as much recent history as the budget allows, then the
   * new turn. Oldest exchanges fall off the front; the window always opens on a
   * user message so the model never sees a reply with nothing to reply to. */
  _assemble(text) {
    const budget = this._config.historyBudget;
    const kept = [];
    let used = 0;

    for (let index = this._messages.length - 1; index >= 0; index -= 1) {
      const cost = estimateTokens(this._messages[index].content);
      if (used + cost > budget) break;
      used += cost;
      kept.unshift(this._messages[index]);
    }
    while (kept.length && kept[0].role !== 'user') {
      used -= estimateTokens(kept[0].content);
      kept.shift();
    }

    const dropped = this._messages.length - kept.length;
    if (dropped > 0) {
      this._emit('memory:trim', {
        dropped,
        droppedPreview: this._messages.slice(0, dropped).map((message) => ({
          role: message.role,
          preview: message.content.slice(0, 60),
        })),
        kept: kept.length,
        estimatedTokens: used,
        budget,
      });
    }

    // Bare role and content on the way out. The `at` stamps exist for the store;
    // a field the API did not ask for has no business in the request body.
    return [
      { role: 'system', content: this._config.systemPrompt },
      ...kept.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: text },
    ];
  }

  async _attempt(messages, { onChunk, signal }) {
    const { model, temperature, maxTokens, stream, retries } = this._config;
    let attempt = 0;

    for (;;) {
      try {
        return await this._transport.send({
          model,
          messages,
          temperature,
          maxTokens,
          stream,
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

    this._busy = true;
    this._turn += 1;
    const started = Date.now();
    this._emit('turn:start', { text: content, historyLength: this._messages.length });

    const messages = this._assemble(content);
    this._emit('request', {
      transport: this._transport.id,
      endpoint: this._transport.endpoint,
      headers: this._transport.displayHeaders(),
      body: {
        model: this._config.model,
        temperature: this._config.temperature,
        max_tokens: this._config.maxTokens,
        stream: this._config.stream,
        messages,
      },
    });

    let first = true;
    const wrapped = (chunk, kind) => {
      if (first) {
        first = false;
        this._emit('first-token', { afterMs: Date.now() - started, kind: kind || 'content' });
      }
      if (onChunk) onChunk(chunk, kind || 'content');
    };

    try {
      const result = await this._attempt(messages, { onChunk: wrapped, signal });

      this._messages.push({ role: 'user', content, at: started });
      this._messages.push({ role: 'assistant', content: result.text, at: Date.now() });

      this._stats.turns += 1;
      if (result.usage) {
        this._stats.promptTokens += result.usage.promptTokens || 0;
        this._stats.completionTokens += result.usage.completionTokens || 0;
        this._stats.reasoningTokens += result.usage.reasoningTokens || 0;
        this._stats.cacheHitTokens += result.usage.cacheHitTokens || 0;
      }
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
