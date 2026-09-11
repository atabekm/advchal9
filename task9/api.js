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
const KEY_STORAGE = 'task9.deepseek.key';

/* USD per 1M tokens, from https://api-docs.deepseek.com/quick_start/pricing
 * Off-peak is half of peak; peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
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

// A 400 that says the request did not fit is a different animal from a 400 that
// says the payload was malformed: one is arithmetic the caller can redo, the
// other is a bug. The wire does not always label it, so we do.
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

  async send({ model, messages, temperature, maxTokens, stream, thinking, signal, onChunk }) {
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
    // Thinking is on by default on this API, at high effort, so omitting the
    // parameter is not the same as declining it — silence buys the most
    // expensive setting there is. Off has to be said out loud.
    if (thinking === 'off') {
      payload.thinking = { type: 'disabled' };
    } else {
      payload.thinking = { type: 'enabled' };
      payload.reasoning_effort = thinking;
    }

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
// The offline stand-in. Same contract, no network, no key, no bill — but it
// now enforces the two limits a real model enforces, because a limit you can
// only demonstrate by spending money is a limit nobody demonstrates.
//
// It also has its own tokeniser, deliberately not the estimator in tokens.js.
// If the stub counted tokens the way the estimator predicts them, calibration
// would always report a perfect score and would be theatre. This one splits on
// word boundaries instead, disagrees with the estimator by a few percent, and
// gives the calibration something real to learn from offline.

const ECHO_CACHE = new Map();

function echoTokenize(text) {
  const source = String(text || '');
  const cached = ECHO_CACHE.get(source);
  if (cached !== undefined) return cached;
  const pieces = source.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]|[A-Za-z]+|[0-9]+|[^\s\w]|\s+/g) || [];
  let tokens = 0;
  for (const piece of pieces) {
    if (/^\s+$/.test(piece)) tokens += piece.length > 1 ? 1 : 0;
    else if (/^[A-Za-z]+$/.test(piece)) tokens += Math.ceil(piece.length / 6);
    else if (/^[0-9]+$/.test(piece)) tokens += Math.ceil(piece.length / 3);
    else tokens += 1;
  }
  const total = tokens + 1;
  if (ECHO_CACHE.size >= 2000) ECHO_CACHE.delete(ECHO_CACHE.keys().next().value);
  ECHO_CACHE.set(source, total);
  return total;
}

function echoCountMessages(messages) {
  return messages.reduce((sum, message) => sum + echoTokenize(message.content) + 4, 0) + 3;
}

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

  async send({ model, messages, temperature, maxTokens, thinking, signal, onChunk }) {
    const started = performance.now();
    const facts = MODELS[model] || { context: 65536, maxOutput: 4096 };
    const promptTokens = echoCountMessages(messages);
    const ceiling = Math.min(maxTokens, facts.maxOutput);

    // The refusal a real endpoint gives you, worded the way it words it.
    if (promptTokens + ceiling > facts.context) {
      throw new TransportError(
        `This model's maximum context length is ${facts.context} tokens. `
        + `However, you requested ${promptTokens + ceiling} tokens `
        + `(${promptTokens} in the messages, ${ceiling} in the completion). `
        + 'Please reduce the length of the messages or completion.',
        { status: 400, retryable: false, code: 'context_length_exceeded' }
      );
    }

    const system = messages.find((message) => message.role === 'system');
    const turns = messages.filter((message) => message.role !== 'system');
    const last = turns[turns.length - 1];
    const priorUser = turns.filter((message) => message.role === 'user').length - 1;
    const replies = turns.filter((message) => message.role === 'assistant').length;
    const share = ((promptTokens / facts.context) * 100).toFixed(1);

    let text = '';
    let ttft = null;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let reasoning = '';
    let finishReason = 'stop';

    // Thinking is spent from the same budget as the answer, and how long it goes
    // on depends on the effort asked for and on how much rope the prompt gives
    // it. That is the whole mechanism, so the stub imitates that and nothing
    // else: leave the effort high and the prompt open, and the thinking can eat
    // the ceiling before a word of the answer is written.
    if (thinking && thinking !== 'off') {
      const brief = /\b(short|brief|concise|paragraph|paragraphs|sentence|sentences|words?|bullets?)\b/i
        .test(system ? system.content : '');
      const effort = { low: 0.5, high: 1.6, max: 2.4 }[thinking] || 0.5;
      const wanted = Math.round(ceiling * effort * (brief ? 0.45 : 1));
      const thought = 'Considering the question from another angle, and then '
        + 'checking that against what was said earlier. ';
      while (reasoningTokens < wanted && reasoningTokens < ceiling) {
        const cost = echoTokenize(thought);
        if (reasoningTokens + cost > ceiling) break;
        reasoningTokens += cost;
        reasoning += thought;
        if (onChunk) {
          await new Promise((resolve) => setTimeout(resolve, 8));
          onChunk(thought, 'reasoning');
        }
        if (ttft === null) ttft = (performance.now() - started) / 1000;
      }
      if (wanted >= ceiling) {
        // Cut off inside the thought. A completion that ends mid-reasoning
        // reports the ceiling spent to the token and carries no content at all,
        // which is the failure worth being able to show on demand.
        reasoningTokens = ceiling;
        finishReason = 'length';
      }
      completionTokens = reasoningTokens;
    }

    const reply = [
      '**echo transport** — no request left this machine.',
      '',
      `The agent handed me **${messages.length} messages**, which my own tokeniser makes `
        + `**${promptTokens} tokens** — ${share}% of this model's ${facts.context}-token window, `
        + `before I write a word back.`,
      '',
      `That is ${system ? '1 system prompt' : 'no system prompt'}, `
        + `${priorUser} earlier user turn${priorUser === 1 ? '' : 's'}, `
        + `${replies} earlier repl${replies === 1 ? 'y' : 'ies'}, `
        + 'and the one you just sent. Every one of them was resent. That is why the '
        + 'number above is larger than it was last turn and will be larger again next turn.',
      '',
      `Sampling would have used temperature ${temperature} and a ${ceiling}-token ceiling`
        + `${thinking && thinking !== 'off'
          ? `, shared with ${reasoningTokens} tokens of thinking you are also paying for`
          : ', all of it available for the answer'}.`,
      '',
      `> ${(last ? last.content : '').slice(0, 200)}`,
    ].join('\n');

    const pieces = reply.match(/\S+\s*/g) || [];
    for (const piece of pieces) {
      if (finishReason === 'length') break;
      if (signal && signal.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      }
      // The output ceiling is a real ceiling here too: pass a small max tokens
      // and the reply stops mid-sentence with finish_reason: length, exactly
      // as it would upstream.
      const cost = echoTokenize(piece);
      if (completionTokens + cost > ceiling) {
        finishReason = 'length';
        break;
      }
      completionTokens += cost;
      // Pacing exists for the reader, so it only happens when someone is
      // reading. The lab sends without a listener and runs at full speed.
      if (onChunk) await new Promise((resolve) => setTimeout(resolve, 8));
      if (ttft === null) ttft = (performance.now() - started) / 1000;
      text += piece;
      if (onChunk) onChunk(piece, 'content');
    }

    return {
      text,
      reasoning,
      finishReason,
      usage: {
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens: promptTokens + completionTokens,
        cacheHitTokens: 0,
        cacheMissTokens: promptTokens,
      },
      cost: costOf(model, {
        promptTokens,
        completionTokens,
        cacheHitTokens: 0,
        cacheMissTokens: promptTokens,
      }),
      ttft,
      elapsed: (performance.now() - started) / 1000,
    };
  },
};

const TRANSPORTS = [deepseekTransport, echoTransport];
