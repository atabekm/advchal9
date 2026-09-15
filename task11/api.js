/* The transport.
 *
 * One provider, one way out. It knows the wire format and the API key; it
 * knows nothing about layers, tasks or routing, and the agent never looks
 * inside it.
 *
 * Task 10 shipped an offline stub beside this and every number in its README
 * was reproducible without a key. That is gone, deliberately: this task's
 * subject is what a model proposes to remember and where the rules put it, and
 * a stub proposing candidates by regular expression would be measuring the
 * regular expression. The cost is that nothing here runs without a key, and
 * the app says so in the one place it matters rather than failing at the first
 * fetch.
 *
 * Two entry points, because this agent makes two calls per turn:
 *
 *   transport.send(...)   the reply, streamed
 *   transport.json(...)   the extraction, not streamed, cold
 *
 * They are separate methods rather than a flag because they want different
 * settings and different failure handling. A failed reply is the turn failing.
 * A failed extraction is a turn that happened and was not remembered, which is
 * a smaller thing and must never be allowed to become the larger one.
 */

const API_URL = 'https://api.deepseek.com/chat/completions';
const KEY_STORAGE = 'task11.deepseek.key';

/* USD per 1M tokens, from https://api-docs.deepseek.com/quick_start/pricing
 * Off-peak is half of peak; peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
const MODELS = {
  'deepseek-flash': {
    context: 1000000,
    maxOutput: 384000,
    price: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  },
  'deepseek-v4-pro': {
    context: 1000000,
    maxOutput: 384000,
    price: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const HTTP_HINTS = {
  400: 'Bad request — the payload was rejected.',
  401: 'Invalid API key. Paste a key from platform.deepseek.com/api_keys',
  402: 'Insufficient balance. Top up at platform.deepseek.com',
  422: 'Invalid parameters in the request.',
  429: 'Rate limited. The agent will back off and retry.',
  500: 'DeepSeek server error.',
  503: 'DeepSeek is overloaded.',
};

class TransportError extends Error {
  constructor(message, { status = null, retryable = false, code = null } = {}) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

// A 400 that says the request did not fit is a different animal from a 400
// that says the payload was malformed: one is arithmetic the caller can redo,
// the other is a bug. The wire does not always label it, so we do.
const OVERFLOW_PATTERN = /context length|context_length|maximum context|too many tokens|too long/i;

function overflowCode(status, message) {
  return status === 400 && OVERFLOW_PATTERN.test(message || '') ? 'context_length_exceeded' : null;
}

function getKey() {
  try {
    return (localStorage.getItem(KEY_STORAGE) || '').trim();
  } catch (error) {
    return '';
  }
}

function setKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch (error) {
    /* private mode, or storage disabled — the field still works for this page */
  }
}

function readUsage(block) {
  if (!block) return null;
  const details = block.prompt_tokens_details || {};
  const hit = block.prompt_cache_hit_tokens != null
    ? block.prompt_cache_hit_tokens
    : details.cached_tokens;
  const completion = block.completion_tokens_details || {};
  return {
    promptTokens: block.prompt_tokens || 0,
    completionTokens: block.completion_tokens || 0,
    reasoningTokens: completion.reasoning_tokens || 0,
    totalTokens: block.total_tokens || 0,
    cacheHitTokens: hit || 0,
    cacheMissTokens: block.prompt_cache_miss_tokens != null
      ? block.prompt_cache_miss_tokens
      : Math.max(0, (block.prompt_tokens || 0) - (hit || 0)),
  };
}

function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

// Cost from a usage block. Exact, because usage is what the provider actually
// charged for — no estimate involved. The panel needs this per call rather
// than per turn, because the whole point of showing it is that a turn is two.
function costOf(model, usage) {
  const facts = MODELS[model];
  if (!facts || !usage) return null;
  const { price } = facts;
  const scale = isPeak() ? 1 : 0.5;
  const hit = usage.cacheHitTokens || 0;
  const miss = usage.cacheMissTokens != null
    ? usage.cacheMissTokens
    : Math.max(0, (usage.promptTokens || 0) - hit);
  return (
    (hit * price.cacheHit + miss * price.cacheMiss + (usage.completionTokens || 0) * price.output)
    * scale / 1e6
  );
}

