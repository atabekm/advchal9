/* The interface.
 *
 * It owns no conversation, no payload and no HTTP. It reads `agent.config` and
 * `Agent.schema` to draw the config tab, mirrors the agent's event stream into
 * the debug tab, and calls `agent.send(text)` to take a turn. Everything it
 * displays was either typed by the user or emitted by the agent.
 */

const CONFIG_STORAGE = 'task10.agent.config';
const CALIBRATION_STORAGE = 'task10.calibration';
const MAX_EVENTS = 400;

const el = (id) => document.getElementById(id);
const dom = {
  key: el('key'),
  transport: el('transport'),
  stats: el('stats'),
  log: el('log'),
  empty: el('empty'),
  composer: el('composer'),
  input: el('input'),
  send: el('send'),
  stop: el('stop'),
  reset: el('reset'),
  status: el('status'),
  fields: el('fields'),
  readonly: el('readonly'),
  events: el('events'),
  filter: el('filter'),
  copyLog: el('copyLog'),
  clearLog: el('clearLog'),
  configPanel: el('configPanel'),
  debugPanel: el('debugPanel'),
  sessionsPanel: el('sessionsPanel'),
  title: el('title'),
  sessionMeta: el('sessionMeta'),
  banner: el('banner'),
  sessions: el('sessions'),
  storage: el('storage'),
  newSession: el('newSession'),
  exportSession: el('exportSession'),
  importSession: el('importSession'),
  importFile: el('importFile'),
  tokensPanel: el('tokensPanel'),
  draft: el('draft'),
  meter: el('meter'),
  windowRows: el('windowRows'),
  ledger: el('ledger'),
  ledgerNote: el('ledgerNote'),
  chart: el('chart'),
  turns: el('turns'),
  calibration: el('calibration'),
  projection: el('projection'),
  compare: el('compare'),
  contextPanel: el('contextPanel'),
  strategy: el('strategy'),
  strategyNote: el('strategyNote'),
  factsNote: el('factsNote'),
  factsBlock: el('factsBlock'),
  factsTable: el('factsTable'),
  factsRows: el('factsRows'),
  extractRows: el('extractRows'),
  markHere: el('markHere'),
  forkHere: el('forkHere'),
  branchTree: el('branchTree'),
  branchRows: el('branchRows'),
  split: el('split'),
  splitRows: el('splitRows'),
  summaryNote: el('summaryNote'),
  summaryText: el('summaryText'),
  savedRows: el('savedRows'),
  foldRows: el('foldRows'),
  generationsNote: el('generationsNote'),
  generations: el('generations'),
  benchRun: el('benchRun'),
  benchClear: el('benchClear'),
  benchStatus: el('benchStatus'),
  bench: el('bench'),
  labShort: el('labShort'),
  labLong: el('labLong'),
  labOverflow: el('labOverflow'),
  labClear: el('labClear'),
};

let agent = null;
let controller = null;
let log = [];
let store = null;
let session = null;
let counter = null;
let compressor = null;
let facts = null;
let tree = null;
let labRuns = [];
let labBusy = false;

/* ---------- persistence ---------- */

function savedConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_STORAGE) || '{}');
  } catch (error) {
    return {};
  }
}

function saveConfig(config) {
  try {
    localStorage.setItem(CONFIG_STORAGE, JSON.stringify(config));
  } catch (error) {
    /* storage disabled — the page still works, it just forgets on reload */
  }
}

/* ---------- formatting ---------- */

function savedCalibration() {
  try {
    return JSON.parse(localStorage.getItem(CALIBRATION_STORAGE) || 'null');
  } catch (error) {
    return null;
  }
}

function saveCalibration() {
  try {
    localStorage.setItem(CALIBRATION_STORAGE, JSON.stringify(counter.calibration.snapshot()));
  } catch (error) {
  }
}

