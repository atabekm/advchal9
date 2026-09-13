// The counter. It turns text into a number, is honest about how much of a
// guess that number is, and does the arithmetic that decides whether the next
// request fits. It never touches the DOM, never sends anything, and does not
// know that a message means something.

// Context windows and prices are model facts, so they live here rather than in
// the transport. The transport bills; the counter knows the tariff.
// Prices are USD per 1M tokens.

// Context windows, output ceilings and prices are model facts, so they live
// here rather than in the transport. The transport bills; the counter knows the
// tariff. Prices are USD per 1M tokens at peak rates — costOf halves them
// off-peak, which is how DeepSeek quotes them.
//
// The first two are real and are what the API accepts. The third is not a model
// at all: it is a small window with a name, kept because the failures this page
// exists to show are unreachable on a million-token context, and a limit you
// can only demonstrate by spending money is a limit nobody demonstrates.

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
    note: 'being retired — requests route to Flash and bill at Flash prices',
  },
  'stub-16k': {
    context: 16384,
    maxOutput: 4096,
    price: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    stub: true,
    note: 'not a real model — offline transport only, for reaching the edge of a window',
  },
};

const FALLBACK_MODEL = { context: 65536, maxOutput: 4096, price: null };

// Chat formatting is not free. Every message carries role and delimiter tokens,
// and the reply is primed with a couple more. The exact numbers are provider
// business; these are the usual ones and the calibration below absorbs the rest.
const MESSAGE_OVERHEAD = 4;
const REPLY_PRIMING = 3;

// Characters per token, by script. English prose sits near four; Cyrillic and
// Greek fall to roughly two because the vocabulary was not built for them; CJK
// is about one token per character. A conversation held in Russian therefore
// costs about twice what the same conversation costs in English, and this is
// the only place in the codebase that knows it.
const SCRIPTS = [
  { id: 'cjk', perToken: 1 },
  { id: 'cyrillic', perToken: 2.1 },
  { id: 'greek', perToken: 2.1 },
  { id: 'digits', perToken: 2.4 },
  { id: 'latin', perToken: 3.9 },
];

