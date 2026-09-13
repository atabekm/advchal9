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
const KEY_STORAGE = 'task10.deepseek.key';

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

/* The tokeniser proper: how many tokens this text is, and nothing else.
 *
 * Task 8 only ever called this on whole messages, so it folded a per-text
 * framing token into the same function. That is fine for a message and wrong
 * for a fragment, and the streaming loop below calls it once per word — which
 * quietly billed an extra token per word and made every output ceiling behave
 * like half of itself. Splitting the two apart is the fix; `echoTokenize` is
 * still the per-message count, and still the one `echoCountMessages` uses. */
function echoTokens(text) {
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
  if (ECHO_CACHE.size >= 2000) ECHO_CACHE.delete(ECHO_CACHE.keys().next().value);
  ECHO_CACHE.set(source, tokens);
  return tokens;
}

// One message, framing included.
function echoTokenize(text) {
  return echoTokens(text) + 1;
}

function echoCountMessages(messages) {
  return messages.reduce((sum, message) => sum + echoTokenize(message.content) + 4, 0) + 3;
}

/* ---------------------------------------------------------------------------
 * The stub grows two abilities, and both exist for the same reason its
 * tokeniser does: a comparison you can only run by spending money is a
 * comparison nobody runs.
 *
 * Task 8 needed the stub to *count* honestly. Task 9 needs it to *answer*
 * honestly, because half this brief is about response quality and you cannot
 * grade an answer from a transport that never answers anything.
 * ------------------------------------------------------------------------- */

// Question scaffolding. These words carry no fact, so they are not evidence
// that a fact was present: "what is my cat called" must not match on "called".
const SCAFFOLD = new Set([
  'a', 'about', 'again', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'ask', 'at',
  'be', 'been', 'by', 'call', 'called', 'can', 'did', 'do', 'does', 'earlier', 'for',
  'from', 'get', 'give', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if',
  'in', 'is', 'it', 'its', 'know', 'me', 'mentioned', 'my', 'name', 'named', 'of',
  'on', 'or', 'our', 'remember', 'remind', 'said', 'say', 'she', 'so', 'tell',
  'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to', 'told', 'up', 'us',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will',
  'with', 'would', 'you', 'your',
]);

function terms(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [])
    .filter((word) => word.length > 1);
}

function contentTerms(text) {
  return [...new Set(terms(text).filter((word) => !SCAFFOLD.has(word)))];
}

function isQuestion(text) {
  const flat = String(text || '').trim();
  if (!flat) return false;
  if (flat.includes('?')) return true;
  return /^(what|who|when|where|which|how|why|tell me|remind me|do you (remember|recall))\b/i
    .test(flat);
}

/* The corpus the oracle is allowed to search: exactly what was handed to it,
 * split into lines so a summary contributes its facts individually rather than
 * as one lump. The persona system prompt is excluded — it is instructions, not
 * something anybody said — and so is the question being asked. */
