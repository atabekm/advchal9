/* The transport.
 *
 * One provider, one way out. It knows the wire format and the API key; it
 * knows nothing about profiles, blocks or checkers, and nothing above it looks
 * inside.
 *
 * Slimmed from task 11, which needed two entry points because a turn there was
 * two requests — a reply and an extraction. A turn here is one request. The
 * profile block is the only thing this task adds to it, and adding a second
 * call to decide what to remember would be building task 11 again.
 *
 * There is no offline stub, for the same reason task 11 had none: the subject
 * is whether a model obeys an instruction, and a stub written to obey the
 * checkers would be measuring the checkers. Everything that can be proved
 * without a key is in test.js instead, and the app says so where it matters.
 */

const API_URL = 'https://api.deepseek.com/chat/completions';
const KEY_STORAGE = 'task13.deepseek.key';

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
  429: 'Rate limited.',
  500: 'DeepSeek server error.',
  503: 'DeepSeek is overloaded.',
};

class TransportError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
    this.retryable = retryable;
  }
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
  return {
    promptTokens: block.prompt_tokens || 0,
    completionTokens: block.completion_tokens || 0,
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

/* Cost from a usage block — exact, because usage is what the provider actually
 * charged for. A grid run is about twenty requests and an ablation another
 * twelve, and a comparison nobody has priced is a comparison somebody will run
 * once and then be afraid of. */
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

async function readWhole(response, started) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new TransportError('Unexpected response shape from DeepSeek.');
  }
  const choice = (body.choices && body.choices[0]) || {};
  const message = choice.message || {};
  return {
    text: message.content || '',
    finishReason: choice.finish_reason || null,
    usage: readUsage(body.usage),
  };
}

async function readStream(response, started, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
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
      if (delta.content) {
        text += delta.content;
        if (onChunk) onChunk(delta.content);
      }
    }
  }

  return { text, finishReason, usage: readUsage(usage) };
}

async function post(payload, { signal }) {
  const key = getKey();
  if (!key) throw new TransportError('No API key.');

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
    throw new TransportError('Could not reach api.deepseek.com. Check your connection.', { retryable: true });
  }

  if (!response.ok) {
    const detail = await explain(response);
    throw new TransportError(detail, {
      status: response.status,
      retryable: RETRYABLE.has(response.status),
    });
  }

  return response;
}

const Api = {
  endpoint: API_URL,
  models: Object.keys(MODELS),
  getKey,
  setKey,

  ready() {
    return getKey() ? '' : 'No API key. Paste one into the field above — the profile '
      + 'compiles and the checkers run without it, but nothing can be asked.';
  },

  /* Thinking is on by default on this API, at high effort, so omitting the
   * parameter is not the same as declining it — silence buys the most
   * expensive setting there is. Off has to be said out loud.
   *
   * Temperature is a parameter here and not a constant because the noise floor
   * depends on it: the repeat row of the grid measures how much the model
   * varies from itself, and that number means nothing unless you know what
   * temperature produced it. */
  async send({ model, messages, temperature = 0.7, maxTokens = 1400, stream = true, signal, onChunk }) {
    const started = Date.now();
    const payload = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(stream),
      thinking: { type: 'disabled' },
    };
    if (stream) payload.stream_options = { include_usage: true };

    const response = await post(payload, { signal });
    const result = stream
      ? await readStream(response, started, onChunk)
      : await readWhole(response, started);
    result.elapsed = (Date.now() - started) / 1000;
    result.cost = costOf(model, result.usage);
    return result;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Api;