// Ranges rather than regexes: this runs once per character of every message,
// and it is the one function in the file that has to be cheap.
function scriptOf(code) {
  if ((code >= 0x3040 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) return 'cjk';
  if (code >= 0x0400 && code <= 0x04ff) return 'cyrillic';
  if (code >= 0x0370 && code <= 0x03ff) return 'greek';
  if (code >= 0x30 && code <= 0x39) return 'digits';
  return 'latin';
}

function modelFacts(model) {
  return MODELS[model] || FALLBACK_MODEL;
}

function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

// Cost from a usage block. Exact, because usage is what the provider actually
// charged for — no estimate involved.
function costOf(model, usage) {
  const price = modelFacts(model).price;
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

// Cost of a hypothetical turn, for projections. Assumes a cold cache, which is
// the pessimistic and therefore useful direction.
function priceOut(model, promptTokens, completionTokens) {
  const price = modelFacts(model).price;
  if (!price) return 0;
  const scale = isPeak() ? 1 : 0.5;
  return (promptTokens * price.cacheMiss + completionTokens * price.output) * scale / 1e6;
}

// The estimate, and the breakdown behind it. Returned together so a panel can
// show why a short message came out expensive.
function classify(text) {
  const source = String(text == null ? '' : text);
  const counts = {};
  for (let index = 0; index < source.length; index += 1) {
    const id = scriptOf(source.charCodeAt(index));
    counts[id] = (counts[id] || 0) + 1;
  }

  let tokens = 0;
  const parts = [];
  for (const script of SCRIPTS) {
    const chars = counts[script.id] || 0;
    if (!chars) continue;
    const share = chars / script.perToken;
    tokens += share;
    parts.push({ script: script.id, chars, tokens: share, perToken: script.perToken });
  }

  return { chars: source.length, tokens, parts };
}

// Counting the same message again on every turn is the shape of the problem
// this whole file is about, so the counter does not do it: a message is
// immutable once said, and its raw count is cached against its text. The
// calibration factor is applied after the lookup, so learning a better factor
// costs nothing and invalidates nothing.
const RAW_CACHE = new Map();
const RAW_CACHE_LIMIT = 2000;

function rawTokens(text) {
  const key = String(text == null ? '' : text);
  if (key.length > 32000) return classify(key).tokens;
  const cached = RAW_CACHE.get(key);
  if (cached !== undefined) return cached;
  const value = classify(key).tokens;
  if (RAW_CACHE.size >= RAW_CACHE_LIMIT) RAW_CACHE.delete(RAW_CACHE.keys().next().value);
  RAW_CACHE.set(key, value);
  return value;
}

// Calibration. The estimate above is a heuristic and will be wrong; the API
// reports the truth in every usage block. So each turn compares what we
// predicted for the prompt against what we were billed for, and the ratio
// becomes a correction factor for the next prediction. Two samples in, the
// estimate is usually within a couple of percent.
class Calibration {
  constructor(snapshot) {
    this._byModel = new Map();
    if (snapshot) this.restore(snapshot);
  }

  _bucket(model) {
    if (!this._byModel.has(model)) {
      this._byModel.set(model, { model, samples: 0, estimated: 0, actual: 0, lastError: null });
    }
    return this._byModel.get(model);
  }

  observe(model, estimated, actual) {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual) || estimated <= 0 || actual <= 0) {
      return null;
    }
    const bucket = this._bucket(model);
    bucket.samples += 1;
    bucket.estimated += estimated;
    bucket.actual += actual;
    bucket.lastError = (estimated - actual) / actual;
    return { ...bucket, scale: this.scaleFor(model) };
  }

  // Pooled across models until a model has seen enough of its own turns. All
  // three models here share a tokeniser, so pooling is the right default and
  // the split is there for the day they do not.
  scaleFor(model) {
    const bucket = this._byModel.get(model);
    if (bucket && bucket.samples >= 2 && bucket.estimated > 0) {
      return this._clamp(bucket.actual / bucket.estimated);
    }
    let estimated = 0;
    let actual = 0;
    for (const entry of this._byModel.values()) {
      estimated += entry.estimated;
      actual += entry.actual;
    }
    if (estimated <= 0) return 1;
    return this._clamp(actual / estimated);
  }

  _clamp(scale) {
    if (!Number.isFinite(scale)) return 1;
    return Math.min(2, Math.max(0.5, scale));
  }

  statusFor(model) {
    const bucket = this._byModel.get(model) || { samples: 0, lastError: null };
    const pooled = [...this._byModel.values()].reduce((sum, entry) => sum + entry.samples, 0);
    return {
      model,
      samples: bucket.samples,
      pooledSamples: pooled,
      scale: this.scaleFor(model),
      lastError: bucket.lastError,
      calibrated: pooled > 0,
    };
  }

  snapshot() {
    return [...this._byModel.values()].map((entry) => ({ ...entry }));
  }

  restore(snapshot) {
    if (!Array.isArray(snapshot)) return;
    for (const entry of snapshot) {
      if (!entry || typeof entry.model !== 'string') continue;
      this._byModel.set(entry.model, {
        model: entry.model,
        samples: Number(entry.samples) || 0,
        estimated: Number(entry.estimated) || 0,
        actual: Number(entry.actual) || 0,
        lastError: Number.isFinite(entry.lastError) ? entry.lastError : null,
      });
    }
  }
}

class TokenCounter {
  constructor({ calibration } = {}) {
    this.calibration = calibration instanceof Calibration ? calibration : new Calibration(calibration);
  }

  // One number for one piece of text, corrected by whatever the API has taught
  // us so far. Message framing is not included — countMessage adds it.
  estimate(text, model) {
    return Math.max(0, Math.round(rawTokens(text) * this.calibration.scaleFor(model)));
  }

