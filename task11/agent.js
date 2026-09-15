/* The agent.
 *
 * Everything the interface is not allowed to know: the persona, the assembly
 * order, the retry policy, and the fact that a turn here is two requests.
 *
 *   agent.config / .configure(patch)
 *   agent.memory / .router          the layers and the rules, for panels
 *   agent.assemble(text)            what would go up the wire, without sending
 *   await agent.send(text, opts)    the reply
 *   await agent.remember(turn)      the second request, and the routing
 *   agent.openTask(goal) / .closeTask()
 *   agent.stats / .turns
 *   Agent.schema                    the descriptors the config panel is built from
 *
 * `send` and `remember` are separate on purpose. Speaking and remembering what
 * was said are two different requests with two different failure modes, and
 * collapsing them into one method would make a failed extraction look like a
 * failed turn. The reply is the thing the user is waiting for; the memory
 * arrives a second later and, if it does not arrive at all, the conversation
 * carries on with a note in the panel saying what was not stored.
 */

const AGENT_SCHEMA = [
  {
    key: 'name',
    type: 'text',
    label: 'name',
    default: 'Mnemo',
    help: 'Shown on every reply.',
  },
  {
    key: 'model',
    type: 'select',
    label: 'model',
    default: 'deepseek-flash',
    options: ['deepseek-flash', 'deepseek-v4-pro'],
    help: 'Both calls in a turn use it — the reply and the extraction.',
  },
  {
    key: 'systemPrompt',
    type: 'textarea',
    label: 'system prompt',
    default: 'You are Mnemo, a precise and concise assistant with an explicit memory. '
      + 'Answer in at most three short paragraphs. '
      + 'Anything given to you under a "About the person" or "The task at hand" heading '
      + 'is your own memory of earlier conversations, not something said just now — '
      + 'use it, and say where it came from if you are asked.',
    help: 'Prepended to every request, in front of the memory blocks.',
  },
  {
    key: 'thinking',
    type: 'select',
    label: 'thinking',
    default: 'off',
    options: ['off', 'low', 'high', 'max'],
    help: 'Applies to the reply. The extraction call never thinks — it is quoting, not reasoning.',
  },
  {
    key: 'temperature',
    type: 'range',
    label: 'temperature',
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
    help: 'The reply only. Extraction runs at zero.',
  },
  {
    key: 'maxTokens',
    type: 'number',
    label: 'max tokens',
    default: 700,
    min: 16,
    max: 8192,
    step: 16,
    help: 'Hitting it shows as finish_reason: length.',
  },
  {
    key: 'extract',
    type: 'toggle',
    label: 'remember this turn',
    default: true,
    help: 'The second request. Off for small talk you do not want to pay to have considered.',
  },
  {
    key: 'useLong',
    type: 'toggle',
    label: 'send long-term',
    default: true,
    help: 'The profile and what was settled in earlier conversations.',
  },
  {
    key: 'useWorking',
    type: 'toggle',
    label: 'send working',
    default: true,
    help: 'The open task: its goal, constraints, questions and decisions.',
  },
  {
    key: 'useShort',
    type: 'toggle',
    label: 'send short-term',
    default: true,
    help: 'The last few messages. Off means every turn arrives alone.',
  },
  {
    key: 'keepTurns',
    type: 'number',
    label: 'keep turns',
    default: 6,
    min: 1,
    max: 40,
    step: 1,
    help: 'Message pairs held verbatim. Everything older is on screen and not in the request.',
  },
  {
    key: 'longBudget',
    type: 'number',
    label: 'long-term budget',
    default: 160,
    min: 0,
    max: 2000,
    step: 16,
    help: 'Tokens the long-term block may occupy. It says inside itself when it truncates.',
  },
  {
    key: 'workingBudget',
    type: 'number',
    label: 'working budget',
    default: 224,
    min: 0,
    max: 2000,
    step: 16,
    help: 'Same, for the task block.',
  },
];

const AGENT_DEFAULTS = Object.fromEntries(AGENT_SCHEMA.map((field) => [field.key, field.default]));

// Which config keys are really the memory's, and have to be handed on to it.
const MEMORY_KEYS = ['keepTurns', 'longBudget', 'workingBudget'];

class EmptyReplyError extends Error {
  constructor(finishReason) {
    super(finishReason === 'length'
      ? 'The reply hit the token ceiling before it said anything.'
      : 'The model returned an empty reply.');
    this.name = 'EmptyReplyError';
    this.finishReason = finishReason;
  }
}

class Agent {
  constructor({ transport = deepseekTransport, memory = null, onEvent = null, ...config } = {}) {
    this._transport = transport;
    this._config = { ...AGENT_DEFAULTS };
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.memory = memory || new Memory();
    this.router = new Router({ memory: this.memory, onEvent: this._onEvent });
    this._dialogueId = null;
    this._turns = [];
    this._busy = false;
    this.configure(config);
  }