function searchable(messages) {
  const lines = [];
  messages.forEach((message, index) => {
    const isLast = index === messages.length - 1;
    if (isLast && message.role === 'user') return;
    const compressed = message.role === 'system'
      && /^Earlier in this conversation/.test(message.content);
    // The third kind of system message: a facts block. It is searched for the
    // same reason a summary is — it is in the payload, so it is context — and
    // it is labelled apart from the summary for the reason that matters most
    // to the benchmark: which half of the payload an answer came out of.
    const factual = message.role === 'system'
      && /^Facts established in this conversation/.test(message.content);
    if (message.role === 'system' && !compressed && !factual) return;

    const body = compressed
      ? message.content.replace(/^Earlier in this conversation[^\n]*\n?/, '')
      : (factual ? message.content.replace(/^Facts established[^\n]*\n?/, '') : message.content);

    for (const line of body.split('\n')) {
      let text = line.replace(/^(user|assistant):\s*/i, '').trim();
      if (text.length < 3) continue;
      if (factual) {
        // The block's own note about what did not fit is not a fact.
        if (/^\[\d+ further fact/.test(text)) continue;
        // The star marks a fact the assistant settled. It is punctuation for
        // the reader, not a word in the fact, so it does not go into the index.
        text = text.replace(/^\*\s+/, '');
        // `staging_box = 10.2.0.7` holds the same words a question would use,
        // but joined by an underscore, which the tokeniser keeps whole. The
        // underscores are the store's punctuation, not the fact's.
        text = text.replace(/^([a-z0-9_.]+)\s*=/i, (match, key) => `${key.replace(/_/g, ' ')} =`);
      }
      lines.push({ text, from: compressed ? 'summary' : (factual ? 'facts' : message.role), index });
    }
  });
  return lines;
}

/* The oracle.
 *
 * It is not pretending to be intelligent. It answers exactly one question —
 * *was this fact still in the payload?* — by retrieval over what it was given,
 * and it says which half of the payload the answer came from. That last part is
 * what lets a benchmark tell "compression preserved it" apart from "it was
 * never compressed in the first place".
 *
 * The refusal rule is the important one. A term the question asks about that
 * appears nowhere in the payload is not a weak match, it is an absence, and the
 * oracle says so rather than reaching for the nearest sentence. Without that, a
 * question about a cat would be answered from a sentence about a dog and the
 * quality column would measure nothing.
 */
function recall(messages) {
  const question = messages[messages.length - 1];
  const asked = contentTerms(question && question.content);
  const lines = searchable(messages);

  if (!asked.length || !lines.length) return null;

  const documentFrequency = new Map();
  for (const term of asked) {
    let seen = 0;
    for (const line of lines) if (terms(line.text).includes(term)) seen += 1;
    documentFrequency.set(term, seen);
  }

  const present = asked.filter((term) => documentFrequency.get(term) > 0);
  // Fewer than half the things asked about are anywhere in the payload. That is
  // an absence, and the honest answer to an absence is that there isn't one.
  if (present.length * 2 < asked.length) {
    return {
      found: false,
      asked,
      missing: asked.filter((term) => !documentFrequency.get(term)),
      searched: lines.length,
    };
  }

  const idf = (term) => Math.log(1 + lines.length / (1 + documentFrequency.get(term)));
  let best = null;
  for (const line of lines) {
    const words = terms(line.text);
    let score = 0;
    let matched = 0;
    for (const term of present) {
      if (words.includes(term)) {
        score += idf(term);
        matched += 1;
      }
    }
    if (!matched) continue;
    // Shorter lines carrying the same terms are better evidence than long ones.
    score /= Math.log(8 + words.length);
    if (!best || score > best.score) best = { ...line, score, matched };
  }

  if (!best) {
    return { found: false, asked, missing: asked, searched: lines.length };
  }
  return { found: true, ...best, asked, searched: lines.length };
}

/* The extractive summariser.
 *
 * Genuinely lossy, and lossy for a reason that is real rather than staged: it
 * ranks lines by how much fact they carry and keeps them until the ceiling is
 * reached. Facts fall out because the budget ran out, which is exactly why they
 * fall out upstream. A stub summariser that kept everything would score
 * perfectly forever and would be measuring nothing.
 */
function factScore(line, role) {
  let score = 0;
  /* Who said it is evidence about whether it is a fact. The user states things
   * — names, dates, preferences, addresses — and the assistant mostly restates
   * them back. When a ceiling forces a choice, the statement is worth more than
   * the acknowledgement of it. */
  if (role === 'user') score += 3;
  if (/\d/.test(line)) score += 3;                       // numbers, dates, versions
  if (/\b\d+\.\d+\.\d+/.test(line)) score += 3;          // addresses and identifiers
  if (/\b(is|was|are|were|called|named|use|uses|prefers?|deadline|must|never|always)\b/i
    .test(line)) score += 2;
  if (/[A-Z][a-z]{2,}/.test(line.slice(1))) score += 2;  // proper nouns, mid-sentence
  if (/[:=]/.test(line)) score += 1;
  if (/\b(filler|anyway|thanks|sure|okay|hello|hi)\b/i.test(line)) score -= 3;
  score -= Math.floor(line.length / 400);                // rambling is not fact
  return score;
}

function extractiveSummary(source, ceiling) {
  const candidates = [];
  const seen = new Set();
  let role = 'user';
  let half = 'old';

  source.split('\n').forEach((raw, order) => {
    // The fold source is "role: content", and a message with newlines in it
    // keeps its role only on the first line. Carry it forward rather than
    // guessing per line.
    const labelled = raw.match(/^(user|assistant):\s*(.*)$/i);
    if (labelled) role = labelled[1].toLowerCase();

    let line = (labelled ? labelled[2] : raw).trim();
    // The fold source names its own two halves. Which half a sentence came
    // from decides what it has to compete with, so the marker is read rather
    // than skipped.
    if (/^---/.test(line)) {
      if (/newer messages/i.test(line)) half = 'new';
      return;
    }
    // Previous generations arrive already bulleted, and re-bulleting them is how
    // a rolling summary ends up reading "- - - the dog is called Kepler" four
    // folds in. Strip the formatting back off before ranking.
    line = line.replace(/^(?:[-*>]\s*)+/, '').trim();
    if (line.length < 8) return;
    // The summariser's own note about what it dropped last time is not a fact
    // about the conversation, and re-ingesting it spends the ceiling twice.
    if (/^\[\d+ further sentence/.test(line)) return;
    if (/^\*\*echo transport\*\*/.test(line)) return;

    // One sentence per line, so a fact is not dragged out by the paragraph it
    // happens to sit in.
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      const sentence = piece.trim();
      if (sentence.length < 8) continue;
      // A quoted-back sentence and the sentence it quotes are the same fact
      // paid for twice.
      const key = sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ order, sentence, role, half, score: factScore(sentence, role) });
    }
  });

  const ranked = candidates
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const kept = [];
  const keptTerms = [];
  // The bullet and the newline are billed too, and a summariser that budgets
  // for its content but not for its formatting gets cut off mid-fact. Room is
  // held back for the note that says what did not fit.
  const budget = Math.max(16, ceiling - 40);

  /* The budget is split, and this is the least obvious thing in the file.
   *
   * A rolling summary is asked to cover the previous summary plus what has
   * happened since, out of one fixed ceiling. The previous summary has already
   * been compressed once, so every sentence in it is dense and scores well —
   * and if the two halves compete on score alone, the old half wins the whole
   * ceiling and nothing said after the first fold is ever recorded again.
   * The summary stops being a memory and becomes a monument to the opening.
   *
   * So the already-compressed half is capped, and the rest is reserved for
   * what is new. Anything the new half does not use falls back to the old.
   */
  const spent = { old: 0, new: 0 };
  const caps = { old: Math.round(budget * 0.6), new: budget };

  /* Greedy selection with a redundancy penalty. Rank alone is not enough: a
   * sentence that repeats with one number changed scores as well as the first
   * one did, and eight of them will fill a ceiling and push out every fact said
   * in between. The eighth restatement is not news, so near-duplicates of
   * something already kept are skipped no matter how well they score. */
  const similar = (words) => keptTerms.some((previous) => {
    let shared = 0;
    for (const word of words) if (previous.has(word)) shared += 1;
    const union = previous.size + words.size - shared;
    return union > 0 && shared / union > 0.55;
  });

  for (const pass of ['new', 'old']) {
    for (const entry of ranked) {
      if (entry.half !== pass) continue;
      if (entry.score <= 0) continue;
      const words = new Set(terms(entry.sentence));
      if (words.size > 3 && similar(words)) continue;
      const cost = echoTokens(`- ${entry.sentence}\n`);
      if (spent.old + spent.new + cost > budget) continue;
      if (spent[pass] + cost > caps[pass]) continue;
      spent[pass] += cost;
      keptTerms.push(words);
      kept.push(entry);
    }
  }
  const used = spent.old + spent.new;

  // Back into the order they were said in, so the summary reads as a record
  // rather than as a leaderboard.
  kept.sort((a, b) => a.index - b.index);
  return {
    text: kept.map((entry) => `- ${entry.sentence}`).join('\n'),
    kept: kept.length,
    dropped: candidates.length - kept.length,
    tokens: used,
  };
}