  breakdown(text, model) {
    const classified = classify(text);
    const scale = this.calibration.scaleFor(model);
    return {
      ...classified,
      scale,
      tokens: Math.max(0, Math.round(classified.tokens * scale)),
      raw: Math.ceil(classified.tokens),
    };
  }

  countMessage(message, model) {
    return this.estimate(message && message.content, model) + MESSAGE_OVERHEAD;
  }

  // Same arithmetic, one scale lookup, for the loops that walk a whole
  // conversation.
  _counterFor(model) {
    const scale = this.calibration.scaleFor(model);
    return (message) => Math.max(0, Math.round(rawTokens(message && message.content) * scale))
      + MESSAGE_OVERHEAD;
  }

  countMessages(messages, model) {
    const list = Array.isArray(messages) ? messages : [];
    const size = this._counterFor(model);
    return list.reduce((sum, message) => sum + size(message), 0) + REPLY_PRIMING;
  }

  // The ledger for a conversation: every message, what it costs to carry, and
  // what the running total was by the time it was said.
  ledger(messages, model) {
    const size = this._counterFor(model);
    let cumulative = 0;
    return (messages || []).map((message, index) => {
      const tokens = size(message);
      cumulative += tokens;
      return {
        index,
        role: message.role,
        chars: String(message.content || '').length,
        tokens,
        cumulative,
        at: message.at || null,
      };
    });
  }

  // How many trailing messages fit under a token cap, starting from the newest
  // and stopping at the first one that does not. Returns the cut point rather
  // than the slice, so the caller decides what to do with what it loses.
  fit(messages, model, cap) {
    const size = this._counterFor(model);
    let used = 0;
    let index = messages.length;
    while (index > 0) {
      const cost = size(messages[index - 1]);
      if (used + cost > cap) break;
      used += cost;
      index -= 1;
    }
    return { from: index, dropped: index, tokens: used };
  }

  // The preflight. Everything that will occupy the window, counted before
  // anything is sent, and the verdict on whether it fits.
  plan({ model, systemPrompt, history = [], next = '', maxTokens = 0 }) {
    const facts = modelFacts(model);
    const system = systemPrompt
      ? this.countMessage({ content: systemPrompt }, model)
      : 0;
    const rows = this.ledger(history, model);
    const historyTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    const nextTokens = next ? this.countMessage({ content: next }, model) : 0;

    const prompt = system + historyTokens + nextTokens + REPLY_PRIMING;
    const reserved = Math.min(maxTokens || 0, facts.maxOutput);
    const total = prompt + reserved;

    return {
      model,
      limit: facts.context,
      maxOutput: facts.maxOutput,
      system,
      history: historyTokens,
      historyRows: rows,
      messages: history.length,
      next: nextTokens,
      priming: REPLY_PRIMING,
      prompt,
      reserved,
      total,
      headroom: facts.context - total,
      fraction: facts.context ? total / facts.context : 0,
      overflow: total > facts.context,
      overflowBy: Math.max(0, total - facts.context),
      // What the request would cost if it went out exactly like this, before
      // the reply exists. Prompt is known; output is the ceiling, not a guess.
      worstCaseCost: priceOut(model, prompt, reserved),
    };
  }

  // Teach the estimator. `estimated` is what plan() said the prompt would be;
  // `usage.promptTokens` is what the provider billed.
  observe(model, estimated, usage) {
    if (!usage) return null;
    return this.calibration.observe(model, estimated, usage.promptTokens);
  }

  cost(model, usage) {
    return costOf(model, usage);
  }

  status(model) {
    return this.calibration.statusFor(model);
  }
}

// The turn ledger. One row per completed turn, which is what makes growth
// visible: the prompt column climbs, the completion column does not, and the
// cost column climbs faster than either.
class TurnLedger {
  constructor() {
    this.rows = [];
  }

  get length() {
    return this.rows.length;
  }