async function explain(response) {
  let detail = '';
  try {
    const body = await response.json();
    const error = body.error;
    detail = (error && (error.message || error)) || '';
  } catch (error) {
    detail = '';
  }
  const hint = HTTP_HINTS[response.status] || `HTTP ${response.status}`;
  return `${hint} ${typeof detail === 'string' ? detail : ''}`.trim();
}

async function readWhole(response, started, onChunk) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new TransportError('Unexpected response shape from DeepSeek.', { retryable: false });
  }
  const choice = (body.choices && body.choices[0]) || {};
  const message = choice.message || {};
  const text = message.content || '';
  const reasoning = message.reasoning_content || '';
  if (reasoning && onChunk) onChunk(reasoning, 'reasoning');
  if (text && onChunk) onChunk(text, 'content');
  return {
    text,
    reasoning,
    finishReason: choice.finish_reason || null,
    usage: readUsage(body.usage),
    ttft: (performance.now() - started) / 1000,
  };
}

async function readStream(response, started, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let ttft = null;
  let usage = null;
  let finishReason = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        continue;
      }

      if (parsed.usage) usage = parsed.usage;
      const choice = (parsed.choices && parsed.choices[0]) || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      /* Reasoning models emit their scratchpad first. It is billed as output
       * and it is what the wait before the answer actually is, so it counts
       * towards time-to-first-token and is shown rather than dropped. */
      if (delta.reasoning_content) {
        if (ttft === null) ttft = (performance.now() - started) / 1000;
        reasoning += delta.reasoning_content;
        if (onChunk) onChunk(delta.reasoning_content, 'reasoning');
      }
      if (delta.content) {
        if (ttft === null) ttft = (performance.now() - started) / 1000;
        text += delta.content;
        if (onChunk) onChunk(delta.content, 'content');
      }
    }
  }

  return { text, reasoning, finishReason, usage: readUsage(usage), ttft };
}

async function post(payload, { signal }) {
  const key = getKey();
  if (!key) throw new TransportError('No API key.', { retryable: false, code: 'no_key' });

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new TransportError(
      'Could not reach api.deepseek.com. Check your connection.',
      { retryable: true }
    );
  }

  if (!response.ok) {
    const detail = await explain(response);
    throw new TransportError(detail, {
      status: response.status,
      retryable: RETRYABLE.has(response.status),
      code: overflowCode(response.status, detail),
    });
  }

  return response;
}

const deepseekTransport = {
  id: 'deepseek',
  label: 'DeepSeek (live HTTP)',
  endpoint: API_URL,
  models: Object.keys(MODELS),

  displayHeaders() {
    const key = getKey();
    const shown = key ? `Bearer ${key.slice(0, 6)}…${'*'.repeat(8)}` : 'Bearer «no key set»';
    return { Authorization: shown, 'Content-Type': 'application/json' };
  },

  ready() {
    return getKey() ? '' : 'No API key. Paste one into the field above — the memory panel '
      + 'still works without it, but nothing can be said to the model.';
  },

  async send({ model, messages, temperature, maxTokens, stream = true, thinking = 'off', signal, onChunk }) {
    const started = performance.now();
    const payload = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(stream),
    };
    if (stream) payload.stream_options = { include_usage: true };
    // Thinking is on by default on this API, at high effort, so omitting the
    // parameter is not the same as declining it — silence buys the most
    // expensive setting there is. Off has to be said out loud.
    if (thinking === 'off') payload.thinking = { type: 'disabled' };
    else {
      payload.thinking = { type: 'enabled' };
      payload.reasoning_effort = thinking;
    }

    const response = await post(payload, { signal });
    const result = stream
      ? await readStream(response, started, onChunk)
      : await readWhole(response, started, onChunk);
    result.elapsed = (performance.now() - started) / 1000;
    result.cost = costOf(model, result.usage);
    result.call = 'reply';
    return result;
  },

  /* The extraction call.
   *
   * Not streamed, because nobody is reading it and a JSON object arriving one
   * token at a time is just a slower JSON object. Temperature zero, thinking
   * off, and `response_format: json_object` because this is the one request in
   * the app where creativity is a defect — everything it may say is already in
   * the message it is quoting.
   */
  async json({ model, messages, maxTokens = 600, signal }) {
    const started = performance.now();
    const response = await post({
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    }, { signal });

    const result = await readWhole(response, started, null);
    result.elapsed = (performance.now() - started) / 1000;
    result.cost = costOf(model, result.usage);
    result.call = 'extraction';
    return result;
  },
};