/* ---------------------------------------------------------------------------
 * The stub extractor.
 *
 * Task 9 gave the stub a summariser so that the quality half of that brief
 * could be run without a key. This is the same move for this one, and it is
 * held to the same standard: it has to be *genuinely* lossy, in a way that is
 * real rather than staged, or the benchmark measures nothing.
 *
 * So it is what it looks like — a handful of statement shapes and a key
 * derived from the subject. It misses things a model would catch: anything
 * stated across two sentences, anything implied, anything phrased in a way that
 * is not on the list. That is the conservative direction for this task's
 * argument. If a strategy wins the comparison while its extractor is this
 * stupid, the win is not coming from the extractor.
 *
 * What it cannot do is invent, and not because it is careful: every value it
 * emits is a slice of the message it was given, so the verbatim rule in
 * facts.js has nothing to reject. A real model on the other end of the same
 * request is the interesting case, and it is the one the rejected column on
 * screen exists to count.
 * ------------------------------------------------------------------------- */

// Words that make a key worse. "the staging box" and "our staging box" name the
// same thing, and a store holding both has two facts and no opinion.
const KEY_NOISE = new Set([
  'a', 'an', 'the', 'our', 'my', 'your', 'their', 'its', 'this', 'that', 'these',
  'those', 'first', 'next', 'new', 'old', 'whole', 'very', 'just', 'also', 'now',
  'please', 'actually', 'basically', 'really',
]);

