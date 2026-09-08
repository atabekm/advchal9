/* Transports.
 *
 * A transport is the agent's one way out to the world. It knows the provider,
 * the wire format and the API key; it knows nothing about conversations,
 * personas or memory. The agent is handed one at construction and never looks
 * inside it, which is why swapping `deepseekTransport` for `echoTransport`
 * changes nothing above this file.
 *
 * Contract:
 *   transport.id, transport.label, transport.endpoint   for display
 *   transport.displayHeaders()                          redacted, safe to log
 *   transport.ready()                                   '' or a reason it cannot run
 *   await transport.send({ model, messages, temperature, maxTokens,
 *                          stream, signal, onChunk })
 *     -> { text, finishReason, usage, cost, elapsed, ttft }
 *   throws TransportError with .status and .retryable
 */

const API_URL = 'https://api.deepseek.com/chat/completions';
const KEY_STORAGE = 'task6.deepseek.key';

/* USD per 1M tokens, from https://api-docs.deepseek.com/quick_start/pricing
 * Off-peak is half of peak; peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
const PRICES = {
  'deepseek-v4-flash': { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  'deepseek-v4-flash-vision-exp': { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
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

function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function costOf(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return null;
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

const deepseekTransport = {
  id: 'deepseek',
  label: 'DeepSeek (live HTTP)',
  endpoint: API_URL,

  displayHeaders() {
    const key = getKey();
    const shown = key ? `Bearer ${key.slice(0, 6)}…${'*'.repeat(8)}` : 'Bearer «no key set»';
    return { Authorization: shown, 'Content-Type': 'application/json' };
  },

  ready() {
    return getKey() ? '' : 'No API key. Paste one into the key field above.';
  },

  async send({ model, messages, temperature, maxTokens, stream, signal, onChunk }) {
    const key = getKey();
    if (!key) throw new TransportError('No API key.', { retryable: false });

    const started = performance.now();
    const payload = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(stream),
    };
    if (stream) payload.stream_options = { include_usage: true };

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
      throw new TransportError(await explain(response), {
        status: response.status,
        retryable: RETRYABLE.has(response.status),
      });
    }

    const result = stream
      ? await readStream(response, started, onChunk)
      : await readWhole(response, started, onChunk);

    result.elapsed = (performance.now() - started) / 1000;
    result.cost = costOf(model, result.usage);
    return result;
  },
};

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
  const ttft = (performance.now() - started) / 1000;
  if (reasoning && onChunk) onChunk(reasoning, 'reasoning');
  if (text && onChunk) onChunk(text, 'content');
  return {
    text,
    reasoning,
    finishReason: choice.finish_reason || null,
    usage: readUsage(body.usage),
    ttft,
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

/* The offline stand-in. Same contract, no network, no key, no cost — it
 * reports back exactly what the agent handed it, which makes the memory and
 * the system prompt visible without spending anything. */
const echoTransport = {
  id: 'echo',
  label: 'echo (offline stub)',
  endpoint: 'local://echo',

  displayHeaders() {
    return { 'Content-Type': 'application/json' };
  },

  ready() {
    return '';
  },

  async send({ messages, temperature, maxTokens, signal, onChunk }) {
    const started = performance.now();
    const system = messages.find((message) => message.role === 'system');
    const turns = messages.filter((message) => message.role !== 'system');
    const last = turns[turns.length - 1];
    const priorUser = turns.filter((message) => message.role === 'user').length - 1;

    const reply = [
      `**echo transport** — no request left this machine.`,
      ``,
      `The agent handed me **${messages.length} messages**: `
        + `${system ? '1 system' : 'no system'}, `
        + `${priorUser} earlier user turn${priorUser === 1 ? '' : 's'}, `
        + `${turns.filter((message) => message.role === 'assistant').length} earlier repl`
        + `${turns.filter((message) => message.role === 'assistant').length === 1 ? 'y' : 'ies'}, `
        + `and the one you just sent.`,
      ``,
      `Its persona begins: *${system ? system.content.slice(0, 90).trim() : '(none)'}…*`,
      ``,
      `Sampling would have used temperature ${temperature} and a ${maxTokens}-token ceiling.`,
      ``,
      `> ${(last ? last.content : '').slice(0, 200)}`,
    ].join('\n');

    const pieces = reply.match(/\S+\s*/g) || [];
    let text = '';
    let ttft = null;

    for (const piece of pieces) {
      if (signal && signal.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 12));
      if (ttft === null) ttft = (performance.now() - started) / 1000;
      text += piece;
      if (onChunk) onChunk(piece, 'content');
    }

    const promptTokens = Math.round(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
    return {
      text,
      reasoning: '',
      finishReason: 'stop',
      usage: {
        promptTokens,
        completionTokens: Math.round(text.length / 4),
        reasoningTokens: 0,
        totalTokens: promptTokens + Math.round(text.length / 4),
        cacheHitTokens: 0,
        cacheMissTokens: promptTokens,
      },
      cost: 0,
      ttft,
      elapsed: (performance.now() - started) / 1000,
    };
  },
};

const TRANSPORTS = [deepseekTransport, echoTransport];