  static get schema() { return AGENT_SCHEMA.map((field) => ({ ...field })); }
  static get defaults() { return { ...AGENT_DEFAULTS }; }

  get transport() { return this._transport; }
  get config() { return Object.freeze({ ...this._config }); }
  get busy() { return this._busy; }
  get turns() { return this._turns.slice(); }
  get dialogueId() { return this._dialogueId; }

  set dialogueId(id) { this._dialogueId = id || null; }

  get stats() {
    const sum = (pick) => this._turns.reduce((total, turn) => total + (pick(turn) || 0), 0);
    return Object.freeze({
      turns: this._turns.length,
      calls: sum((t) => (t.reply ? 1 : 0)) + sum((t) => (t.extraction ? 1 : 0)),
      promptTokens: sum((t) => (t.reply && t.reply.usage ? t.reply.usage.promptTokens : 0))
        + sum((t) => (t.extraction && t.extraction.usage ? t.extraction.usage.promptTokens : 0)),
      completionTokens: sum((t) => (t.reply && t.reply.usage ? t.reply.usage.completionTokens : 0))
        + sum((t) => (t.extraction && t.extraction.usage ? t.extraction.usage.completionTokens : 0)),
      replyCost: sum((t) => (t.reply ? t.reply.cost : 0)),
      extractionCost: sum((t) => (t.extraction ? t.extraction.cost : 0)),
      stored: sum((t) => (t.entries ? t.entries.filter((e) => e.layer).length : 0)),
      dropped: sum((t) => (t.entries ? t.entries.filter((e) => !e.layer).length : 0)),
    });
  }

  _coerce(key, value) {
    const field = AGENT_SCHEMA.find((entry) => entry.key === key);
    if (!field) return undefined;
    if (field.type === 'toggle') return Boolean(value);
    if (field.type === 'number' || field.type === 'range') {
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      return Math.min(field.max, Math.max(field.min, field.step >= 1 ? Math.round(number) : number));
    }
    if (field.type === 'select') {
      return field.options.includes(value) ? value : undefined;
    }
    return String(value);
  }