function count(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function percent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function signed(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function clock(at) {
  const date = new Date(at);
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`
    + `.${pad(date.getMilliseconds(), 3)}`;
}

function money(value) {
  if (typeof value !== 'number') return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function seconds(value) {
  return typeof value === 'number' ? `${value.toFixed(2)}s` : '—';
}

function relative(at) {
  if (!Number.isFinite(at)) return 'an unknown time ago';
  const delta = Date.now() - at;
  if (delta < 45000) return 'moments ago';
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function size(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function plural(count, word, plural_) {
  if (count === 1) return `${count} ${word}`;
  return `${count} ${plural_ || `${word}s`}`;
}

function clip(text, length) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/* ---------- config tab ---------- */

function control(field) {
  if (field.type === 'textarea') {
    const node = document.createElement('textarea');
    node.rows = 4;
    node.spellcheck = false;
    return node;
  }
  if (field.type === 'select') {
    const node = document.createElement('select');
    for (const option of field.options) {
      const item = document.createElement('option');
      item.value = option;
      item.textContent = option;
      node.append(item);
    }
    return node;
  }
  if (field.type === 'toggle') {
    const node = document.createElement('input');
    node.type = 'checkbox';
    return node;
  }
  const node = document.createElement('input');
  if (field.type === 'text') {
    node.type = 'text';
    node.spellcheck = false;
    return node;
  }
  node.type = field.type === 'range' ? 'range' : 'number';
  if (field.min != null) node.min = field.min;
  if (field.max != null) node.max = field.max;
  if (field.step != null) node.step = field.step;
  return node;
}

/* One row per schema entry, so a property added to the agent shows up here
 * without this file being touched. */
function buildFields() {
  dom.fields.replaceChildren();

  for (const field of Agent.schema) {
    const row = document.createElement('label');
    row.className = `field field-${field.type}`;
    row.title = field.help;

    const head = document.createElement('span');
    head.className = 'field-head';

    const name = document.createElement('span');
    name.className = 'field-name';
    name.textContent = field.label;

    const value = document.createElement('span');
    value.className = 'field-value';
    value.dataset.readout = field.key;

    head.append(name, value);

    const input = control(field);
    input.dataset.key = field.key;
    input.addEventListener(field.type === 'select' || field.type === 'toggle' ? 'change' : 'input', () => {
      const raw = field.type === 'toggle' ? input.checked : input.value;
      const config = agent.configure({ [field.key]: raw });
      saveConfig(config);
      syncFields();
    });

    const help = document.createElement('span');
    help.className = 'hint';
    help.textContent = field.help;

    row.append(head, input, help);
    dom.fields.append(row);
  }
}

/* The agent is the source of truth: every control is redrawn from the snapshot
 * it returns, so a clamped or rejected value visibly snaps back. */
function syncFields() {
  const config = agent.config;

  for (const field of Agent.schema) {
    const input = dom.fields.querySelector(`[data-key="${field.key}"]`);
    const readout = dom.fields.querySelector(`[data-readout="${field.key}"]`);
    const value = config[field.key];

    if (input && input !== document.activeElement) {
      if (field.type === 'toggle') input.checked = value;
      else input.value = value;
    }
    if (readout) {
      readout.textContent = field.type === 'toggle'
        ? (value ? 'on' : 'off')
        : (field.type === 'textarea' ? `${String(value).length} chars` : value);
    }
  }

  const rows = [
    ['transport', agent.transport.label],
    ['endpoint', agent.transport.endpoint],
    ['messages held', `${agent.history.length}`],
    ['context window', `${count(MODELS[config.model] ? MODELS[config.model].context : 0)} tokens`],
    ['output ceiling', `${count(MODELS[config.model] ? MODELS[config.model].maxOutput : 0)} tokens`],
  ];
  const facts = MODELS[config.model];
  if (facts && facts.note) rows.push([facts.stub ? 'not a real model' : 'note', facts.note]);
  dom.readonly.replaceChildren();
  const title = document.createElement('p');
  title.className = 'readonly-title';
  title.textContent = 'not configurable';
  dom.readonly.append(title);
  for (const [label, value] of rows) {
    const row = document.createElement('p');
    row.className = 'readonly-row';
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('span');
    val.textContent = value;
    row.append(key, val);
    dom.readonly.append(row);
  }
}

/* Task 8 ended this line on "billed again on the next turn", which was the
 * honest thing to say when everything in memory was resent at full price.
 * It is no longer necessarily true, so the line says which half is which. */
function memoryLine() {
  if (!counter || !agent) return '';
  const held = agent.history.length;
  const carried = counter.countMessages(agent.history, agent.config.model);
  if (!held) return '';
  const selection = compressor.select(agent.history);
  if (!selection.summary) {
    return `${plural(held, 'message')} ≈ ${count(carried)} tokens in memory`;
  }
  const versus = agent.counterfactual('');
  return `${plural(held, 'message')} in memory · ${selection.folded} of them as a `
    + `${count(versus.summaryTokens)}-token summary · ${count(versus.actual)} sent `
    + `where full would send ${count(versus.full)}`;
}

function syncStats() {
  const stats = agent.stats;
  if (!stats.turns && !stats.failed) {
    dom.stats.textContent = agent.history.length
      ? `restored · ${memoryLine()}`
      : 'no turns yet';
    return;
  }
  const parts = [
    `${stats.turns} turn${stats.turns === 1 ? '' : 's'}`,
    memoryLine(),
    `${stats.promptTokens} in / ${stats.completionTokens} out`
      + (stats.reasoningTokens ? ` (${stats.reasoningTokens} thinking)` : ''),
    `${stats.cacheHitTokens} cached`,
    money(stats.cost),
    seconds(stats.elapsed),
  ].filter(Boolean);
  // Folding is billed, so it is in the total above. It gets its own clause so
  // that nobody reads the total as the price of answering questions.
  if (stats.folds) {
    parts.push(`${plural(stats.folds, 'fold')} · ${count(stats.foldTokens)} tok · `
      + `${money(stats.foldCost)}`);
  }
  if (stats.foldFailures) parts.push(`${stats.foldFailures} folds failed`);
  // Same treatment for extraction, and it is the more dangerous of the two:
  // once per user message rather than once per ten, which is a bill that can
  // quietly outgrow what the strategy saves.
  if (stats.extractions) {
    parts.push(`${plural(stats.extractions, 'extraction')} · ${count(stats.extractTokens)} tok · `
      + `${money(stats.extractCost)}`);
  }
  if (stats.factsRejected) parts.push(`${stats.factsRejected} refused`);
  if (stats.extractFailures) parts.push(`${stats.extractFailures} extractions failed`);
  if (stats.failed) parts.push(`${stats.failed} failed`);
  dom.stats.textContent = parts.join(' · ');
}

/* ---------- debug tab ---------- */

const SUMMARY = {
  'agent:new': (e) => `${e.config.name} on ${e.config.model} · transport ${e.transport}`,
  configure: (e) => e.changed
    .map((change) => `${change.field}: ${clip(change.from, 24)} → ${clip(change.to, 24)}`)
    .join(' · '),
  'turn:start': (e) => `“${clip(e.text, 56)}” · ${e.historyLength} in memory`,
  'memory:trim': (e) => `dropped ${e.dropped} for good, kept ${e.kept} · ${e.because} · `
    + `~${e.estimatedTokens}/${e.budget} tokens`,
  'memory:fold': (e) => `folding ${plural(e.messages, 'message')} (${e.from}–${e.to}) · `
    + `${e.reason}${e.previousGeneration ? ` · rolling in generation ${e.previousGeneration}` : ''}`,
  'memory:summarise': (e) => `generation ${e.generation} · ${e.model} · `
    + `~${count(e.estimatedPrompt)} in, ${count(e.budget)}-token ceiling`,
  'memory:summary': (e) => `generation ${e.generation} · ${count(e.foldedTokens)} tokens of `
    + `history → ${count(e.tokens)} · saves ${count(e.savedPerTurn)}/turn · `
    + `cost ${count(e.spentTokens)} tokens`
    + (e.breakEvenTurns != null ? ` · pays for itself in ${plural(e.breakEvenTurns, 'turn')}` : '')
    + (e.truncated ? ' · CUT OFF at the ceiling' : ''),
  'memory:fold-failed': (e) => `${e.message} · ${plural(e.messagesAtRisk, 'message')} kept, `
    + 'nothing lost, this turn goes out uncompressed',
  'facts:extract': (e) => `turn ${e.turn} · ${e.model} · ${plural(e.known, 'fact')} known · `
    + `~${count(e.estimatedPrompt)} in`,
  'facts:written': (e) => {
    const written = e.written.map((entry) => `${entry.from === 'assistant' ? '*' : ''}`
      + (entry.outcome === 'updated'
        ? `${entry.key} = ${clip(entry.value, 24)} (was ${clip(entry.previous, 20)})`
        : `${entry.key} = ${clip(entry.value, 24)}`));
    const refused = e.rejected.map((entry) => `${entry.key || '—'}: ${entry.reason}`);
    return [
      written.length ? written.join(' · ') : 'nothing worth storing',
      refused.length ? `refused ${refused.join(' · ')}` : '',
      `${count(e.spentTokens)} tok`,
    ].filter(Boolean).join(' · ');
  },
  'facts:failed': (e) => `${e.message} · ${plural(e.known, 'fact')} kept, nothing lost, `
    + 'the next turn goes out with the block it already had',
  'branch:checkpoint': (e) => `“${e.label}” · ${e.branch} at message ${e.index}`,
  'branch:fork': (e) => `${e.name} · from ${e.from} at message ${e.at} · `
    + `carrying ${plural(e.facts, 'fact')}`
    + (e.summaries ? ` and ${plural(e.summaries, 'summary', 'summaries')}` : ''),
  'branch:switch': (e) => `${e.from} → ${e.to} · ${plural(e.messages, 'message')} `
    + `(${e.base} of them its parent's) · ${plural(e.facts, 'fact')}`,
  'memory:sent': (e) => `${e.sentVerbatim} verbatim`
    + (e.facts ? ` + ${plural(e.facts, 'fact')} (${count(e.factsTokens)} tok`
      + `${e.factsDropped ? `, ${e.factsDropped} over the ceiling` : ''})` : '')
    + (e.summarised ? ` + ${e.summarised} summarised (gen ${e.generation})` : '')
    + (e.dropped ? ` · ${e.dropped} dropped` : '')
    + (e.pending ? ` · ${e.pending} awaiting the next fold` : '')
    + ` · ${count(e.actuallySent)} sent where full would have sent ${count(e.wouldHaveSent)}`
    + (e.saved > 0 ? ` (${percent(e.ratio)} less)` : ''),
  request: (e) => `${e.body.messages.length} messages · ${e.body.model} · temp ${e.body.temperature}`,
  'first-token': (e) => `${e.afterMs} ms to first token (${e.kind})`,
  retry: (e) => `attempt ${e.attempt}/${e.of} · ${e.status ? `HTTP ${e.status}` : 'network'} · waiting ${e.delayMs} ms`,
  response: (e) => {
    const usage = e.usage || {};
    const reasoning = usage.reasoningTokens ? ` (${usage.reasoningTokens} thinking)` : '';
    return `${e.finishReason || '—'} · ${usage.promptTokens || 0} in / ${usage.completionTokens || 0} out`
      + `${reasoning} · ${usage.cacheHitTokens || 0} cached · ${money(e.cost)} · ${seconds(e.elapsed)}`;
  },
  'turn:end': (e) => `${e.ok ? 'ok' : 'failed'} · ${(e.totalMs / 1000).toFixed(2)}s · ${e.historyLength} in memory`,
  error: (e) => `${e.status ? `HTTP ${e.status} · ` : ''}${e.message}`,
  aborted: () => 'stopped by the user',
  reset: (e) => `forgot ${e.forgotten} messages`
    + (e.generations ? ` and ${plural(e.generations, 'summary', 'summaries')} of them` : '')
    + (e.facts ? ` and ${plural(e.facts, 'fact')} about them` : ''),
  'agent:restored': (e) => `${plural(e.messages, 'message')} back in memory`
    + (e.generations ? ` · ${e.folded} of them compressed into generation ${e.generations}` : '')
    + (e.facts ? ` · ${plural(e.facts, 'fact')} about them` : '')
    + (e.savedAt ? ` · saved ${relative(e.savedAt)}` : '')
    + (e.heldUnder ? ` · held under ${e.heldUnder.name} on ${e.heldUnder.model}` : ''),
  'store:save': (e) => `${e.id} · ${plural(e.messages, 'message')}`
    + (e.summaries ? ` + ${plural(e.summaries, 'summary', 'summaries')}` : '')
    + ` · ${size(e.bytes)}`,
  'store:remove': (e) => `${e.id} deleted`,
  'store:import': (e) => `${plural(e.messages, 'message')} in`
    + (e.renamed ? ' · id was taken, given a fresh one' : ''),
  'store:unreadable': (e) => `${e.key} · ${e.kind} · ${e.message}`,
  'tokens:preflight': (e) => `${count(e.prompt)} prompt + ${count(e.reserved)} reserved `
    + `= ${count(e.total)} of ${count(e.limit)} (${percent(e.fraction)}) · `
    + `${e.messages} carried${e.dropped ? `, ${e.dropped} dropped` : ''}`,
  'tokens:settled': (e) => `${count(e.estimated)} guessed / ${count(e.actual)} billed `
    + `(${signed(e.drift)}) · ${count(e.completion)} out · ${money(e.cost)} · `
    + `${money(e.cumulativeCost)} this run`,
  'tokens:overflow': (e) => `over by ${count(e.over)} of ${count(e.limit)} · `
    + `memory: ${e.memoryPolicy} · then: ${e.policy}`,
  'tokens:truncated': (e) => `finish_reason: length · stopped at the ${e.ceiling}-token ceiling`,
  'tokens:starved': (e) => `${count(e.completion)} tokens written, ${count(e.reasoning)} of them `
    + `reasoning, none of them content · ${e.ceiling}-token ceiling · ${money(e.cost)} for nothing`,
};

function matchesFilter(event, filter) {
  if (!filter) return true;
  if (filter === 'tokens') return event.type.startsWith('tokens:');
  if (filter === 'memory') return event.type.startsWith('memory:');
  if (filter === 'facts') return event.type.startsWith('facts:');
  if (filter === 'branch') return event.type.startsWith('branch:');
  if (filter === 'problems') return event.type === 'retry' || event.type === 'error';
  if (filter === 'storage') {
    return event.type.startsWith('store:') || event.type === 'agent:restored';
  }
  return event.type === filter;
}

function eventRow(event) {
  const row = document.createElement('div');
  row.className = `event kind-${event.type.replace(':', '-')}`;
  row.dataset.type = event.type;

  const head = document.createElement('div');
  head.className = 'event-head';

  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = clock(event.at);

  const turn = document.createElement('span');
  turn.className = 'event-turn';
  turn.textContent = event.turn ? `t${event.turn}` : '—';

  const type = document.createElement('span');
  type.className = 'event-type';
  type.textContent = event.type;

  head.append(time, turn, type);

  const summary = document.createElement('div');
  summary.className = 'event-summary';
  const describe = SUMMARY[event.type];
  summary.textContent = describe ? describe(event) : '';

  const details = document.createElement('details');
  const label = document.createElement('summary');
  label.textContent = 'payload';
  const body = document.createElement('pre');
  const { seq, at, turn: turnNumber, type: kind, ...rest } = event;
  body.textContent = JSON.stringify(rest, null, 2);
  details.append(label, body);

  row.append(head, summary, details);
  return row;
}

function record(event) {
  log.push(event);
  if (log.length > MAX_EVENTS) log = log.slice(-MAX_EVENTS);

  const row = eventRow(event);
  if (!matchesFilter(event, dom.filter.value)) row.hidden = true;
  dom.events.append(row);
  while (dom.events.children.length > MAX_EVENTS) dom.events.firstElementChild.remove();
  dom.events.scrollTop = dom.events.scrollHeight;

  if (event.type === 'configure' || event.type === 'turn:end' || event.type === 'reset') {
    syncFields();
    syncStats();
    syncTokens();
  }
  if (event.type === 'tokens:settled') saveCalibration();
}

function applyFilter() {
  const filter = dom.filter.value;
  for (const row of dom.events.children) {
    row.hidden = !matchesFilter({ type: row.dataset.type }, filter);
  }
}

/* ---------- chat ---------- */

function bubble(role, who, at) {
  dom.empty.hidden = true;

  const wrap = document.createElement('div');
  wrap.className = `turn ${role}`;

  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who;

  if (Number.isFinite(at)) {
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = clock(at).slice(0, 5);
    label.append(' ', when);
  }

  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.hidden = true;

  const body = document.createElement('div');
  body.className = 'body';

  const note = document.createElement('div');
  note.className = 'token-note';
  note.hidden = true;

  wrap.append(label, thinking, body, note);
  dom.log.append(wrap);
  dom.log.scrollTop = dom.log.scrollHeight;

  let text = '';
  let thought = '';
  return {
    append(chunk, kind) {
      if (kind === 'reasoning') {
        thought += chunk;
        thinking.hidden = false;
        thinking.textContent = thought;
      } else {
        text += chunk;
        body.textContent = text;
      }
      dom.log.scrollTop = dom.log.scrollHeight;
    },
    set(value) {
      text = value;
      body.textContent = value;
    },
    render() {
      if (!text.trim()) {
        body.textContent = '(no content)';
        return;
      }
      body.innerHTML = renderMarkdown(text);
      body.classList.add('rendered');
      dom.log.scrollTop = dom.log.scrollHeight;
    },
    fail(message) {
      wrap.classList.add('failed');
      body.classList.remove('rendered');
      body.textContent = message;
    },
    note(text, kind) {
      note.hidden = !text;
      note.textContent = text || '';
      note.className = `token-note${kind ? ` ${kind}` : ''}`;
    },
  };
}

// ---------------------------------------------------------------------------
/* ---------- branches ----------
 *
 * Three functions, and between them they are the third strategy. The tree does
 * the arithmetic and the agent holds one conversation at a time; this is the
 * only place that knows both, and it is deliberately small, because every line
 * here is a line that could let one branch write to another.
 *
 * The live branch is whatever the agent is currently holding. Nothing is copied
 * into the tree until the moment it might be needed there — before a fork,
 * before a switch, before a save — and that moment is always `settle()`.
 */

function settle() {
  if (!tree || !agent) return;
  // The compressed half travels with the messages. Which half that is depends
  // on the policy, and the tree does not care: it is one opaque blob either way.
  tree.commit(tree.head, { messages: agent.history, memory: agent.snapshot().memory });
}

/* A checkpoint is a place, and the tree can only see places it has been told
 * about — so this settles first. Marking the live conversation without doing
 * that would name an index in a branch the tree still believes is empty, and
 * the checkpoint would quietly land at zero. */
function markHere(label, { at = null } = {}) {
  settle();
  const point = tree.mark(at == null ? agent.history.length : at, { label });
  record({
    seq: 0, at: Date.now(), turn: 0, type: 'branch:checkpoint',
    label: point.label, index: point.at, branch: tree.branch(point.branch).name,
  });
  return point;
}

/* A fork carries the memory as it was at the fork, not as it is now.
 *
 * The facts are rewound by index, which is exact — every version of every fact
 * knows the message it was written at. The summary chain cannot be rewound,
 * because prose does not come apart again, so a fold that reaches past the fork
 * point is dropped rather than inherited: a summary covering messages this
 * branch will never have is a description of somebody else's conversation.
 */
function forkAt(at, { name = '', from = null, note = '' } = {}) {
  settle();
  const memory = agent.snapshot().memory;
  const rewound = {
    ...memory,
    facts: facts ? facts.rewind(at) : null,
    ...(memory.folded <= at ? {} : { folded: 0, summaries: [] }),
  };
  const created = tree.fork({ from, at, name, memory: rewound, note });
  record({
    seq: 0, at: Date.now(), turn: 0, type: 'branch:fork',
    id: created.id, name: created.name, at: created.forkIndex,
    from: tree.branch(from || tree.head).name,
    facts: rewound.facts ? rewound.facts.facts.length : 0,
    summaries: rewound.summaries.length,
  });
  return created;
}

function switchTo(id) {
  if (agent.busy) throw new Error('The agent is mid-turn — the branch stays where it is.');
  settle();
  const from = tree.branch(tree.head);
  const out = tree.checkout(id);
  agent.restore({ messages: out.messages, memory: out.memory || null });
  record({
    seq: 0, at: Date.now(), turn: 0, type: 'branch:switch',
    from: from.name, to: tree.branch(id).name,
    messages: out.messages.length, base: out.base,
    facts: agent.facts ? agent.facts.size : 0,
  });
  return out;
}

// Persistence. Everything below goes through agent.snapshot() and
// agent.restore(); nothing here has ever seen agent._messages.
// ---------------------------------------------------------------------------

function banner(kind, text, actions = []) {
  dom.banner.className = `banner ${kind}`;
  dom.banner.replaceChildren();

  const line = document.createElement('span');
  line.className = 'banner-text';
  line.textContent = text;
  dom.banner.append(line);

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    dom.banner.append(button);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'banner-close';
  close.textContent = '×';
  close.title = 'dismiss';
  close.addEventListener('click', () => { dom.banner.hidden = true; });
  dom.banner.append(close);

  dom.banner.hidden = false;
}

// What the conversation was held under. Recorded on every save, shown on
// restore, and never applied — a stored file does not get to reconfigure a
// live agent.
function provenanceOf() {
  const config = agent.config;
  return {
    model: config.model,
    name: config.name,
    systemPrompt: config.systemPrompt,
    transport: agent.transport.id,
  };
}

function provenanceDrift(record) {
  if (!record || !record.provenance) return [];
  const now = provenanceOf();
  const drift = [];
  for (const key of ['name', 'model', 'transport']) {
    const was = record.provenance[key];
    if (was && was !== now[key]) drift.push(`${key} was ${was}, now ${now[key]}`);
  }
  if (record.provenance.systemPrompt && record.provenance.systemPrompt !== now.systemPrompt) {
    drift.push('the system prompt has changed since');
  }
  return drift;
}

function capture(pending) {
  settle();
  const snapshot = agent.snapshot();
  return {
    ...session,
    messages: snapshot.messages.map((message) => ({ ...message })),
    // Stored beside the messages, never inside them. A conversation restored
    // without its summary quietly goes back to full price; a summary restored
    // without its cut point sends the folded messages twice.
    memory: snapshot.memory
      && (snapshot.memory.summaries.length
        || (snapshot.memory.facts && snapshot.memory.facts.facts.length))
      ? snapshot.memory
      : null,
    /* One branch is not a tree, and a conversation that never forked writes
     * exactly the record task 9 wrote. The field appears the moment there is
     * something in it that `messages` cannot say. */
    branches: tree && tree.size > 1 ? tree.snapshot() : null,
    provenance: provenanceOf(),
    pending: pending === undefined ? (session.pending || null) : pending,
  };
}

function persist(pending) {
  if (!store || !session) return null;
  try {
    session = { ...store.save(capture(pending)), stored: true };
    store.setLastActiveId(session.id);
  } catch (error) {
    banner('warn', error.message);
    return null;
  }
  renderSessions();
  syncSessionBar();
  return session;
}

function forgetIfEmpty() {
  if (session && session.stored && !agent.history.length) {
    store.remove(session.id);
    session = { ...session, stored: false, pending: null };
    renderSessions();
    syncSessionBar();
  }
}

function replay(messages) {
  dom.log.replaceChildren(dom.empty);
  dom.empty.hidden = messages.length > 0;

  for (const message of messages) {
    const mine = message.role === 'user';
    const view = bubble(mine ? 'user' : 'agent', mine ? 'you' : agent.config.name, message.at);
    view.set(message.content);
    if (!mine) view.render();
  }
  dom.log.scrollTop = dom.log.scrollHeight;
}

function announce(record) {
  if (!record.messages.length) {
    dom.banner.hidden = true;
    return;
  }
  const drift = provenanceDrift(record);
  const text = `Restored ${plural(record.messages.length, 'message')} from ${relative(record.updatedAt)}.`
    + (drift.length
      ? ` This conversation was held under a different agent — ${drift.join('; ')}. Nothing was changed for you.`
      : '');
  banner(drift.length ? 'warn' : 'ok', text);
}

// A pending marker is written before a request goes out and cleared when the
// turn ends, however it ends. What survives an abrupt close is therefore
// exactly a turn that never finished.
function offerPending(record) {
  const pending = record.pending;
  if (!pending || !pending.text) return;

  banner('pending',
    `Turn ${pending.turn} was interrupted ${relative(pending.startedAt)} — you asked `
      + `“${clip(pending.text, 70)}” and never got an answer.`,
    [
      {
        label: 'Ask it again',
        run: () => {
          dom.banner.hidden = true;
          session = { ...(store.clearPending(session.id) || session), stored: true };
          dom.input.value = pending.text;
          renderSessions();
          submit();
        },
      },
      {
        label: 'Discard',
        run: () => {
          dom.banner.hidden = true;
          session = { ...(store.clearPending(session.id) || session), stored: true };
          renderSessions();
          syncSessionBar();
        },
      },
    ]);
}

function adopt(record, { announced = true } = {}) {
  session = { ...record, stored: true };
  agent.restore({
    messages: record.messages,
    memory: record.memory || null,
    savedAt: record.updatedAt,
    config: record.provenance,
    transport: record.provenance ? record.provenance.transport : null,
  });

  /* The tree comes back, or it is built. A v2 record — and every conversation
   * that never forked — has no tree, and the honest reading of that is not
   * "branches are missing" but "there is one branch, and it is this
   * conversation", which is what every conversation was until this task. */
  tree = new BranchTree();
  if (!(record.branches && tree.restore(record.branches))) {
    tree.commit(tree.head, { messages: record.messages, memory: record.memory || null });
  }
  replay(record.messages);
  store.setLastActiveId(record.id);

  syncSessionBar();
  syncFields();
  syncStats();
  renderSessions();

  syncTokens();

  if (announced) announce(record);
  offerPending(record);
}

function newSession() {
  agent.reset();
  tree = new BranchTree();
  session = store.create({ provenance: provenanceOf() });
  store.setLastActiveId(null);
  dom.log.replaceChildren(dom.empty);
  dom.empty.hidden = false;
  dom.banner.hidden = true;
  syncSessionBar();
  syncFields();
  syncStats();
  renderSessions();
  syncTokens();
  dom.input.focus();
}

function nameOf(record) {
  return (record && record.title) || 'Untitled conversation';
}

function syncSessionBar() {
  if (!session) return;
  if (dom.title !== document.activeElement) dom.title.value = session.title || '';
  dom.title.placeholder = session.title ? '' : 'Untitled conversation';
  dom.sessionMeta.textContent = [
    plural(agent.history.length, 'message'),
    session.stored ? `saved ${relative(session.updatedAt)}` : 'not saved yet',
  ].join(' · ');
}

function sessionRow(record) {
  const row = document.createElement('div');
  row.className = 'session';
  if (session && record.id === session.id) row.classList.add('current');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'session-open';

  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = nameOf(record);

  const meta = document.createElement('span');
  meta.className = 'session-meta';
  const bits = [plural(record.messages.length, 'message')];
  bits.push(record.stored === false ? 'not saved yet' : relative(record.updatedAt));
  if (record.pending) bits.push('interrupted');
  meta.textContent = bits.join(' · ');

  open.append(name, meta);
  open.addEventListener('click', () => {
    if (agent.busy) return;
    if (session && record.id === session.id) return;
    const fresh = store.load(record.id);
    if (fresh) adopt(fresh);
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'session-delete';
  remove.textContent = 'Delete';
  remove.title = 'delete this conversation';
  remove.addEventListener('click', () => {
    if (agent.busy) return;
    if (record.stored !== false) store.remove(record.id);
    if (session && record.id === session.id) newSession();
    else renderSessions();
  });

  row.append(open, remove);
  return row;
}

function renderSessions() {
  if (!store) return;
  const records = store.list();

  // The current conversation appears in the list before its first turn has
  // been written, marked for what it is.
  if (session && !records.some((record) => record.id === session.id)) {
    records.unshift({ ...session, stored: false, messages: agent.history });
  }

  dom.sessions.replaceChildren();

  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nothing stored yet. The first turn writes one.';
    dom.sessions.append(empty);
  }

  for (const record of records) dom.sessions.append(sessionRow(record));

  for (const bad of store.corrupt) {
    const row = document.createElement('div');
    row.className = 'session broken';
    const text = document.createElement('span');
    text.className = 'session-open';
    text.textContent = `${bad.key} — ${bad.message}`;
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'session-delete';
    drop.textContent = 'Remove';
    drop.addEventListener('click', () => {
      store.removeKey(bad.key);
      renderSessions();
    });
    row.append(text, drop);
    dom.sessions.append(row);
  }

  renderStorage();
}

function renderStorage() {
  const usage = store.usage();
  dom.storage.replaceChildren();

  const title = document.createElement('p');
  title.className = 'readonly-title';
  title.textContent = 'storage';
  dom.storage.append(title);

  const rows = [
    ['backend', store.backend.label],
    ['schema', `v${SessionStore.version}`],
    ['sessions held', `${usage.sessions}`],
    ['bytes used', size(usage.bytes)],
    ['survives a reload', usage.persistent ? 'yes' : 'no'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('p');
    row.className = 'readonly-row';
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('span');
    val.textContent = value;
    row.append(key, val);
    dom.storage.append(row);
  }
}

function exportSession() {
  if (!session) return;
  const record = store.load(session.id) || capture();
  const blob = new Blob([store.serialise(record)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `task10-session-${record.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function importText(text) {
  try {
    const record = store.import(text);
    adopt(record, { announced: false });
    banner('ok', `Imported ${plural(record.messages.length, 'message')} as “${nameOf(record)}”.`);
  } catch (error) {
    banner('warn', `Import failed — ${error.message}`);
  }
}

function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importText(String(reader.result || ''));
  reader.onerror = () => banner('warn', 'Could not read that file.');
  reader.readAsText(file);
}

/* ---------- the tokens panel ---------- */

function readout(node, title, entries) {
  node.replaceChildren();
  if (title) {
    const head = document.createElement('p');
    head.className = 'readonly-title';
    head.textContent = title;
    node.append(head);
  }
  for (const [label, value, kind] of entries) {
    const row = document.createElement('p');
    row.className = `readonly-row${kind ? ` ${kind}` : ''}`;
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('span');
    val.textContent = value;
    row.append(key, val);
    node.append(row);
  }
}

// The window as a bar. When the request fits, the bar is the window and the
// tail is free space. When it does not, the bar becomes the request and the
// window is drawn across it as a line you have gone past.
function renderMeter(plan) {
  const scale = plan.overflow ? plan.total : plan.limit;
  /* The summary is inside plan.history — the counter does not know one message
   * from another — so it is pulled back out and drawn as its own band. It is
   * the one part of the bar that is not proportional to what it represents,
   * and a bar that hid it would be hiding the whole point. */
  const versus = agent.counterfactual(dom.input.value);
  const summaryTokens = Math.min(versus.summaryTokens, plan.history);
  const segments = [
    ['system', plan.system, 'seg-system'],
    ['summary', summaryTokens, 'seg-summary'],
    ['history', plan.history - summaryTokens, 'seg-history'],
    ['this message', plan.next, 'seg-next'],
    ['reserved for the reply', plan.reserved, 'seg-reserved'],
  ].filter(([, value]) => value > 0);

  dom.meter.replaceChildren();
  dom.meter.classList.toggle('over', plan.overflow);

  const bar = document.createElement('div');
  bar.className = 'meter-bar';

  for (const [label, value, kind] of segments) {
    if (!value) continue;
    const part = document.createElement('span');
    part.className = `meter-seg ${kind}`;
    part.style.width = `${(value / scale) * 100}%`;
    part.title = `${label}: ${count(value)} tokens`;
    bar.append(part);
  }

  if (!plan.overflow && plan.headroom > 0) {
    const free = document.createElement('span');
    free.className = 'meter-seg seg-free';
    free.style.width = `${(plan.headroom / scale) * 100}%`;
    free.title = `free: ${count(plan.headroom)} tokens`;
    bar.append(free);
  } else if (plan.overflow) {
    const edge = document.createElement('span');
    edge.className = 'meter-edge';
    edge.style.left = `${(plan.limit / scale) * 100}%`;
    edge.title = `${count(plan.limit)}-token limit`;
    bar.append(edge);
  }

  const caption = document.createElement('p');
  caption.className = 'meter-caption';
  caption.textContent = plan.overflow
    ? `${count(plan.total)} of ${count(plan.limit)} — over by ${count(plan.overflowBy)}`
    : `${count(plan.total)} of ${count(plan.limit)} · ${percent(plan.fraction)} · `
      + `${count(plan.headroom)} free`;

  const key = document.createElement('div');
  key.className = 'meter-key';
  for (const [label, value, kind] of segments) {
    if (!value) continue;
    const item = document.createElement('span');
    item.className = 'meter-key-item';
    const swatch = document.createElement('i');
    swatch.className = `meter-seg ${kind}`;
    const text = document.createElement('span');
    text.textContent = `${label} ${count(value)}`;
    item.append(swatch, text);
    key.append(item);
  }

  dom.meter.append(bar, caption, key);
}

function renderWindowRows(plan) {
  const transport = agent.transport.id;
  readout(dom.windowRows, 'if you sent it now', [
    ['prompt', `${count(plan.prompt)} tokens`],
    ['reply ceiling', `${count(plan.reserved)} tokens`
      + (agent.config.thinking === 'off' ? '' : ' · shared with the thinking')],
    ['model window', `${count(plan.limit)} tokens`],
    ['worst case', `${money(plan.worstCaseCost)}${transport === 'echo' ? ' (would have been)' : ''}`],
    ['verdict', plan.overflow ? `does not fit — over by ${count(plan.overflowBy)}` : 'fits',
      plan.overflow ? 'bad' : ''],
  ]);
}

function renderLedger(plan) {
  const rows = plan.historyRows;
  dom.ledger.replaceChildren();

  if (!rows.length) {
    dom.ledgerNote.textContent = 'Nothing in memory yet. The system prompt alone costs '
      + `${count(plan.system)} tokens, and you pay it every single turn.`;
    return;
  }

  /* These rows are what is carried, not what was said. Since task 9 those are
   * two different lists: the first row can be a summary standing in for
   * hundreds of messages, and the messages it stands in for are not here. */
  const room = plan.limit - plan.reserved - plan.system - plan.next - plan.priming;
  let cut = 0;
  if (plan.overflow && room > 0) {
    let used = 0;
    cut = rows.length;
    while (cut > 0 && used + rows[cut - 1].tokens <= room) {
      used += rows[cut - 1].tokens;
      cut -= 1;
    }
  }

  const selection = compressor.select(agent.history);
  dom.ledgerNote.textContent = `${plural(rows.length, 'message')} · ${count(plan.history)} tokens `
    + 'carried into every turn from here on'
    + (selection.folded
      ? ` · ${selection.folded} older ${selection.folded === 1 ? 'message is' : 'messages are'} `
        + `the first row, compressed`
      : '')
    + (cut ? ` · the first ${cut} would be dropped to make this one fit` : '');

  const widest = rows.reduce((max, row) => Math.max(max, row.tokens), 1);

  for (const row of rows) {
    const item = document.createElement('div');
    item.className = `lrow ${row.role}`;
    if (row.index < cut) item.classList.add('dropping');

    const head = document.createElement('div');
    head.className = 'lrow-head';

    const who = document.createElement('span');
    who.className = 'lrow-role';
    if (row.role === 'system') {
      who.textContent = `summary · gen ${compressor.generation}`;
      item.classList.add('summarised');
    } else {
      who.textContent = row.role === 'user' ? 'you' : agent.config.name;
    }

    const tokens = document.createElement('span');
    tokens.className = 'lrow-tokens';
    tokens.textContent = `${count(row.tokens)} tok`;

    const cumulative = document.createElement('span');
    cumulative.className = 'lrow-cum';
    cumulative.textContent = `Σ ${count(row.cumulative)}`;

    head.append(who, tokens, cumulative);

    const bar = document.createElement('span');
    bar.className = 'lrow-bar';
    bar.style.width = `${(row.tokens / widest) * 100}%`;

    const meta = document.createElement('span');
    meta.className = 'lrow-meta';
    meta.textContent = row.index < cut
      ? `${count(row.chars)} chars · dropped`
      : (row.role === 'system'
        ? `${count(row.chars)} chars · standing in for ${plural(selection.folded, 'message')}`
        : `${count(row.chars)} chars`);

    item.append(head, bar, meta);
    dom.ledger.append(item);
  }
}

// Prompt and completion per turn as stacked bars, cumulative spend as a line
// over the top. Two shapes, one point: the bars grow because the past is
// resent, the line bends because the bars grow.
function renderChart() {
  const rows = agent.ledger.rows;
  dom.chart.replaceChildren();

  if (rows.length < 1) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'One turn draws a bar. Three draw a trend. Twenty draw the point.';
    dom.chart.append(hint);
    return;
  }

  const width = 320;
  const height = 132;
  const pad = { top: 10, right: 8, bottom: 16, left: 30 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const peak = Math.max(...rows.map((row) => row.promptTokens + row.completionTokens), 1);
  const spend = Math.max(rows[rows.length - 1].cumulativeCost, 1e-9);
  const step = plotWidth / rows.length;
  const barWidth = Math.max(2, Math.min(18, step * 0.68));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart-svg');

  const make = (name, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };

  svg.append(make('line', {
    x1: pad.left, y1: pad.top + plotHeight, x2: width - pad.right, y2: pad.top + plotHeight,
    class: 'chart-axis',
  }));

  const points = [];
  rows.forEach((row, index) => {
    const x = pad.left + index * step + (step - barWidth) / 2;
    const promptHeight = (row.promptTokens / peak) * plotHeight;
    const answerHeight = (Math.max(0, row.completionTokens - row.reasoningTokens) / peak) * plotHeight;
    const thinkHeight = (row.reasoningTokens / peak) * plotHeight;

    svg.append(make('rect', {
      x, y: pad.top + plotHeight - promptHeight, width: barWidth, height: Math.max(0, promptHeight),
      class: 'chart-prompt',
    }));
    svg.append(make('rect', {
      x,
      y: pad.top + plotHeight - promptHeight - answerHeight,
      width: barWidth,
      height: Math.max(0, answerHeight),
      class: 'chart-out',
    }));
    svg.append(make('rect', {
      x,
      y: pad.top + plotHeight - promptHeight - answerHeight - thinkHeight,
      width: barWidth,
      height: Math.max(0, thinkHeight),
      class: 'chart-think',
    }));

    points.push([
      pad.left + index * step + step / 2,
      pad.top + plotHeight - (row.cumulativeCost / spend) * plotHeight,
    ]);
  });

  svg.append(make('polyline', {
    points: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
    class: 'chart-line',
  }));

  const top = make('text', { x: 2, y: pad.top + 4, class: 'chart-label' });
  top.textContent = count(peak);
  const bottom = make('text', { x: 2, y: pad.top + plotHeight, class: 'chart-label' });
  bottom.textContent = '0';
  const turnsLabel = make('text', {
    x: width - pad.right, y: height - 4, class: 'chart-label', 'text-anchor': 'end',
  });
  turnsLabel.textContent = `${plural(rows.length, 'turn')} · line = ${money(spend)} spent`;
  svg.append(top, bottom, turnsLabel);

  dom.chart.append(svg);
}

function renderTurns() {
  const rows = agent.ledger.rows;
  dom.turns.replaceChildren();
  if (!rows.length) return;

  const table = document.createElement('div');
  table.className = 'ttable';

  const header = document.createElement('div');
  header.className = 'trow thead';
  for (const label of ['t', 'prompt', 'out', 'cost', 'spent', 'est']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);

  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'trow';
    if (row.finishReason === 'length') line.classList.add('truncated');
    const cells = [
      `t${row.turn}`,
      count(row.promptTokens),
      count(row.completionTokens) + (row.finishReason === 'length' ? ' ✂' : ''),
      money(row.cost),
      money(row.cumulativeCost),
      signed(row.drift),
    ];
    for (const value of cells) {
      const cell = document.createElement('span');
      cell.textContent = value;
      line.append(cell);
    }
    table.append(line);
  }

  dom.turns.append(table);

  const summary = agent.ledger.summary();
  if (summary && summary.reasoningTokens) {
    const note = document.createElement('p');
    note.className = 'hint thinking-note';
    note.textContent = `${count(summary.completionTokens)} output tokens, `
      + `${count(summary.reasoningTokens)} of them reasoning `
      + `(${percent(summary.reasoningShare, 0)}) — billed as output, spent from the same `
      + 'ceiling as the answer, and never shown to you.';
    dom.turns.append(note);
  }
}

function renderCalibration(plan) {
  const status = counter.status(plan.model);
  const summary = agent.ledger.summary();
  const last = agent.ledger.rows[agent.ledger.rows.length - 1];

  readout(dom.calibration, null, [
    ['estimator', status.calibrated ? `calibrated ×${status.scale.toFixed(3)}` : 'uncalibrated (×1.000)'],
    ['samples', `${status.pooledSamples}`],
    ['last turn', last ? `${count(last.estimatedPrompt)} guessed / ${count(last.promptTokens)} billed` : '—'],
    ['last error', last ? signed(last.drift) : '—', last && Math.abs(last.drift || 0) > 0.1 ? 'bad' : ''],
    ['mean error', summary && summary.meanDrift != null ? signed(summary.meanDrift) : '—'],
  ]);
}

function renderProjection(plan) {
  const summary = agent.ledger.summary();
  const forecast = agent.ledger.project({
    model: plan.model,
    systemTokens: plan.system,
    reserved: plan.reserved,
    turns: 10,
  });

  if (!summary) {
    readout(dom.projection, null, [
      ['turns so far', '0'],
      ['note', 'Take a turn and this fills in.'],
    ]);
    return;
  }

  const tenth = forecast.points[forecast.points.length - 1];
  const multiple = summary.costOfFirstTurn > 0
    ? `${(summary.costOfLastTurn / summary.costOfFirstTurn).toFixed(1)}×`
    : '—';

  readout(dom.projection, null, [
    ['turns so far', `${summary.turns}`],
    ['prompt growth', `+${count(Math.round(summary.growthPerTurn))} tokens per turn`],
    ['this turn vs the first', `${multiple} the price`],
    ['spent', money(summary.cost)],
    ['10 more turns', `${count(tenth.prompt)}-token prompt · ${money(tenth.cost)} total`],
    ['window fills at', forecast.overflowAt
      ? `turn ${forecast.overflowAt} — ${plural(forecast.turnsLeft, 'turn')} from now`
      : 'not within 10 turns', forecast.overflowAt ? 'bad' : ''],
  ]);
}

// Which script you type in changes the price, so when it stops being English
// the composer says so rather than leaving you to wonder why a short sentence
// cost as much as a paragraph.
function scriptNote(typed, model) {
  if (!typed) return null;
  const parts = counter.breakdown(typed, model).parts
    .filter((part) => part.script !== 'latin' && part.chars > typed.length * 0.2);
  if (!parts.length) return null;
  const worst = parts.sort((a, b) => a.perToken - b.perToken)[0];
  return `mostly ${worst.script} · ~${worst.perToken} chars per token`;
}

function renderDraft(plan) {
  const typed = dom.input.value.trim();
  const parts = [
    typed ? `this message ≈ ${count(plan.next)} tokens` : 'nothing typed yet',
    scriptNote(typed, plan.model),
    `request ${count(plan.prompt)} + ${count(plan.reserved)} reserved`,
    `${percent(plan.fraction)} of ${count(plan.limit)}`,
    money(plan.worstCaseCost),
  ].filter(Boolean);
  dom.draft.textContent = parts.join(' · ');
  dom.draft.classList.toggle('over', plan.overflow);
  if (plan.overflow) {
    dom.draft.textContent = `does not fit — ${count(plan.total)} against a `
      + `${count(plan.limit)}-token window, over by ${count(plan.overflowBy)}`
      + ` · on send: ${agent.config.overflowPolicy}`;
  }
}

// Coalesced on a microtask rather than a frame: a background or unfocused tab
// throttles requestAnimationFrame, and a counter that stops counting when you
// look away is worse than no counter.
let tokenPending = false;
function syncTokens() {
  if (tokenPending) return;
  tokenPending = true;
  queueMicrotask(() => {
    tokenPending = false;
    if (!agent || !counter) return;
    const plan = agent.plan(dom.input.value);
    renderDraft(plan);
    renderMeter(plan);
    renderWindowRows(plan);
    renderLedger(plan);
    renderChart();
    renderTurns();
    renderCalibration(plan);
    renderProjection(plan);
    syncMemory();
  });
}

/* ---------- context tab ---------- */

/* The switch the brief asks for.
 *
 * It is the same field the config tab already has, drawn as five buttons
 * instead of a dropdown, because the thing this tab exists to show is what
 * changes when you move between them — and a control you have to go to another
 * tab to touch is a control nobody touches mid-conversation.
 *
 * Switching is deliberately not destructive in either direction. The facts stay
 * where they are when the policy moves off `facts`, and the summary stays where
 * it is when the policy moves off `compress`: both are half a conversation, and
 * a switch is a decision about what to send, not a decision to forget.
 */
const STRATEGIES = [
  ['none', 'stateless', 'Nothing but the system prompt and this message.'],
  ['full', 'everything', 'Every message, every turn. The ground truth, and the most expensive thing here.'],
  ['window', 'last N', 'Keep the last few, delete the rest. Task 8’s answer, and the control.'],
  ['compress', '+ summary', 'Keep the last few, summarise the rest. Task 9’s answer, kept so that “without a summary” is a measurement.'],
  ['facts', '+ facts', 'Keep the last few and a key/value block of what was said, quoted. One extraction request per user message.'],
];

function renderStrategy() {
  const current = agent.config.memoryPolicy;
  dom.strategy.replaceChildren();

  for (const [policy, label, help] of STRATEGIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `strategy-pick${policy === current ? ' on' : ''}`;
    button.title = help;
    const name = document.createElement('strong');
    name.textContent = policy;
    const sub = document.createElement('span');
    sub.textContent = label;
    button.append(name, sub);
    button.addEventListener('click', () => {
      if (policy === agent.config.memoryPolicy) return;
      saveConfig(agent.configure({ memoryPolicy: policy }));
      syncFields();
      syncTokens();
    });
    dom.strategy.append(button);
  }

  const help = (STRATEGIES.find((entry) => entry[0] === current) || [])[2] || '';
  const extra = current === 'facts'
    ? ` The extractor is ${agent.config.factsModel}, and the ceiling is `
      + `${agent.config.factsBudget} tokens.`
    : (current === 'compress'
      ? ` The summariser is ${agent.config.summaryModel}, folding every `
        + `${agent.config.compressEvery} messages.`
      : '');
  dom.strategyNote.textContent = `${help}${extra} Branching is underneath all of them: it `
    + 'does not change how much of the path goes up the wire, it changes which path there is.';
}

/* The facts, three ways: the block exactly as it goes up the wire, the table
 * behind it, and the counters that say whether the rule is doing anything.
 *
 * The revision column is the one worth looking at. A key/value store is the
 * only thing here that can say a fact *used to* be something else, and that is
 * the whole of its advantage over sending the conversation itself. */
function renderFacts() {
  const store = agent.facts;
  const policy = agent.config.memoryPolicy;
  dom.factsBlock.replaceChildren();
  dom.factsTable.replaceChildren();

  if (!store || !store.size) {
    dom.factsNote.textContent = policy === 'facts'
      ? 'Nothing stored yet. The extractor runs after every message you send, and a value '
        + 'it cannot quote from that message never reaches the store.'
      : `The policy is ${policy}, so nothing is being extracted. Anything already in the `
        + 'store stays here — a switch is a decision about what to send, not a decision to forget.';
    readout(dom.factsRows, null, []);
    return;
  }

  const block = store.block(agent.config.model);
  dom.factsNote.textContent = `${plural(store.size, 'fact')} · `
    + `${count(block.tokens)} of ${block.ceiling} tokens`
    + (block.truncated ? ` · ${block.dropped} did not fit and say so in the block` : '')
    + (policy === 'facts' ? '' : ' · not being sent under this policy');

  const body = document.createElement('pre');
  body.className = 'summary-body';
  // The exact text in the system slot, unprettified, for the same reason the
  // summary is shown raw: this is the page you come to when you want to check
  // what the model was actually told.
  body.textContent = block.text;
  dom.factsBlock.append(body);

  const head = document.createElement('div');
  head.className = 'frow fhead';
  for (const label of ['key', 'value', 'who', 'kind', 'turn', 'was']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.append(cell);
  }
  dom.factsTable.append(head);

  const sent = new Set(block.included.map((fact) => fact.key));
  for (const fact of store.table()) {
    const row = document.createElement('div');
    row.className = 'frow';
    if (fact.cleared) row.classList.add('cleared');
    else if (!sent.has(fact.key)) row.classList.add('over');
    const cells = [
      fact.key,
      fact.cleared ? 'retracted' : fact.value,
      // Who said it. The agent's own commitments are storable and are not the
      // same kind of claim as the user's, so they are labelled rather than
      // blended in — here and, with a star, in the block itself.
      fact.source.role === 'assistant' ? 'agent' : 'you',
      fact.kind,
      `#${fact.source.index == null ? '?' : fact.source.index}`,
      fact.history.length
        ? fact.history.map((entry) => clip(entry.value, 18)).join(' → ')
        : '',
    ];
    for (const value of cells) {
      const cell = document.createElement('span');
      cell.textContent = value;
      row.append(cell);
    }
    dom.factsTable.append(row);
  }

  const stats = store.stats;
  const rejected = store.rejectedCount;
  const settled = store.all().filter((fact) => fact.source.role === 'assistant').length;
  readout(dom.factsRows, null, [
    ['written / revised / restated', `${stats.written} · ${stats.updated} · ${stats.confirmed}`],
    ['settled by the agent', settled
      ? `${plural(settled, 'fact')} — marked * in the block`
      : 'none — everything here was stated by you'],
    ['retracted', String(stats.cleared)],
    /* The number that says whether the verbatim rule is load-bearing or
     * decorative. On the stub it is always zero, and that says nothing about a
     * real model — so the extractor is named beside it rather than left to be
     * assumed. */
    ['refused as not verbatim', rejected
      ? `${stats.rejected['not-verbatim']} of ${rejected} refusals · ${agent.config.factsModel}`
      : `none — ${agent.config.factsModel} never proposed a value it could not quote`,
    rejected ? 'bad' : ''],
    /* The other door, and it is worth its own row because it fails in the
     * opposite direction: a value that was genuinely said, filed under a key
     * that is about nothing. Nothing in the verbatim column would ever catch
     * it. */
    ...(stats.rejected['empty-key']
      ? [['refused as naming nothing',
        `${stats.rejected['empty-key']} · a key like “that” or “it”, on a value that was really said`,
        'bad']]
      : []),
    ['over the ceiling', block.dropped
      ? `${plural(block.dropped, 'fact')} held but not sent` : 'none'],
  ]);
}

/* The tree.
 *
 * Every row is a branch; the indent is its depth; the one in bold is the one
 * the agent is holding. Clicking a row switches to it, which means committing
 * what is on screen to the branch it belongs to first — the conversation is
 * never in two places, and it is never in none.
 */
function renderBranches() {
  const rows = tree.shape();
  dom.branchTree.replaceChildren();

  for (const row of rows) {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = `branch-row${row.head ? ' on' : ''}`;
    line.style.paddingLeft = `${8 + row.depth * 16}px`;
    line.disabled = row.head || agent.busy;

    /* The head's numbers come from the agent, not from the tree. The tree only
     * knows what it has been told, and what it has been told is everything up
     * to the last switch — so drawing the live branch from the tree would show
     * a conversation two messages shorter than the one on the screen beside
     * it. A render reads; committing here to make the numbers agree would be a
     * write hiding in a draw. */
    const length = row.head ? agent.history.length : row.length;
    const own = row.head ? Math.max(0, agent.history.length - row.forkIndex) : row.own;

    const name = document.createElement('strong');
    name.textContent = row.name;
    const meta = document.createElement('span');
    meta.textContent = row.parent
      ? `${plural(length, 'message')} · ${own} its own, from message ${row.forkIndex}`
      : `${plural(length, 'message')} · the trunk`;
    line.append(name, meta);
    line.addEventListener('click', () => {
      try {
        switchTo(row.id);
        replay(agent.history);
        persist(null);
        syncFields();
        syncStats();
        syncTokens();
      } catch (error) {
        banner('warn', error.message);
      }
    });
    dom.branchTree.append(line);
  }

  const points = tree.checkpoints();
  const here = tree.branch(tree.head);
  const rows2 = [
    ['branches', plural(rows.length, 'branch', 'branches')],
    ['holding', `${here.name} · ${plural(agent.history.length, 'message')}`
      + (here.parent ? ` · forked from ${tree.branch(here.parent).name}` : '')],
    ['checkpoints', points.length
      ? points.map((point) => `“${point.label}” at ${point.at} (${point.forks.length} forks)`).join(' · ')
      : 'none yet'],
  ];

  /* What a fork costs, against what it replaces. The alternative to branching
   * is not "a cheaper branch", it is a second conversation that has to be told
   * everything again — so the comparison is the prefix this branch reads for
   * free against the prefix a fresh session would have to be sent. */
  if (here.parent) {
    const shared = counter.countMessages(tree.path(here.parent).slice(0, here.forkIndex),
      agent.config.model);
    rows2.push(['inherited, not retyped', `${plural(here.forkIndex, 'message')} · `
      + `${count(shared)} tokens a fresh conversation would have to be told again`, 'good']);
  }
  readout(dom.branchRows, null, rows2);
}

/* ---------- memory tab ---------- */

/* The conversation as three quantities: what is being sent word for word, what
 * has been compressed into prose, and what has been deleted. Task 8 only ever
 * had two of these and called them both "dropped", which is why a trimmed
 * conversation and a compressed one looked the same in the panel right up
 * until somebody asked the model a question about the beginning. */
function renderSplit() {
  const held = agent.history.length;
  dom.split.replaceChildren();

  if (!held) {
    dom.splitRows.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Nothing said yet. Every message starts verbatim; what happens to it '
      + 'after that is the memory policy’s decision, and this is where it is shown.';
    dom.split.append(hint);
    return;
  }

  const selection = compressor.select(agent.history, { model: agent.config.model });
  const versus = agent.counterfactual(dom.input.value);
  const verbatim = selection.verbatim.length;
  /* Under `facts` there are two ways to be outside the window and the panel
   * refuses to draw them as one. A message that put something in the store is
   * still speaking in four words; a message that did not is gone, and calling
   * both of them "deleted" would let the policy take credit for every message
   * it threw away. */
  const distilled = selection.policy === 'facts'
    ? compressor.map(agent.history).filter((row) => row.state === 'distilled').length
    : 0;
  const bands = [
    ['summarised', selection.folded, 'band-summarised'],
    ['kept as facts', distilled, 'band-distilled'],
    ['verbatim', verbatim - selection.pending, 'band-verbatim'],
    ['awaiting the next fold', selection.pending, 'band-pending'],
    ['deleted', selection.dropped - distilled, 'band-dropped'],
  ].filter(([, value]) => value > 0);

  const bar = document.createElement('div');
  bar.className = 'split-bar';
  for (const [label, value, kind] of bands) {
    const part = document.createElement('span');
    part.className = `split-seg ${kind}`;
    part.style.width = `${(value / held) * 100}%`;
    part.title = `${label}: ${plural(value, 'message')}`;
    bar.append(part);
  }

  const key = document.createElement('div');
  key.className = 'split-key';
  for (const [label, value, kind] of bands) {
    const item = document.createElement('span');
    item.className = 'split-key-item';
    const swatch = document.createElement('i');
    swatch.className = `split-seg ${kind}`;
    const text = document.createElement('span');
    text.textContent = `${label} ${value}`;
    item.append(swatch, text);
    key.append(item);
  }
  dom.split.append(bar, key);

  const policy = agent.config.memoryPolicy;
  readout(dom.splitRows, null, [
    ['policy', policy],
    ['in memory', plural(held, 'message')],
    ['sent verbatim', plural(verbatim, 'message')],
    ['sent as summary', selection.folded
      ? `${plural(selection.folded, 'message')} as ${count(versus.summaryTokens)} tokens`
      : 'none'],
    ['sent as facts', selection.facts
      ? `${plural(selection.facts.included.length, 'fact')} as ${count(versus.factsTokens)} tokens`
        + `, out of ${plural(distilled, 'message')} that put one there`
      : 'none'],
    ['deleted for good', selection.dropped - distilled
      ? `${plural(selection.dropped - distilled, 'message')} — the model cannot see them`
      : 'none', selection.dropped - distilled ? 'bad' : ''],
    ['prompt this turn', `${count(versus.actual)} tokens`],
    ['full would send', `${count(versus.full)} tokens`,
      versus.saved > 0 ? 'good' : ''],
  ]);
}

function renderSummary() {
  const summary = compressor.summary;
  dom.summaryText.replaceChildren();

  if (!summary) {
    dom.summaryNote.textContent = agent.config.memoryPolicy === 'compress'
      ? `Nothing folded yet. The first fold happens once ${agent.config.compressEvery} messages `
        + `have piled up beyond the ${agent.config.keepRecent} kept verbatim.`
      : `The memory policy is ${agent.config.memoryPolicy}, so nothing is being summarised.`;
    return;
  }

  dom.summaryNote.textContent = `Generation ${summary.generation} · `
    + `${count(summary.tokens)} tokens standing in for ${plural(summary.foldedMessages, 'message')} `
    + `· written by ${summary.model} ${relative(summary.at)}`
    + (summary.generation > 1
      ? ` · it has been through the summariser ${summary.generation} times`
      : '');

  if (summary.truncated) {
    const warn = document.createElement('p');
    warn.className = 'summary-warn';
    warn.textContent = `This summary hit its ${agent.config.summaryBudget}-token ceiling and `
      + 'stopped where it stopped. Whatever came after that is gone.';
    dom.summaryText.append(warn);
  }

  const body = document.createElement('pre');
  body.className = 'summary-body';
  // Deliberately not rendered as markdown. This is the exact text sitting in
  // the system slot of every request, and the one place it must not be
  // prettified is the place you go to check what it says.
  body.textContent = summary.text;
  dom.summaryText.append(body);
}

function renderSaved() {
  const stats = agent.stats;
  const versus = agent.counterfactual(dom.input.value);
  const rows = [
    ['this turn', versus.full
      ? `${count(versus.actual)} instead of ${count(versus.full)} · ${percent(versus.ratio)} less`
      : '—', versus.saved > 0 ? 'good' : ''],
  ];

  if (stats.wouldHaveSent) {
    const ratio = 1 - stats.actuallySent / stats.wouldHaveSent;
    rows.push(
      ['sent so far', `${count(stats.actuallySent)} tokens`],
      ['full would have sent', `${count(stats.wouldHaveSent)} tokens`],
      ['saved across the run', `${count(stats.wouldHaveSent - stats.actuallySent)} tokens `
        + `· ${percent(ratio)}`, ratio > 0 ? 'good' : ''],
      // The number that is easy to quote and easy to quote dishonestly, so it
      // is stated with the folding bill already taken out of it.
      ['net of what folding cost',
        `${count(stats.wouldHaveSent - stats.actuallySent - stats.foldTokens)} tokens`,
        (stats.wouldHaveSent - stats.actuallySent - stats.foldTokens) > 0 ? 'good' : 'bad'],
    );
  }
  readout(dom.savedRows, null, rows);
}

/* What extraction has cost, and the question task 9 asked about folds asked
 * about a bill that arrives every turn instead of every tenth.
 *
 * The break-even here is a different shape from the summary's. A fold is one
 * payment that keeps paying; extraction is a standing charge, so the question
 * is not "when has this fold paid for itself" but "does the per-turn saving
 * exceed the per-turn charge at all" — and if it does, how many turns of that
 * gap are needed to clear what has been spent so far.
 */
function renderExtraction() {
  const stats = agent.stats;
  if (!stats.extractions && !stats.extractFailures) {
    readout(dom.extractRows, null, [['extraction',
      agent.config.memoryPolicy === 'facts'
        ? 'none yet — the first one runs after your next message'
        : 'not running under this policy']]);
    return;
  }

  const turns = Math.max(1, stats.turns);
  const perTurnCharge = stats.extractTokens / turns;
  const perTurnSaving = (stats.wouldHaveSent - stats.actuallySent) / turns;
  const net = stats.wouldHaveSent - stats.actuallySent - stats.extractTokens;
  const gap = perTurnSaving - perTurnCharge;

  const rows = [
    ['extractions', `${plural(stats.extractions, 'extraction')} · one per message you sent`],
    ['spent extracting', `${count(stats.extractTokens)} tokens · ${money(stats.extractCost)}`],
    ['time spent extracting', seconds(stats.extractElapsed)],
    ['it charges per turn', `${count(Math.round(perTurnCharge))} tokens`],
    ['it saves per turn', `${count(Math.round(perTurnSaving))} tokens`,
      gap > 0 ? 'good' : 'bad'],
  ];

  if (gap > 0) {
    const togo = Math.ceil(Math.max(0, -net) / gap);
    rows.push(['so it is ahead by', `${count(Math.round(gap))} tokens a turn`
      + (net >= 0 ? ' — already paid for itself' : ` · ${plural(togo, 'turn')} to go`),
    net >= 0 ? 'good' : '']);
  } else {
    rows.push(['so it never catches up', 'at this conversation’s length the extraction '
      + 'bill is larger than the window it saves', 'bad']);
  }

  rows.push(['the run, net of extraction', net >= 0
    ? `${count(net)} tokens ahead`
    : `${count(-net)} tokens behind`, net >= 0 ? 'good' : 'bad']);

  if (stats.factsRejected) {
    rows.push(['values refused', `${stats.factsRejected} — paid for and thrown away`, 'bad']);
  }
  if (stats.extractFailures) {
    rows.push([`${plural(stats.extractFailures, 'extraction')} failed`,
      'nothing was lost — those turns went out with the block they already had']);
  }
  readout(dom.extractRows, null, rows);
}

function renderFolds() {
  const stats = agent.stats;
  const savings = compressor.savings({ held: agent.history.length });

  if (!stats.folds && !stats.foldFailures) {
    readout(dom.foldRows, null, [['folds', 'none yet — nothing has been spent on compression']]);
    return;
  }

  /* Two questions that look like one. "Has the last fold earned its keep yet"
   * is about one fold and the turns since it; "is compression winning" is
   * about the whole run and is the counterfactual the agent has been
   * accumulating. Reporting either one under the other's name is how a panel
   * ends up contradicting itself on the same screen. */
  const net = stats.wouldHaveSent - stats.actuallySent - stats.foldTokens;
  const rows = [
    ['folds', plural(stats.folds, 'fold')],
    ['spent writing summaries', `${count(stats.foldTokens)} tokens · ${money(stats.foldCost)}`],
    ['time spent folding', seconds(stats.foldElapsed)],
    ['the latest fold cost', `${count(savings.spentOnLatest)} tokens`],
    ['and saves per turn', `${count(savings.savedPerTurn)} tokens`],
  ];

  if (savings.breakEvenTurns != null) {
    rows.push(['so it pays for itself in', plural(savings.breakEvenTurns, 'turn')]);
    rows.push(['turns since it was made', plural(savings.turnsSinceFold, 'turn')
      + (savings.paidOff ? ' — paid off' : ` — ${plural(
        savings.breakEvenTurns - savings.turnsSinceFold, 'turn')} to go`)]);
  }

  rows.push(['the run, net of folding', net >= 0
    ? `${count(net)} tokens ahead`
    : `${count(-net)} tokens behind — this conversation is too short to be worth compressing`,
  net >= 0 ? 'good' : 'bad']);
  if (stats.foldFailures) {
    rows.push([`${plural(stats.foldFailures, 'fold')} failed`,
      'nothing was lost — those turns went out uncompressed']);
  }
  readout(dom.foldRows, null, rows);
}

/* Summary size across folds. A rolling summary with no ceiling converges on
 * the length of the history it replaced, at which point you are paying for
 * both — so the interesting thing about this table is whether the middle
 * column stops climbing. */
function renderGenerations() {
  const rows = compressor.growth();
  dom.generations.replaceChildren();

  if (!rows.length) {
    dom.generationsNote.textContent = 'No folds yet.';
    return;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const foldedAll = rows.reduce((sum, row) => sum + row.foldedMessages, 0);
  dom.generationsNote.textContent = rows.length === 1
    ? `One fold · ${plural(foldedAll, 'message')} became ${count(last.tokens)} tokens. `
      + 'The column to watch is `out` — it is what stops a rolling summary from growing '
      + 'back into the history it replaced.'
    : `${plural(rows.length, 'fold')} · ${plural(foldedAll, 'message')} compressed · `
      + `the summary went from ${count(first.tokens)} tokens to ${count(last.tokens)}`
      + (last.tokens <= first.tokens * 1.5
        ? ' — bounded, which is what the ceiling is for'
        : ' — growing, which is what the ceiling is meant to stop');

  const table = document.createElement('div');
  table.className = 'gtable';

  const head = document.createElement('div');
  head.className = 'grow ghead';
  for (const label of ['gen', 'folded', 'in', 'out', 'saves/turn', 'cost', 'why']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);

  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'grow';
    if (row.truncated) item.classList.add('truncated');
    const cells = [
      String(row.generation),
      plural(row.foldedMessages, 'msg'),
      count(row.foldedTokens),
      count(row.tokens) + (row.truncated ? ' ✂' : ''),
      count(row.savedPerTurn),
      money(row.spentCost),
      row.reason,
    ];
    for (const value of cells) {
      const cell = document.createElement('span');
      cell.textContent = value;
      item.append(cell);
    }
    table.append(item);
  }
  dom.generations.append(table);
}

function syncMemory() {
  if (!agent || !compressor || !tree) return;
  renderStrategy();
  renderSplit();
  renderFacts();
  renderBranches();
  renderSaved();
  renderExtraction();
  renderFolds();
  renderSummary();
  renderGenerations();
}

/* ---------- the benchmark ----------
 *
 * The brief asks for a comparison of response quality with and without
 * compression. Reading a few replies and deciding which is nicer measures
 * nothing, so quality here is a number, and the number is graded.
 *
 * Facts are planted in a scripted conversation, buried under enough filler that
 * a six-message verbatim window cannot reach them, and then asked about. A
 * reply either contains the fact or it does not.
 *
 * Two things guard the score.
 *
 * Confabulation: some questions ask about facts that were never stated. A
 * confident answer to one of those is worse than forgetting, because a summary
 * that invents a plausible detail launders it into the system slot of every
 * future request. Those score against the run.
 *
 * Position: facts are planted at the start, in the middle and late, so the
 * table can tell "compression preserved it" apart from "it was never
 * compressed in the first place".
 */

/* One conversation, fifteen messages, and everything in it is the brief's own
 * list of what a facts block is for: a goal, constraints, preferences,
 * decisions, agreements. Two of them are revised later, which is the case this
 * whole task turns on and the one case where a strategy can beat `full`.
 *
 * The filler is not padding for its own sake. It is what buries a fact past the
 * verbatim window, and without it every policy scores the same because nothing
 * ever had to be remembered.
 */
const BENCH_SCRIPT = [
  { say: 'We are building an internal tool for tracking lab samples.' },
  { say: 'It has to run offline in the building — no cloud.' },
  { say: 'First demo is 4 March.' },
  { filler: 'Anyway, just checking in — nothing much to report.' },
  { say: 'I prefer metric units in every report.' },
  { say: 'The database is SQLite.' },
  { filler: 'Thanks, that is roughly what I expected.' },
  { say: 'Agreed: you write the schema, I write the import script.' },
  /* The only line in the script that plants nothing by itself. It assigns the
   * agent a piece of work, and what is worth remembering afterwards is in the
   * *reply* — which is the half of the dialogue a facts block that only reads
   * user messages cannot see. */
  { say: 'You take the import script.' },
  { say: 'Budget is 12000 euros, hard.' },
  { filler: 'Sure, carry on. No news at this end.' },
  { say: 'Change of plan — the demo moved to 11 March.' },
  { say: 'The staging box lives at 10.2.0.7.' },
  { filler: 'Fine by me. Let us keep going.' },
  { say: 'Scratch SQLite, we are going with Postgres.' },
  { say: 'Reports go to the lab manager, nobody else.' },
];

/* The questions.
 *
 * One rule governs every one of them, and it is what keeps this a measurement
 * of memory rather than of vocabulary: a question shares a content word with
 * the sentence that planted the fact *and* with the value the store ends up
 * holding. The oracle matches terms, so a question phrased in words that appear
 * in neither would score a strategy down for the stub's retrieval rather than
 * for what it forgot — and one phrased to match only the key, or only the
 * sentence, would quietly hand the round to one side.
 *
 * `stale` is the answer that was true earlier and is not true now. Answering
 * with it is not a partial credit, it is a wrong answer delivered
 * confidently — which is the failure mode a conversation holding both versions
 * cannot avoid.
 */
const BENCH_ASKS = [
  { at: 'start', ask: 'What is the tool for?', want: 'lab samples' },
  { at: 'start', ask: 'Where does it have to run?', want: 'offline' },
  { at: 'middle', ask: 'Which units do I prefer?', want: 'metric' },
  { at: 'middle', ask: 'What is the budget?', want: '12000 euros' },
  { at: 'late', ask: 'What address is staging on?', want: '10.2.0.7' },
  { at: 'late', ask: 'Who do reports go to?', want: 'lab manager' },
  // Nobody but the agent ever said this. Under a store that reads only the
  // user's half it is not lost, it was never there.
  { at: 'middle', ask: 'When will it be ready?', want: 'two days before the demo' },
  { at: 'revised', ask: 'When is the demo?', want: '11 March', stale: '4 March' },
  { at: 'revised', ask: 'Which database are we using?', want: 'Postgres', stale: 'SQLite' },
];

// Questions about things nobody said. The right answer is an admission.
const BENCH_TRAPS = [
  'What is the lab phone number?',
  'What did we decide about the mobile app?',
];

const BENCH_POLICIES = [
  { policy: 'full', note: 'Everything, every turn. The ground truth for recall, the ceiling for cost, and the only one that cannot tell a revision from a repetition.' },
  { policy: 'window', note: 'Keep the last few, delete the rest. Cheapest, and the control.' },
  { policy: 'compress', note: 'Task 9: keep the last few, summarise the rest. Here so that “without a summary” is a measurement rather than an instruction.' },
  { policy: 'facts', note: 'Keep the last few and a quoted key/value block. One extraction request per message, which is the bill this row has to justify.' },
];

/* The branch run is not a fifth row, and putting it in the same table would be
 * the first lie in the benchmark. The other four answer "how much of the path
 * goes up the wire" and can be ranked against each other on recall and tokens.
 * This one changes what the path is, so what it is measured on is different:
 * whether two continuations of one conversation stay out of each other. */
const BENCH_FORKS = [
  {
    name: 'march',
    say: ['Change of plan — the demo moved to 11 March.', 'Scratch SQLite, we are going with Postgres.'],
    expect: { 'When is the demo?': '11 March', 'Which database are we using?': 'Postgres' },
    leak: ['4 March', 'SQLite'],
  },
  {
    name: 'april',
    say: ['The demo is staying on 4 March.', 'SQLite stays, we cut the concurrency requirement.'],
    expect: { 'When is the demo?': '4 March', 'Which database are we using?': 'SQLite' },
    leak: ['11 March', 'Postgres'],
  },
];

let benchRuns = [];
let benchForks = null;
let benchBusy = false;

function benchWorking(isWorking, label) {
  benchBusy = isWorking;
  dom.benchRun.disabled = isWorking;
  dom.benchClear.disabled = isWorking;
  dom.benchStatus.textContent = label || '';
}

// One reply, graded. Nothing subjective survives this function: either the
// value is in the text or it is not.
function grade(reply, { want, stale }) {
  const has = (needle) => Boolean(needle) && reply.toLowerCase().includes(String(needle).toLowerCase());
  return {
    hit: has(want),
    // Only counted when the current answer is absent. A reply that says "moved
    // from 4 March to 11 March" has answered the question.
    stale: !has(want) && has(stale),
    from: /the facts block/.test(reply) ? 'facts'
      : (/compressed summary/.test(reply) ? 'summary'
        : (/verbatim/.test(reply) ? 'verbatim' : 'lost')),
  };
}

const BENCH_REFUSAL = /cannot answer|do not know|don’t know|no record|not in/i;

// Send one line and get the reply, drawn in the log like any other turn so the
// benchmark is watchable rather than a progress bar over a black box.
async function benchSay(text) {
  bubble('user', 'you', Date.now()).set(text);
  const view = bubble('agent', agent.config.name, Date.now());
  const result = await agent.send(text);
  view.set(result.reply);
  view.render();
  syncTokens();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return result;
}

async function benchOne(spec) {
  const restore = {
    memoryPolicy: agent.config.memoryPolicy,
    model: agent.config.model,
    summaryModel: agent.config.summaryModel,
    factsModel: agent.config.factsModel,
  };

  newSession();
  saveConfig(agent.configure({
    memoryPolicy: spec.policy,
    model: 'stub-16k',
    summaryModel: 'stub-16k',
    factsModel: 'stub-16k',
  }));
  syncFields();

  const outcome = {
    policy: spec.policy,
    note: spec.note,
    planted: { start: 0, middle: 0, late: 0, revised: 0 },
    recalled: { start: 0, middle: 0, late: 0, revised: 0 },
    from: {},
    stale: 0,
    confabulated: 0,
    ok: true,
    reason: '',
  };

  try {
    let step = 0;
    for (const line of BENCH_SCRIPT) {
      step += 1;
      benchWorking(true, `${spec.policy} · saying things · ${step}/${BENCH_SCRIPT.length}`);
      await benchSay(line.say || line.filler);
    }

    // Everything above was setup. Everything below is the measurement.
    for (const item of BENCH_ASKS) {
      benchWorking(true, `${spec.policy} · asking · ${clip(item.ask, 24)}`);
      outcome.planted[item.at] += 1;
      const result = await benchSay(item.ask);
      const mark = grade(result.reply, item);
      if (mark.hit) outcome.recalled[item.at] += 1;
      if (mark.stale) outcome.stale += 1;
      // Where an answer survived is as interesting as whether it did: it is
      // what separates "the strategy kept it" from "it was never out of the
      // window in the first place".
      outcome.from[item.want] = mark.hit ? mark.from : (mark.stale ? 'stale' : 'lost');
    }

    for (const trap of BENCH_TRAPS) {
      benchWorking(true, `${spec.policy} · trap · ${clip(trap, 24)}`);
      const result = await benchSay(trap);
      if (!BENCH_REFUSAL.test(result.reply)) outcome.confabulated += 1;
    }
  } catch (error) {
    outcome.ok = false;
    outcome.reason = error.message;
  }

  const rows = agent.ledger.rows;
  const stats = agent.stats;
  outcome.lastPrompt = rows.length ? rows[rows.length - 1].promptTokens : 0;
  // Everything the conversation cost, second requests included. A comparison
  // that leaves out the price of the memory it is comparing is an advert.
  outcome.billed = (rows.length ? rows[rows.length - 1].cumulativeTokens : 0)
    + stats.foldTokens + stats.extractTokens;
  outcome.foldTokens = stats.foldTokens;
  outcome.extractTokens = stats.extractTokens;
  outcome.folds = stats.folds;
  outcome.extractions = stats.extractions;
  outcome.refused = stats.factsRejected;
  outcome.fromAgent = facts.all().filter((fact) => fact.source.role === 'assistant').length;
  outcome.cost = stats.cost;
  outcome.generations = compressor.generation;
  outcome.facts = facts.size;

  persist(null);
  saveConfig(agent.configure(restore));
  syncFields();
  return outcome;
}

/* The branch run.
 *
 * One conversation up to the checkpoint, two continuations that disagree about
 * both revisions, and then the same two questions asked in each. Correct is two
 * different answers and no trace of either branch in the other.
 */
async function benchBranches() {
  const restore = {
    memoryPolicy: agent.config.memoryPolicy,
    model: agent.config.model,
    factsModel: agent.config.factsModel,
  };

  newSession();
  saveConfig(agent.configure({
    memoryPolicy: 'facts', model: 'stub-16k', factsModel: 'stub-16k',
  }));
  syncFields();

  const outcome = { forks: [], ok: true, reason: '', shared: 0, sharedTokens: 0, cold: 0, forked: 0 };

  try {
    const trunk = BENCH_SCRIPT.slice(0, 10);
    let step = 0;
    for (const line of trunk) {
      step += 1;
      benchWorking(true, `branches · the shared half · ${step}/${trunk.length}`);
      await benchSay(line.say || line.filler);
    }

    markHere('the argument');
    const root = tree.head;
    const at = agent.history.length;
    outcome.shared = at;
    outcome.sharedTokens = counter.countMessages(agent.history, agent.config.model);

    for (const fork of BENCH_FORKS) {
      benchWorking(true, `branches · ${fork.name}`);
      // Both forks come off the same checkpoint on the same branch, which is
      // the brief's "two branches from one place" rather than two branches that
      // happen to have been made at the same number.
      const created = forkAt(at, { name: fork.name, from: root });
      switchTo(created.id);
      replay(agent.history);

      if (!outcome.forked) {
        // What this branch's next turn costs, against what it would cost to
        // start the same conversation over — which is the actual alternative
        // to branching, and the reason the prefix being shared is the point.
        outcome.forked = agent.plan(fork.say[0]).prompt;
      }

      for (const line of fork.say) await benchSay(line);

      const marks = [];
      for (const [ask, want] of Object.entries(fork.expect)) {
        const result = await benchSay(ask);
        const reply = result.reply.toLowerCase();
        marks.push({
          ask,
          want,
          hit: reply.includes(want.toLowerCase()),
          // The failure this run exists to detect: the other branch's answer,
          // in this branch's mouth.
          leaked: fork.leak.filter((value) => reply.includes(value.toLowerCase())),
        });
      }
      outcome.forks.push({
        name: fork.name,
        branch: created.id,
        marks,
        facts: facts.all().map((fact) => `${fact.key} = ${fact.value}`),
        messages: agent.history.length,
      });
      switchTo(root);
      replay(agent.history);
    }

    // The cold comparison: the same next turn in a conversation that was never
    // told any of it.
    const cold = new Agent({
      transport: agent.transport.id === 'echo' ? TRANSPORTS[1] : TRANSPORTS[0],
      counter,
      compressor: new Compressor({ counter, facts: new FactStore({ counter }) }),
      ...agent.config,
      memoryPolicy: 'facts',
      model: 'stub-16k',
    });
    outcome.cold = cold.plan(BENCH_FORKS[0].say[0]).prompt;
  } catch (error) {
    outcome.ok = false;
    outcome.reason = error.message;
  }

  persist(null);
  saveConfig(agent.configure(restore));
  syncFields();
  return outcome;
}

async function runBench() {
  if (benchBusy || agent.busy) return;
  benchRuns = [];
  benchForks = null;
  renderBench();
  try {
    for (const spec of BENCH_POLICIES) {
      benchRuns.push(await benchOne(spec));
      renderBench();
    }
    benchForks = await benchBranches();
    renderBench();
  } finally {
    benchWorking(false, '');
    syncStats();
    syncTokens();
  }
}

function startBench() {
  if (agent.transport.id === 'echo') {
    runBench();
    return;
  }
  /* On a live transport this is well over a hundred requests — four
   * conversations of twenty-five turns, one of them paying for an extraction on
   * every one of them, plus the branch run. The offline stub answers only from
   * what it was given, which is precisely the property the quality column is
   * measuring. The free version is not a lesser version. */
  banner('warn',
    `The benchmark runs four conversations of about 25 turns each against `
    + `${agent.transport.label}, plus a branch run — well over a hundred billed `
    + 'requests, and one of the four pays for an extraction on every turn. The '
    + 'comparison it produces is visible on the echo transport for nothing.',
    [
      { label: 'Spend it', run: () => { dom.banner.hidden = true; runBench(); } },
      { label: 'Cancel', run: () => { dom.banner.hidden = true; } },
    ]);
}

function benchTable() {
  const total = BENCH_ASKS.length;
  const table = document.createElement('div');
  table.className = 'btable';

  const head = document.createElement('div');
  head.className = 'brow bhead';
  for (const label of ['policy', 'recall', 'start', 'mid', 'late', 'revised', 'stale', 'invented', 'last', 'billed', 'cost']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);

  for (const run of benchRuns) {
    const hits = Object.values(run.recalled).reduce((sum, value) => sum + value, 0);
    const row = document.createElement('div');
    row.className = 'brow';
    if (hits === total && !run.stale && !run.confabulated) row.classList.add('perfect');
    if (!hits) row.classList.add('amnesiac');

    const cells = [
      run.policy,
      `${hits}/${total}`,
      `${run.recalled.start}/${run.planted.start}`,
      `${run.recalled.middle}/${run.planted.middle}`,
      `${run.recalled.late}/${run.planted.late}`,
      `${run.recalled.revised}/${run.planted.revised}`,
      run.stale ? `${run.stale} stale` : 'none',
      run.confabulated ? `${run.confabulated} made up` : 'clean',
      count(run.lastPrompt),
      count(run.billed),
      money(run.cost),
    ];
    for (const value of cells) {
      const cell = document.createElement('span');
      cell.textContent = value;
      row.append(cell);
    }
    table.append(row);

    const second = run.extractions
      ? ` ${plural(run.extractions, 'extraction')}, ${count(run.extractTokens)} tokens spent, `
        + `${run.facts} facts held`
        + (run.fromAgent ? `, ${run.fromAgent} of them settled in the agent's own replies` : '')
        + `${run.refused ? `, ${run.refused} values refused` : ''}.`
      : (run.folds
        ? ` ${plural(run.folds, 'fold')}, ${count(run.foldTokens)} tokens spent writing `
          + `${plural(run.generations, 'generation')} of summary.`
        : '');
    const note = document.createElement('p');
    note.className = 'bnote';
    note.textContent = run.ok ? `${run.note}${second}` : `stopped: ${run.reason}`;
    table.append(note);

    const where = Object.entries(run.from);
    if (where.length) {
      const trail = document.createElement('p');
      trail.className = 'bwhere';
      trail.textContent = where.map(([fact, source]) => `${fact} → ${source}`).join(' · ');
      table.append(trail);
    }
  }
  return table;
}

function benchForkTable() {
  const wrap = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'bnote';
  title.textContent = benchForks.ok
    ? `Two branches off one checkpoint, ${benchForks.shared} messages in. Each was told the `
      + 'opposite of the other, and then both were asked the same two questions.'
    : `stopped: ${benchForks.reason}`;
  wrap.append(title);
  if (!benchForks.ok) return wrap;

  const table = document.createElement('div');
  table.className = 'btable';
  const head = document.createElement('div');
  head.className = 'brrow bhead';
  for (const label of ['branch', 'question', 'answered', 'leaked from the other branch']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);

  let leaks = 0;
  for (const fork of benchForks.forks) {
    for (const mark of fork.marks) {
      leaks += mark.leaked.length;
      const row = document.createElement('div');
      row.className = 'brrow';
      if (mark.hit && !mark.leaked.length) row.classList.add('perfect');
      if (mark.leaked.length) row.classList.add('amnesiac');
      for (const value of [
        fork.name,
        clip(mark.ask, 30),
        mark.hit ? mark.want : 'lost',
        mark.leaked.length ? mark.leaked.join(', ') : 'nothing',
      ]) {
        const cell = document.createElement('span');
        cell.textContent = value;
        row.append(cell);
      }
      table.append(row);
    }
    const note = document.createElement('p');
    note.className = 'bwhere';
    note.textContent = `${fork.name} holds: ${fork.facts.join(' · ')}`;
    table.append(note);
  }
  wrap.append(table);

  const verdict = document.createElement('p');
  verdict.className = 'bverdict';
  verdict.textContent = `${leaks === 0 ? 'No leaks' : `${plural(leaks, 'leak')}`}. `
    + `The second branch's next turn cost ${count(benchForks.forked)} tokens because it `
    + `reads ${plural(benchForks.shared, 'message')} it never had to be told; the same turn `
    + `in a fresh conversation costs ${count(benchForks.cold)} tokens and knows none of them. `
    + 'That gap is what branching is instead of: not a cheaper conversation, a second one '
    + 'that starts where the first stopped being agreed.';
  wrap.append(verdict);
  return wrap;
}

function renderBench() {
  dom.bench.replaceChildren();

  if (!benchRuns.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = benchBusy
      ? 'Running. Each policy gets its own conversation; the current one is left alone.'
      : `${BENCH_SCRIPT.length} messages of requirements — a goal, constraints, preferences, `
        + `decisions, agreements, two of them revised later — then ${BENCH_ASKS.length} `
        + `questions about them and ${BENCH_TRAPS.length} about things nobody said. `
        + 'Then the same conversation forked in two.';
    dom.bench.append(hint);
    return;
  }

  dom.bench.append(benchTable());

  /* The sentence the table is for, stated against the control rather than
   * against `full`: every policy beats full on cost, including the one that
   * remembers nothing, so beating full on cost is not news. */
  const byPolicy = Object.fromEntries(benchRuns.map((run) => [run.policy, run]));
  const score = (run) => Object.values(run.recalled).reduce((sum, value) => sum + value, 0);
  if (byPolicy.full && byPolicy.window && byPolicy.facts) {
    const verdict = document.createElement('p');
    verdict.className = 'bverdict';
    const total = BENCH_ASKS.length;
    const dearer = byPolicy.facts.billed - byPolicy.window.billed;
    verdict.textContent = `facts recalled ${score(byPolicy.facts)} of ${total} where window `
      + `recalled ${score(byPolicy.window)} and full recalled ${score(byPolicy.full)}`
      + (byPolicy.full.stale
        ? `, and full answered ${plural(byPolicy.full.stale, 'question')} with a value that `
          + 'had been revised — it was holding both and had no way to rank them'
        : '')
      + `. It sent ${count(byPolicy.facts.lastPrompt)} tokens on the last turn against full's `
      + `${count(byPolicy.full.lastPrompt)}, and cost ${count(Math.abs(dearer))} tokens `
      + `${dearer >= 0 ? 'more' : 'less'} than window across the run. `
      + (byPolicy.facts.billed > byPolicy.full.billed
        ? 'On a conversation this short it also cost more than sending everything: the '
          + 'extraction bill arrives every turn, and the window it saves has not grown '
          + 'large enough to pay for it.'
        : 'That difference is the price of remembering.');
    dom.bench.append(verdict);
  }

  const caveat = document.createElement('p');
  caveat.className = 'bnote';
  caveat.textContent = `Read the table with two things in mind. window deletes a message as `
    + `soon as it falls past ${agent.config.keepRecent}, while compress keeps it until the `
    + `next fold — up to ${agent.config.keepRecent + agent.config.compressEvery} messages `
    + 'verbatim — so some of what looks like compression working is a larger window, and the '
    + 'line under each row says which. And the oracle here matches terms: it has no notion of '
    + 'which of two sentences is the more recent, which is exactly why a payload holding both '
    + '"4 March" and "11 March" answers with whichever is shorter.';
  dom.bench.append(caveat);

  if (benchForks) dom.bench.append(benchForkTable());
}

/* ---------- the lab ---------- */

const FILLER = [
  'Summarise the trade-off between latency and cost when a conversation is resent in full on every turn.',
  'Explain why the prompt half of the bill grows while the completion half stays roughly flat.',
  'What changes if the same conversation is held in Russian rather than English, and why.',
  'Describe a caching strategy that would make the repeated prefix cheaper without losing the context.',
  'Walk through what a sliding window drops first and what that costs the answer.',
  'Compare truncating the oldest turns against summarising them into a single note.',
  'Give an example where dropping the earliest message silently changes the meaning of the reply.',
  'How would you decide, at runtime, that a conversation should be started over instead of continued.',
];

function labMessage(targetTokens, index) {
  const opener = FILLER[index % FILLER.length];
  let text = `Turn ${index + 1}. ${opener}`;
  let guard = 0;
  while (counter.estimate(text, agent.config.model) < targetTokens && guard < 400) {
    text += ` ${FILLER[(index + guard + 1) % FILLER.length]}`;
    guard += 1;
  }
  return text;
}

const LAB_RUNS = {
  short: {
    id: 'short',
    label: 'short · 3 turns',
    turns: 3,
    tokens: 40,
    note: 'Small talk. The bill is rounding error and the window is untouched.',
  },
  long: {
    id: 'long',
    label: 'long · 20 turns',
    turns: 20,
    tokens: 60,
    note: 'The same conversation, twenty turns deep. Watch the prompt column, not the reply column.',
  },
  overflow: {
    id: 'overflow',
    label: 'overflow · big turns on the small window',
    turns: 30,
    tokens: 700,
    model: 'stub-16k',
    note: 'Long messages against a 16k window, until something has to give.',
  },
};

function labWorking(isWorking) {
  labBusy = isWorking;
  for (const button of [dom.labShort, dom.labLong, dom.labOverflow, dom.labClear]) {
    button.disabled = isWorking;
  }
}

async function runLab(spec) {
  if (labBusy || agent.busy) return;

  const restore = { model: agent.config.model };
  labWorking(true);
  newSession();
  if (spec.model) {
    saveConfig(agent.configure({ model: spec.model }));
    syncFields();
  }

  const outcome = { ok: true, reason: 'ran to the end', turns: 0 };

  try {
    for (let index = 0; index < spec.turns; index += 1) {
      const text = labMessage(spec.tokens, index);
      bubble('user', 'you', Date.now()).set(text);
      const view = bubble('agent', agent.config.name, Date.now());
      try {
        const result = await agent.send(text);
        view.set(result.reply);
        view.render();
        outcome.turns += 1;
      } catch (error) {
        view.fail(error.message);
        outcome.ok = false;
        outcome.reason = error.code === 'context_length_exceeded'
          ? (error.name === 'ContextOverflowError'
            ? 'the agent refused before sending'
            : 'the endpoint refused it')
          : error.message;
        break;
      }
      persist(null);
      syncTokens();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    persist(null);
    const rows = agent.ledger.rows.map((row) => ({ ...row }));

    // Running to the end is not the same as coming through intact. Under the
    // trim policy nothing fails, and that is precisely the failure worth
    // reporting: the model stopped being able to see the beginning.
    const forgotten = rows.length ? rows[rows.length - 1].dropped : 0;
    if (outcome.ok && forgotten) {
      outcome.reason = `nothing failed, but by the last turn the agent was sending `
        + `${forgotten} fewer messages than it holds — the model could no longer see the start`;
    }
    labRuns = labRuns.filter((run) => run.id !== spec.id);
    labRuns.push({
      id: spec.id,
      label: spec.label,
      note: spec.note,
      model: agent.config.model,
      policy: agent.config.overflowPolicy,
      transport: agent.transport.id,
      rows,
      outcome,
    });

    if (spec.model) {
      saveConfig(agent.configure(restore));
      syncFields();
    }
    labWorking(false);
    renderCompare();
    syncStats();
    syncTokens();
  }
}

function startLab(spec) {
  if (agent.transport.id === 'echo') {
    runLab(spec);
    return;
  }
  const plan = agent.plan(labMessage(spec.tokens, 0));
  const guess = plan.worstCaseCost * spec.turns * ((spec.turns + 1) / 2);
  banner('warn',
    `${spec.label} against ${agent.transport.label} sends ${spec.turns} real requests — `
    + `somewhere around ${money(guess)}, and the whole point is visible on the echo transport `
    + 'for nothing.',
    [
      { label: 'Spend it', run: () => { dom.banner.hidden = true; runLab(spec); } },
      { label: 'Cancel', run: () => { dom.banner.hidden = true; } },
    ]);
}

function renderCompare() {
  dom.compare.replaceChildren();

  if (!labRuns.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No runs yet. Run all three and the table below compares them.';
    dom.compare.append(hint);
    return;
  }

  const table = document.createElement('div');
  table.className = 'ctable';

  const header = document.createElement('div');
  header.className = 'crow chead';
  for (const label of ['run', 'turns', 'last prompt', 'billed', 'cost', 'per turn']) {
    const cell = document.createElement('span');
    cell.textContent = label;
    header.append(cell);
  }
  table.append(header);

  for (const run of labRuns) {
    const last = run.rows[run.rows.length - 1];
    const first = run.rows[0];
    const line = document.createElement('div');
    line.className = 'crow';
    if (!run.outcome.ok) line.classList.add('broke');

    const cells = [
      run.label.split(' · ')[0],
      `${run.rows.length}`,
      last ? count(last.promptTokens) : '—',
      last ? count(last.cumulativeTokens) : '—',
      last ? money(last.cumulativeCost) : '—',
      last && first && first.cost > 0
        ? `${(last.cost / first.cost).toFixed(1)}× the first`
        : '—',
    ];
    for (const value of cells) {
      const cell = document.createElement('span');
      cell.textContent = value;
      line.append(cell);
    }
    table.append(line);

    const note = document.createElement('div');
    note.className = `crow-note${run.outcome.ok ? '' : ' broke'}`;
    note.textContent = `${run.note} — ${run.outcome.reason}`
      + ` (${run.model} over ${run.transport}, on overflow: ${run.policy}`
      + `${run.id === 'overflow' ? '; the other two policies fail differently' : ''})`;
    table.append(note);
  }

  dom.compare.append(table);
}

function boot() {
  const backend = localBackend.available() ? localBackend : createMemoryBackend();
  store = new SessionStore(backend, {
    onEvent: (event) => record({ at: Date.now(), turn: 0, ...event }),
  });

  const previous = store.lastActiveId();
  const found = previous ? store.load(previous) : null;

  if (found) {
    adopt(found);
  } else {
    session = store.create({ provenance: provenanceOf() });
    syncSessionBar();
    renderSessions();
  }

  if (!store.persistent) {
    banner('warn', 'This browser will not hand the page localStorage, so the store is '
      + 'running in memory and nothing will survive a reload. Everything else works.');
  }
}

function working(isWorking) {
  dom.send.disabled = isWorking;
  dom.input.disabled = isWorking;
  dom.reset.disabled = isWorking;
  dom.transport.disabled = isWorking;
  dom.newSession.disabled = isWorking;
  dom.importSession.disabled = isWorking;
  for (const button of [dom.labShort, dom.labLong, dom.labOverflow]) {
    button.disabled = isWorking || labBusy;
  }
  dom.stop.hidden = !isWorking;
  dom.status.textContent = isWorking ? 'thinking…' : '';
}

// Overflow is the only error here that the user can actually do something
// about, so it gets the numbers and the three ways out rather than a red line.
function explainOverflow(error, plan, text) {
  const refused = error.name === 'ContextOverflowError';
  banner('warn',
    `${refused ? 'The agent stopped before sending' : `${agent.transport.label} refused it`}: `
    + `${count(plan.prompt)} prompt plus ${count(plan.reserved)} reserved for the reply is `
    + `${count(plan.total)}, and ${plan.model} holds ${count(plan.limit)}. `
    + 'Nothing was added to the conversation and, if it never left, nothing was billed.',
    [
      {
        label: 'Drop the oldest turns',
        run: () => {
          dom.banner.hidden = true;
          saveConfig(agent.configure({ overflowPolicy: 'trim' }));
          syncFields();
          syncTokens();
          dom.input.value = text;
          dom.input.focus();
        },
      },
      {
        label: 'Halve the reply ceiling',
        run: () => {
          dom.banner.hidden = true;
          saveConfig(agent.configure({ maxTokens: Math.max(16, Math.floor(agent.config.maxTokens / 2)) }));
          syncFields();
          syncTokens();
          dom.input.value = text;
          dom.input.focus();
        },
      },
      {
        label: 'Start a new conversation',
        run: () => { dom.banner.hidden = true; newSession(); },
      },
    ]);
}

// The turn that cost money and produced nothing. The reasoning pane above the
// failed bubble is the only thing that survived it, so the banner points at it
// rather than pretending the turn was empty.
function explainStarved(error, text) {
  const entry = agent.ledger.rows[agent.ledger.rows.length - 1];
  const usage = error.usage || {};
  const ceiling = MODELS[agent.config.model]
    ? MODELS[agent.config.model].maxOutput
    : agent.config.maxTokens * 2;
  const raised = Math.min(ceiling, agent.config.maxTokens * 2);

  const spent = entry ? ` You were billed ${count(entry.billed)} tokens for it — ${money(entry.cost)}.` : '';
  banner('warn',
    error.code === 'reply_starved'
      ? `The ${count(error.ceiling)}-token ceiling was spent on reasoning before the answer `
        + `started: ${count(usage.completionTokens || 0)} tokens written, `
        + `${count(usage.reasoningTokens || 0)} of them thinking, none of them content.${spent} `
        + 'The thinking itself is still above, and nothing was added to the conversation.'
      : `The model returned an empty completion.${spent} Nothing was added to the conversation.`,
    [
      {
        label: raised > agent.config.maxTokens
          ? `Raise the ceiling to ${count(raised)} and ask again`
          : 'Ask again',
        run: () => {
          dom.banner.hidden = true;
          if (raised > agent.config.maxTokens) {
            saveConfig(agent.configure({ maxTokens: raised }));
            syncFields();
          }
          dom.input.value = text;
          submit();
        },
      },
      {
        label: 'Put the question back',
        run: () => {
          dom.banner.hidden = true;
          dom.input.value = text;
          dom.input.focus();
        },
      },
    ]);
}

async function submit() {
  const text = dom.input.value.trim();
  if (!text || agent.busy) return;

  // The count is taken before the send, because after the send it is history.
  const forecast = agent.plan(text);
  const mine = bubble('user', 'you', Date.now());
  mine.set(text);
  mine.note(`≈ ${count(forecast.next)} tokens · this request carries `
    + `${count(forecast.prompt)} of ${count(forecast.limit)}`);
  dom.input.value = '';
  syncTokens();

  const reply = bubble('agent', agent.config.name);
  controller = new AbortController();
  working(true);

  // Written before the request leaves, so that closing the tab mid-stream
  // leaves evidence rather than a silent gap.
  persist({
    turn: Math.floor(agent.history.length / 2) + 1,
    text,
    startedAt: Date.now(),
  });

  try {
    const result = await agent.send(text, {
      onChunk: (chunk, kind) => reply.append(chunk, kind),
      signal: controller.signal,
    });
    reply.render();

    // The guess, the bill, and the gap between them, under the reply that
    // settled it.
    const usage = result.usage || {};
    const entry = agent.ledger.rows[agent.ledger.rows.length - 1];
    const thought = usage.reasoningTokens || 0;
    reply.note(
      `${count(usage.completionTokens || 0)} tokens out`
      + (thought ? ` (${count(thought)} of them thinking, which you are paying for)` : '')
      + ' · '
      + `${count(usage.promptTokens || 0)} in (guessed ${count(forecast.prompt)}, `
      + `${signed(entry && entry.drift)}) · ${money(result.cost)} · `
      + `${money(entry ? entry.cumulativeCost : 0)} this run`
      + (result.finishReason === 'length'
        ? ` · cut off at the ${count(agent.config.maxTokens)}-token ceiling`
        : ''),
      result.finishReason === 'length' ? 'bad' : ''
    );
    persist(null);
  } catch (error) {
    if (error.name === 'AbortError') reply.fail('Stopped.');
    else reply.fail(error.message);

    // Three failures are worth explaining rather than printing: the request
    // that did not fit, the reply that was never written, and the reply that
    // was empty. Each one has numbers behind it and a way out.
    if (error.code === 'context_length_exceeded') explainOverflow(error, forecast, text);
    else if (error.code === 'reply_starved' || error.code === 'reply_empty') {
      explainStarved(error, text);
    }

    // The turn ended — badly, but it ended. It is not interrupted, and the
    // agent never wrote it into memory, so there is nothing new to keep.
    persist(null);
    forgetIfEmpty();
  } finally {
    controller = null;
    working(false);
    syncStats();
    syncFields();
    syncTokens();
    dom.input.focus();
  }
}

/* ---------- wiring ---------- */

function buildAgent(transportId) {
  const transport = TRANSPORTS.find((entry) => entry.id === transportId) || TRANSPORTS[0];
  agent = new Agent({ transport, onEvent: record, counter, compressor, ...savedConfig() });
  saveConfig(agent.config);
}

function start() {
  for (const transport of TRANSPORTS) {
    const option = document.createElement('option');
    option.value = transport.id;
    option.textContent = transport.label;
    dom.transport.append(option);
  }

  counter = new TokenCounter({ calibration: savedCalibration() });
  // The compressor outlives the agent for the same reason the counter does:
  // it holds half the conversation, and swapping transports must not amnesia
  // the compressed half any more than it amnesias the verbatim one.
  /* The fact store outlives the agent for the third time in the same sentence:
   * it is the other half of the conversation, and half a conversation is not
   * something to lose because a transport changed. It is handed to the
   * compressor rather than to the agent because the compressor is what decides
   * whether any of it goes up the wire. */
  facts = new FactStore({ counter });
  compressor = new Compressor({ counter, facts });
  // One branch, and it is this conversation. Every conversation starts as the
  // thing every conversation used to be.
  tree = new BranchTree();
  buildAgent(TRANSPORTS[0].id);
  buildFields();
  boot();
  syncFields();
  syncStats();
  syncTokens();
  renderCompare();
  renderBench();

  try {
    dom.key.value = getKey();
  } catch (error) {
    dom.key.value = '';
  }

  dom.key.addEventListener('input', () => setKey(dom.key.value));

  /* The transport is a constructor dependency, so changing it means a new
   * agent — and a new agent has no memory. Said out loud rather than hidden. */
  // Task 6 lost the conversation here, because memory lived and died with the
  // agent object. It no longer does, so a new agent can be handed the old one.
  dom.transport.addEventListener('change', () => {
    const carried = session;
    buildAgent(dom.transport.value);
    session = carried;

    if (session && agent) {
      const messages = (session.messages || []).slice();
      if (messages.length) {
        agent.restore({
          messages,
          memory: session.memory || null,
          savedAt: session.updatedAt,
          config: session.provenance,
          transport: session.provenance ? session.provenance.transport : null,
        });
        replay(messages);
      } else {
        dom.log.replaceChildren(dom.empty);
        dom.empty.hidden = false;
      }
    }

    syncFields();
    syncStats();
    syncSessionBar();
    renderSessions();
    dom.status.textContent = 'new agent — the conversation came with it';
    setTimeout(() => { dom.status.textContent = ''; }, 4000);
  });

  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  dom.input.addEventListener('input', syncTokens);

  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  dom.stop.addEventListener('click', () => {
    if (controller) controller.abort();
  });

  // It starts a new one rather than destroying the old one — the old one is
  // still in the sessions tab, which is the whole point of this task.
  dom.reset.addEventListener('click', newSession);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      dom.tokensPanel.hidden = tab.dataset.tab !== 'tokens';
    dom.contextPanel.hidden = tab.dataset.tab !== 'context';
      dom.sessionsPanel.hidden = tab.dataset.tab !== 'sessions';
      dom.configPanel.hidden = tab.dataset.tab !== 'config';
      dom.debugPanel.hidden = tab.dataset.tab !== 'debug';
    });
  }

  dom.filter.addEventListener('change', applyFilter);

  dom.copyLog.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(log, null, 2)).then(
      () => { dom.copyLog.textContent = 'Copied'; setTimeout(() => { dom.copyLog.textContent = 'Copy'; }, 1200); },
      () => { dom.copyLog.textContent = 'Failed'; setTimeout(() => { dom.copyLog.textContent = 'Copy'; }, 1200); }
    );
  });

  dom.clearLog.addEventListener('click', () => {
    log = [];
    dom.events.replaceChildren();
  });

  dom.title.addEventListener('change', () => {
    if (!session) return;
    const wanted = dom.title.value.trim();
    if (session.stored) {
      const renamed = store.rename(session.id, wanted);
      if (renamed) session = { ...renamed, stored: true };
    } else if (wanted) {
      session.title = wanted;
    }
    syncSessionBar();
    renderSessions();
  });

  /* Two buttons and no dialog. A checkpoint names itself after the place it
   * is, and a fork names itself after the branch it came from, because a modal
   * asking for a name is a modal between a person and the thing they were
   * about to compare. */
  dom.markHere.addEventListener('click', () => {
    try {
      markHere(`after ${plural(agent.history.length, 'message')}`);
      persist(null);
      syncTokens();
    } catch (error) {
      banner('warn', error.message);
    }
  });

  dom.forkHere.addEventListener('click', () => {
    try {
      // From the last checkpoint on this branch if there is one, and from the
      // end of it otherwise. The checkpoint is what makes the second fork land
      // in the same place as the first.
      const points = tree.checkpoints({ on: tree.head });
      const point = points.length ? points[points.length - 1] : null;
      // Unnamed on purpose: the tree names a fork after the branch it came
      // from, so two forks off `main` are `main +1` and `main +2` and the
      // relationship is legible without anyone having typed anything.
      const created = forkAt(point ? point.at : agent.history.length);
      switchTo(created.id);
      replay(agent.history);
      persist(null);
      syncFields();
      syncStats();
      syncTokens();
    } catch (error) {
      banner('warn', error.message);
    }
  });

  dom.benchRun.addEventListener('click', startBench);
  dom.benchClear.addEventListener('click', () => { benchRuns = []; renderBench(); });
  dom.labShort.addEventListener('click', () => startLab(LAB_RUNS.short));
  dom.labLong.addEventListener('click', () => startLab(LAB_RUNS.long));
  dom.labOverflow.addEventListener('click', () => startLab(LAB_RUNS.overflow));
  dom.labClear.addEventListener('click', () => { labRuns = []; renderCompare(); });

  dom.newSession.addEventListener('click', newSession);
  dom.exportSession.addEventListener('click', exportSession);
  dom.importSession.addEventListener('click', () => dom.importFile.click());

  dom.importFile.addEventListener('change', () => {
    importFile(dom.importFile.files[0]);
    dom.importFile.value = '';
  });

  for (const type of ['dragover', 'dragenter']) {
    dom.sessions.addEventListener(type, (event) => {
      event.preventDefault();
      dom.sessions.classList.add('dropping');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dom.sessions.addEventListener(type, () => dom.sessions.classList.remove('dropping'));
  }
  dom.sessions.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) importFile(file);
  });

  dom.input.focus();
}

start();