function keyFrom(phrase, known) {
  const words = String(phrase || '')
    .toLowerCase()
    .match(/[a-z][a-z0-9]*/g) || [];
  const content = words.filter((word) => !KEY_NOISE.has(word) && !SCAFFOLD.has(word));
  /* No fallback to the raw words.
   *
   * It used to read `content.length ? content : words`, and that one clause was
   * the whole of the bug: given "That is firm." every word is noise, the
   * fallback fires, and the store gains `that = firm` — true, quotable, and
   * about nothing. When a phrase has no content words in it, the phrase is not
   * naming anything, and the honest key for that is no key at all. */
  const candidate = content.slice(0, 2).join('_');
  if (!candidate) return null;

  /* Rule 2 of the contract, implemented the way the contract asks a model to
   * implement it: prefer a key that already exists. A candidate sharing a word
   * with a known key is the same subject said differently — `demo` after
   * `first_demo` — and taking the known one is the difference between revising
   * a fact and starting a second one beside it. */
  const parts = new Set(candidate.split('_'));
  for (const entry of known || []) {
    if (entry.key === candidate) return entry.key;
    if (entry.key.split(/[_.]/).some((part) => parts.has(part))) return entry.key;
  }
  return candidate;
}

/* The other half of rule 2, and the half that is easy to miss.
 *
 * "Scratch SQLite, we are going with Postgres" names the key nowhere. What it
 * names is the *value* being replaced, and the key is whichever fact currently
 * holds it. Without this the store ends up believing `storage = SQLite` and
 * `postgres = Postgres` at the same time, which is not a revised decision, it is
 * two decisions and no way to tell which one is live.
 *
 * A model reading the same menu resolves this without being told. A rule needs
 * telling, so here it is.
 */
function supersedes(sentence, known, proposed) {
  const flat = String(sentence || '').toLowerCase();
  const value = String(proposed || '').toLowerCase();
  for (const entry of known || []) {
    const current = String(entry.value || '').toLowerCase();
    if (!current || current === value) continue;
    if (flat.includes(current)) return entry.key;
  }
  return null;
}

// A value is a span, not a sentence. Cut at the first clause boundary and cap
// the length, so what comes back is still a slice of the message — the store
// would reject it otherwise, and rightly.
function valueFrom(raw) {
  let value = String(raw || '').trim();
  const boundary = value.search(/,| and | but | so | because |;| — | - |\.\s|\.$/i);
  if (boundary > 2) value = value.slice(0, boundary);
  value = value.replace(/[.,;:!?]+$/, '').trim();
  const words = value.split(/\s+/);
  if (words.length > 10) value = words.slice(0, 10).join(' ');
  return value.length > 2 && value.length <= 96 ? value : null;
}

/* The shapes. Order matters: the specific ones first, the catch-all last.
 *
 * Every `value` is a captured group, so it is a substring of the message by
 * construction rather than by intention. */