  record(row) {
    const previous = this.rows[this.rows.length - 1];
    const promptTokens = row.promptTokens || 0;
    const completionTokens = row.completionTokens || 0;
    const cost = typeof row.cost === 'number' ? row.cost : 0;

    const entry = {
      turn: row.turn,
      at: row.at || Date.now(),
      model: row.model,
      estimatedPrompt: row.estimatedPrompt || 0,
      promptTokens,
      completionTokens,
      reasoningTokens: row.reasoningTokens || 0,
      cachedTokens: row.cachedTokens || 0,
      billed: promptTokens + completionTokens,
      cost,
      cumulativeTokens: (previous ? previous.cumulativeTokens : 0) + promptTokens + completionTokens,
      cumulativeCost: (previous ? previous.cumulativeCost : 0) + cost,
      historyLength: row.historyLength || 0,
      dropped: row.dropped || 0,
      finishReason: row.finishReason || null,
      windowFraction: row.windowFraction || 0,
      drift: row.estimatedPrompt && promptTokens
        ? (row.estimatedPrompt - promptTokens) / promptTokens
        : null,
    };

    this.rows.push(entry);
    return entry;
  }

  clear() {
    this.rows = [];
  }

  summary() {
    if (!this.rows.length) return null;
    const last = this.rows[this.rows.length - 1];
    const first = this.rows[0];
    const prompts = this.rows.map((row) => row.promptTokens);
    const completions = this.rows.map((row) => row.completionTokens);
    const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;

    const reasoning = this.rows.reduce((sum, row) => sum + row.reasoningTokens, 0);
    const completion = this.rows.reduce((sum, row) => sum + row.completionTokens, 0);

    return {
      turns: this.rows.length,
      reasoningTokens: reasoning,
      completionTokens: completion,
      reasoningShare: completion ? reasoning / completion : 0,
      firstPrompt: first.promptTokens,
      lastPrompt: last.promptTokens,
      growthPerTurn: this.rows.length > 1
        ? (last.promptTokens - first.promptTokens) / (this.rows.length - 1)
        : 0,
      meanPrompt: mean(prompts),
      meanCompletion: mean(completions),
      billedTokens: last.cumulativeTokens,
      cost: last.cumulativeCost,
      costOfLastTurn: last.cost,
      costOfFirstTurn: first.cost,
      meanDrift: (() => {
        const drifts = this.rows.map((row) => row.drift).filter((value) => value != null);
        return drifts.length ? mean(drifts) : null;
      })(),
    };
  }

  // Where this is heading. Each turn resends the whole conversation, so the
  // prompt grows linearly and the money spent grows with the square of the
  // turn count. That is the single most useful thing this file computes.
  project({ model, systemTokens = 0, reserved = 0, turns = 10 }) {
    const summary = this.summary();
    const facts = modelFacts(model);
    const perTurn = summary && summary.turns > 1
      ? summary.growthPerTurn
      : (summary ? summary.meanPrompt : 0);
    const grow = Math.max(1, Math.round(perTurn));
    const reply = Math.max(1, Math.round(summary ? summary.meanCompletion : 0));
    const base = summary ? summary.lastPrompt : systemTokens;
    const from = summary ? summary.turns : 0;

    const points = [];
    let cost = summary ? summary.cost : 0;
    let prompt = base;
    let fits = null;

    for (let step = 1; step <= turns; step += 1) {
      prompt += grow;
      cost += priceOut(model, prompt, reply);
      const total = prompt + reserved;
      if (fits === null && total > facts.context) fits = from + step;
      points.push({ turn: from + step, prompt, total, cost, overflow: total > facts.context });
    }

    return {
      model,
      perTurn: grow,
      reply,
      limit: facts.context,
      points,
      overflowAt: fits,
      // Turns left before the window is full, at the current rate.
      turnsLeft: fits === null ? null : Math.max(0, fits - from - 1),
    };
  }
}