  configure(patch = {}) {
    const changed = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      const value = this._coerce(key, raw);
      if (value === undefined || value === this._config[key]) continue;
      this._config[key] = value;
      changed[key] = value;
    }
    const forMemory = Object.fromEntries(
      Object.entries(changed).filter(([key]) => MEMORY_KEYS.includes(key))
    );
    if (Object.keys(forMemory).length) this.memory.configure(forMemory);
    if (Object.keys(changed).length) this._onEvent('configure', changed);
    return this.config;
  }

  ready() {
    return this._transport.ready();
  }

  /* ------------------------------------------------------------ assembly */

  /* What goes up the wire, in order, with the layer each part came from.
   *
   * The order is not arbitrary. The persona first, because it is the frame
   * everything else is read inside. Then the person, because who is being
   * spoken to outranks what is being worked on. Then the task. Then, last and
   * closest to the reply, the things that were actually said — which is the
   * position a model weights most heavily, and short-term memory is the only
   * layer whose contents are guaranteed to be exactly what happened.
   *
   * Each block is a system message rather than a fabricated turn. Nobody said
   * it; it is a record *about* what was said, and giving it a speaker would put
   * words in the user's mouth that the user would then be told they had used.
   */
  assemble(next = '') {
    const { systemPrompt, useLong, useWorking, useShort } = this._config;
    const messages = [];
    const blocks = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
      blocks.push({ layer: 'persona', label: 'persona', text: systemPrompt, tokens: Memory.estimate(systemPrompt) });
    }

    const long = useLong ? this.memory.long.block(this._config.longBudget) : null;
    if (long && long.text) {
      messages.push({ role: 'system', content: long.text });
      blocks.push({ layer: 'long', label: 'long-term', ...long });
    }

    const working = useWorking ? this.memory.working.block(this._config.workingBudget) : null;
    if (working && working.text) {
      messages.push({ role: 'system', content: working.text });
      blocks.push({ layer: 'working', label: 'working', ...working });
    }

    const window = useShort ? this.memory.short.window() : [];
    for (const message of window) messages.push({ role: message.role, content: message.content });
    blocks.push({
      layer: 'short',
      label: 'short-term',
      text: window.map((m) => `${m.role}: ${m.content}`).join('\n'),
      tokens: window.reduce((sum, m) => sum + Memory.estimate(m.content), 0),
      shown: window.length,
      held: this.memory.short.length,
    });

    if (next) messages.push({ role: 'user', content: next });

    return {
      messages,
      blocks,
      tokens: blocks.reduce((sum, block) => sum + (block.tokens || 0), 0) + Memory.estimate(next),
    };
  }

  /* ---------------------------------------------------------------- tasks */

  openTask(goal) {
    const task = this.memory.working.open(goal);
    this._onEvent('task', { kind: 'open', task });
    return task;
  }

  /* Closing hands back what might outlive the task. It does not promote
   * anything — that is a decision, and decisions belong to whoever is reading
   * the panel. See router.promote. */
  closeTask() {
    const result = this.memory.working.close();
    this._onEvent('task', { kind: 'close', ...result });
    return result;
  }

  /* ----------------------------------------------------------- the turn */

  async _attempt(messages, { onChunk, signal }) {
    const { model, temperature, maxTokens, thinking } = this._config;
    let delay = 600;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this._transport.send({
          model, messages, temperature, maxTokens, thinking, stream: true, signal, onChunk,
        });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (!(error instanceof TransportError) || !error.retryable || attempt >= 3) throw error;
        this._onEvent('retry', { attempt, status: error.status, message: error.message });
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  /* The reply.
   *
   * Short-term memory is written only after the reply arrives. A user message
   * appended before the request would be sent twice — once as itself and once
   * inside the window — and a failed turn would leave a question in the
   * transcript that nothing ever answered.
   */
  async send(text, { onChunk, signal } = {}) {
    const said = String(text || '').trim();
    if (!said) throw new Error('Nothing to send.');
    if (this._busy) throw new Error('The agent is already busy.');

    const plan = this.assemble(said);
    this._busy = true;
    this._onEvent('request', { messages: plan.messages.length, tokens: plan.tokens, blocks: plan.blocks });

    try {
      const result = await this._attempt(plan.messages, { onChunk, signal });
      const reply = (result.text || '').trim();
      if (!reply) throw new EmptyReplyError(result.finishReason);

      this.memory.short.put({ role: 'user', content: said });
      this.memory.short.put({ role: 'assistant', content: reply });

      const turn = {
        at: Date.now(),
        index: this.memory.short.length - 2,
        user: said,
        assistant: reply,
        blocks: plan.blocks,
        reply: {
          usage: result.usage,
          cost: result.cost,
          elapsed: result.elapsed,
          ttft: result.ttft,
          finishReason: result.finishReason,
        },
        extraction: null,
        entries: null,
      };
      this._turns.push(turn);
      this._onEvent('reply', { turn });
      return turn;
    } finally {
      this._busy = false;
    }
  }

  /* The second request.
   *
   * It is allowed to fail. A turn that was said and not remembered is a turn
   * that happened; a turn that was remembered and not said never existed. So
   * every failure below returns a reason instead of throwing, and the reason
   * is shown in the panel beside the turn it belongs to — which is also the
   * only way anybody would ever notice that memory had quietly stopped.
   */
  async remember(turn, { signal } = {}) {
    if (!turn) return { skipped: 'no turn' };
    if (!this._config.extract) {
      const skipped = { skipped: 'remembering is switched off for this turn' };
      turn.extraction = skipped;
      return skipped;
    }

    const request = buildRequest({ turn: { user: turn.user, assistant: turn.assistant }, memory: this.memory });
    let result;
    try {
      result = await this._transport.json({
        model: this._config.model,
        messages: request.messages,
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const failed = { failed: error.message, status: error.status || null };
      turn.extraction = failed;
      this._onEvent('extract', { kind: 'failed', reason: error.message });
      return failed;
    }

    const parsed = parseCandidates(result.text);
    const entries = this.router.handle(parsed.candidates, {
      turn: { user: turn.user, assistant: turn.assistant },
      source: { dialogueId: this._dialogueId, index: turn.index, at: turn.at },
    });

    turn.extraction = {
      usage: result.usage,
      cost: result.cost,
      elapsed: result.elapsed,
      proposed: parsed.candidates.length,
      error: parsed.error,
      raw: result.text,
    };
    turn.entries = entries;
    this._onEvent('extract', {
      kind: 'done',
      proposed: parsed.candidates.length,
      written: entries.filter((entry) => entry.layer).length,
    });
    return { entries, extraction: turn.extraction };
  }

  /* --------------------------------------------------------- persistence */

  // Three snapshots, not one, for the reason layers.js gives: they are written
  // to three different keys with three different lifetimes, and a combined
  // snapshot would have to be taken apart again to do it.
  snapshot() {
    return {
      config: { ...this._config },
      memory: this.memory.snapshot(),
      log: this.router.log,
      turns: this._turns.slice(-40),
    };
  }

  restore(snapshot = {}) {
    if (snapshot.config) this.configure(snapshot.config);
    if (snapshot.memory) this.memory.restore(snapshot.memory);
    if (snapshot.log) this.router.restoreLog(snapshot.log);
    this._turns = Array.isArray(snapshot.turns) ? snapshot.turns.slice() : [];
  }

  // Start a new conversation. The task and the person are untouched, which is
  // the one-line statement of what this whole app is about.
  resetDialogue() {
    this.memory.resetDialogue();
    this.router.clearLog();
    this._turns = [];
    this._dialogueId = null;
    this._onEvent('reset', { kept: ['working', 'long'] });
  }
}