const FACT_SHAPES = [
  {
    kind: 'goal',
    re: /\b(?:we(?:'re| are)|i(?:'m| am)) (?:building|making|writing|putting together) (.+)/i,
    key: () => 'goal',
    value: (match) => match[1],
  },
  { kind: 'goal', re: /\bthe (?:goal|aim|point) is (?:to )?(.+)/i, key: () => 'goal', value: (m) => m[1] },
  { kind: 'constraint', re: /\bbudget is (.+)/i, key: () => 'budget', value: (m) => m[1] },
  { kind: 'agreement', re: /\b(?:agreed|deal|settled)[:,]\s*(.+)/i, key: () => 'agreement', value: (m) => m[1] },
  {
    kind: 'preference',
    re: /\bi (?:prefer|want|like|expect) (.+)/i,
    key: (m) => keyFrom(m[1]),
    value: (m) => m[1],
  },
  {
    kind: 'constraint',
    re: /\bit (?:has to|must|needs to|should) (.+)/i,
    key: (m) => keyFrom(m[1]),
    value: (m) => m[1],
  },
  {
    kind: 'decision',
    re: /\b(?:let'?s use|we(?:'re| are) going with|switch(?:ing)? to|moved? to|changed? to|going with)\s+(.+)/i,
    key: (m, text) => keyFrom(subjectOf(text) || m[1]),
    value: (m) => m[1],
  },
  {
    // The catch-all: "<subject> <copula> <value>". It is last because it will
    // match half of everything, including a lot of sentences that are not
    // facts — which is what the small-talk filter upstream is for.
    kind: null,
    re: /^(?:and |also |oh,? )?(.{2,44}?)\s(?:is|are|will be|lives at|sits at|stays on|go(?:es)? to|remains?)\s+(.+)$/i,
    key: (m) => keyFrom(m[1]),
    value: (m) => m[2],
  },
];

/* What the stub will take from a reply, and it is deliberately a separate,
 * shorter list.
 *
 * The catch-all — "<subject> is <value>" — is not on it, and that is the whole
 * safety of this half. Run over an assistant's prose the catch-all matches
 * almost every sentence, including "that took 1,434 tokens of context", and the
 * store fills with things the model said about itself. What is here instead is
 * three shapes that can only match a settlement: a commitment in the first
 * person, an explicit agreement, and a value the assistant worked out.
 */
