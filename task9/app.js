/* The interface.
 *
 * It owns no conversation, no payload and no HTTP. It reads `agent.config` and
 * `Agent.schema` to draw the config tab, mirrors the agent's event stream into
 * the debug tab, and calls `agent.send(text)` to take a turn. Everything it
 * displays was either typed by the user or emitted by the agent.
 */

const CONFIG_STORAGE = 'task9.agent.config';
const CALIBRATION_STORAGE = 'task9.calibration';
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
  memoryPanel: el('memoryPanel'),
  split: el('split'),
  splitRows: el('splitRows'),
  summaryNote: el('summaryNote'),
  summaryText: el('summaryText'),
  savedRows: el('savedRows'),
  foldRows: el('foldRows'),
  generationsNote: el('generationsNote'),
  generations: el('generations'),
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
  'memory:sent': (e) => `${e.sentVerbatim} verbatim`
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
    + (e.generations ? ` and ${plural(e.generations, 'summary', 'summaries')} of them` : ''),
  'agent:restored': (e) => `${plural(e.messages, 'message')} back in memory`
    + (e.generations ? ` · ${e.folded} of them compressed into generation ${e.generations}` : '')
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
  const snapshot = agent.snapshot();
  return {
    ...session,
    messages: snapshot.messages.map((message) => ({ ...message })),
    // Stored beside the messages, never inside them. A conversation restored
    // without its summary quietly goes back to full price; a summary restored
    // without its cut point sends the folded messages twice.
    memory: snapshot.memory && snapshot.memory.summaries.length ? snapshot.memory : null,
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
  link.download = `task9-session-${record.id}.json`;
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

  const selection = compressor.select(agent.history);
  const versus = agent.counterfactual(dom.input.value);
  const verbatim = selection.verbatim.length;
  const bands = [
    ['summarised', selection.folded, 'band-summarised'],
    ['verbatim', verbatim - selection.pending, 'band-verbatim'],
    ['awaiting the next fold', selection.pending, 'band-pending'],
    ['deleted', selection.dropped, 'band-dropped'],
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
    ['deleted for good', selection.dropped
      ? `${plural(selection.dropped, 'message')} — the model cannot see them`
      : 'none', selection.dropped ? 'bad' : ''],
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

function renderFolds() {
  const stats = agent.stats;
  const savings = compressor.savings({ held: agent.history.length });

  if (!stats.folds && !stats.foldFailures) {
    readout(dom.foldRows, null, [['folds', 'none yet — nothing has been spent on compression']]);
    return;
  }

  const rows = [
    ['folds', plural(stats.folds, 'fold')],
    ['spent writing summaries', `${count(stats.foldTokens)} tokens · ${money(stats.foldCost)}`],
    ['time spent folding', seconds(stats.foldElapsed)],
    ['saves per turn', `${count(savings.savedPerTurn)} tokens`],
  ];

  if (savings.breakEvenTurns != null) {
    rows.push(['pays for itself in', plural(savings.breakEvenTurns, 'turn')]);
    rows.push(['turns since the last fold', plural(savings.turnsSinceFold, 'turn')]);
    rows.push(['verdict', savings.net > 0
      ? `ahead by ${count(savings.net)} tokens`
      : `still ${count(-savings.net)} tokens behind — `
        + (savings.turnsSinceFold < savings.breakEvenTurns
          ? `${plural(savings.breakEvenTurns - savings.turnsSinceFold, 'turn')} to go`
          : 'this conversation is too short to be worth compressing'),
    savings.net > 0 ? 'good' : 'bad']);
  }
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
  if (!agent || !compressor) return;
  renderSplit();
  renderSummary();
  renderSaved();
  renderFolds();
  renderGenerations();
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
  compressor = new Compressor({ counter });
  buildAgent(TRANSPORTS[0].id);
  buildFields();
  boot();
  syncFields();
  syncStats();
  syncTokens();
  renderCompare();

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
    dom.memoryPanel.hidden = tab.dataset.tab !== 'memory';
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