const REPLY_SHAPES = [
  {
    kind: 'agreement',
    re: /\bi(?:'ll| will| agree to)\s+(.+)/i,
    key: (m) => keyFrom(m[1]),
    value: (m) => m[1],
  },
  {
    kind: 'agreement',
    re: /\b(?:agreed|settled|understood)[:,\u2014-]\s*(.+)/i,
    key: (m) => keyFrom(m[1]),
    value: (m) => m[1],
  },
  {
    kind: 'decision',
    re: /\b(?:that (?:comes to|works out at)|the total is)\s+(.+)/i,
    key: (m, text) => keyFrom(subjectOf(text) || m[1]),
    value: (m) => m[1],
  },
];

// What a "moved to 11 March" sentence is about. The shape that matched has the
// new value; the subject is somewhere to its left, and without it every
// revision in a conversation would land on a key called `moved`.
function subjectOf(text) {
  const match = String(text || '').match(/\b(?:the|our|my)\s+([a-z][a-z ]{2,24}?)\s+(?:is|are|has|have|moved|moves|changed|changes|will)\b/i);
  return match ? match[1] : null;
}

const SMALL_TALK = /\b(?:thanks|thank you|anyway|sure|fine by me|no news|nothing much|hello|hi there|good morning|ok|okay|sounds good|carry on)\b/i;

function kindOf(sentence, value, fallback) {
  if (fallback) return fallback;
  if (/\b(?:\d+\.\d+\.\d+|[a-z]+\/[a-z0-9.-]+|v\d|@)/i.test(value)) return 'identifier';
  if (/\b(?:must|cannot|can't|never|only|hard|no cloud|offline|budget|limit|at most|deadline)\b/i.test(sentence)) return 'constraint';
  if (/\b(?:prefer|prefers|rather|always|every)\b/i.test(sentence)) return 'preference';
  if (/\b(?:demo|deadline|release|ship|due)\b/i.test(sentence)) return 'decision';
  return 'other';
}

/* One message in, JSON out — the same contract a model is held to, answered by
 * rules. The known keys come from the request itself, which is the only place
 * this transport is allowed to learn them from. */
function extractFacts(prompt) {
  const text = String(prompt || '');
  /* The menu, read as it was written: keys *and* their current values. The
   * values are not decoration — they are how a revision finds the key it is
   * revising when the sentence never says it. */
  const known = (text.split(/\nTurn \d+\./)[0] || '').split('\n')
    .map((line) => line.match(/^([a-z0-9_.]+)\s*=\s*(.+?)(?:\s*\(you settled this\))?$/i))
    .filter(Boolean)
    .map((match) => ({ key: match[1], value: match[2].trim() }));

  const halves = {
    user: (text.split(/\nThe user said:\n/)[1] || '').split(/\nThe assistant replied:\n/)[0].trim(),
    assistant: (text.split(/\nThe assistant replied:\n/)[1] || '').trim(),
  };

  const facts = [];
  const taken = new Set();

  const readHalf = (from, shapes) => {
    const message = halves[from];
    if (!message) return;
    const sentences = message
      // A quoted line is somebody else's sentence sitting inside this one.
      .split('\n').filter((line) => !/^\s*>/.test(line)).join('\n')
      .split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);

    for (const sentence of sentences) {
      // A retraction is a write, and it is the one shape that carries no value.
      // Only the user may retract: the agent withdrawing a fact the user stated
      // is the agent editing the record.
      const drop = from === 'user'
        && sentence.match(/\b(?:forget|scrap|drop|ignore|cancel)\s+(?:the\s+|our\s+|that\s+)?([a-z][a-z ]{2,24})/i);
      if (drop) {
        const key = keyFrom(drop[1], known);
        if (key && known.some((entry) => entry.key === key)) {
          facts.push({ key, op: 'clear', from });
          taken.add(key);
          continue;
        }
      }

      /* A question is a request, not a statement.
       *
       * Without this the catch-all shape reads "which database are we using?"
       * as `database = we using` and overwrites the answer with the question —
       * and reads "what is the lab phone number?" as a fact about a phone
       * number nobody has, which is confabulation arriving through the one door
       * that was supposed to be shut. The verbatim rule cannot catch either:
       * every word of both is in the message.
       */
      if (isQuestion(sentence)) continue;
      if (SMALL_TALK.test(sentence) && !/\d/.test(sentence)) continue;

      for (const shape of shapes) {
        const match = sentence.match(shape.re);
        if (!match) continue;
        const value = valueFrom(shape.value(match, sentence));
        if (!value) continue;
        const key = supersedes(sentence, known, value) || keyFrom(shape.key(match, sentence), known);
        if (!key || taken.has(key)) continue;
        /* The verbatim rule, checked here too, and checked against the half
         * being read rather than against the turn. It is checked again in the
         * store, and it will be checked there whatever this transport does —
         * but a stub that quietly emits a value it cannot quote is a stub that
         * has stopped being a stand-in for the thing it stands in for. */
        if (!message.toLowerCase().includes(value.toLowerCase())) continue;
        /* And the other half of rule 10: a reply that repeats what the user
         * just said has settled nothing. Storing it would file the user's own
         * words under the agent's name — which is the attribution this whole
         * stage exists to keep straight, and it is not caught by the verbatim
         * rule, because the words really are in both messages. */
        if (from === 'assistant' && halves.user.toLowerCase().includes(value.toLowerCase())) continue;
        facts.push({ key, value, kind: kindOf(sentence, value, shape.kind), op: 'set', from });
        taken.add(key);
        break;
      }
    }
  };

  /* The user first, and `taken` is shared between the two passes. That is rule
   * 11 of the contract implemented rather than hoped for: when both halves of
   * the turn carry the same fact, the user's statement wins and the agent's
   * acknowledgement of it never reaches the store wearing the agent's name. */
  readHalf('user', FACT_SHAPES);
  readHalf('assistant', REPLY_SHAPES);

  return JSON.stringify({ facts });
}

function isExtractionRequest(messages) {
  const first = messages[0];
  return Boolean(first && first.role === 'system'
    && /^You maintain a key\/value store/.test(first.content));
}

function isSummaryRequest(messages) {
  const first = messages[0];
  return Boolean(first && first.role === 'system'
    && /^You compress conversation history/.test(first.content));
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
    const summarised = messages.some((message) => message.role === 'system'
      && /^Earlier in this conversation/.test(message.content));
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
        const cost = echoTokens(thought);
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

    /* Four things this transport can be asked to be, and it decides which from
     * the payload alone — no flags, no model names, nothing the caller has to
     * remember to set. */
    let reply;

    if (isExtractionRequest(messages)) {
      // An extractor. Rules, not intelligence, and it says so by never
      // producing a value it cannot quote.
      reply = extractFacts(last ? last.content : '');
    } else if (isSummaryRequest(messages)) {
      // A summariser. Extractive, ranked by how much fact a sentence carries,
      // and cut off by the same ceiling a real one would be cut off by.
      const extracted = extractiveSummary(last ? last.content : '', ceiling);
      reply = extracted.text || '- (nothing in the source scored as a fact)';
      if (extracted.dropped > 0) {
        // Said out loud, because a summariser that quietly drops a third of its
        // input is the exact failure this task exists to make visible.
        reply += `\n- [${extracted.dropped} further sentence`
          + `${extracted.dropped === 1 ? '' : 's'} did not fit the `
          + `${ceiling}-token ceiling and were dropped]`;
      }
    } else if (isQuestion(last ? last.content : '')) {
      /* An oracle. It answers from the payload or not at all, which makes a
       * graded recall score a direct measurement of what the memory policy
       * preserved rather than a judgement about how clever a model is. */
      const hit = recall(messages);
      if (hit && hit.found) {
        reply = [
          hit.text,
          '',
          `— recalled from ${{
            summary: 'the compressed summary',
            facts: 'the facts block',
          }[hit.from] || `a verbatim ${hit.from} message`}, out of ${hit.searched} lines in my context.`,
        ].join('\n');
      } else {
        reply = [
          'I cannot answer that from what I was given.',
          '',
          hit && hit.missing && hit.missing.length
            ? `Nothing in my context mentions ${hit.missing.join(', ')}.`
            : 'Nothing in my context matches the question.',
          `I searched ${hit ? hit.searched : 0} lines — `
            + `${promptTokens} tokens, ${messages.length} messages. `
            + 'If it was said earlier, it is no longer here.',
        ].join('\n');
      }
    } else {
      /* Task 8's stub answered every message with an essay about token
       * counting, because token counting was the point. The point has moved,
       * and an assistant whose every reply is six paragraphs about itself is
       * not a stand-in for a conversation — it is the loudest thing in the
       * conversation, and a summariser asked to compress it will spend its
       * whole ceiling on the stub rather than on what was said to it.
       *
       * So the same facts, in the two lines a reply would actually take. The
       * full arithmetic is in the tokens tab, where it was always better read. */
      /* One reply shape beyond the acknowledgement, and it exists because
       * without it there is nothing in this whole app that the *assistant*
       * ever settles — so the half of the fact store that reads replies could
       * be built and never exercised. When the user assigns the agent a piece
       * of work, the agent commits to it and puts a date on it. The date is the
       * agent's own, which is the point: it is the one thing in a conversation
       * with this stub that nobody but the assistant said. */
      /* Anchored at the start on purpose. "Agreed: you write the schema, I
       * write the import script" is the user dividing up work, not handing it
       * over, and a stub that answers it with "I will write the schema, I write
       * the import script" commits the agent to a sentence that was half
       * somebody else's. Only a message that is *nothing but* an assignment
       * gets a commitment back. */
      const assigned = (last ? last.content : '')
        .match(/^you (take|write|handle|own|draft)\s+(.+?)[.!]?$/i);

      const lines = [];
      if (assigned) {
        lines.push(
          `Agreed — I will ${assigned[1].toLowerCase()} ${assigned[2]}. `
            + 'I will have it ready two days before the demo.',
          ''
        );
      }
      lines.push(
        `Noted. That took ${promptTokens} tokens of context — ${share}% of `
          + `${model}'s window — for ${messages.length} messages`
          + `${summarised ? ', one of them a summary standing in for older turns' : ''}.`,
        '',
        `> ${(last ? last.content : '').slice(0, 120)}`
      );
      reply = lines.join('\n');
    }

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
      const cost = echoTokens(piece);
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
