/* The interface.
 *
 * It owns no conversation, no payload and no HTTP. It reads `agent.config` and
 * `Agent.schema` to draw the config tab, mirrors the agent's event stream into
 * the debug tab, and calls `agent.send(text)` to take a turn. Everything it
 * displays was either typed by the user or emitted by the agent.
 */

const CONFIG_STORAGE = 'task7.agent.config';
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
};

let agent = null;
let controller = null;
let log = [];
let store = null;
let session = null;

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

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
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
  ];
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

function syncStats() {
  const stats = agent.stats;
  if (!stats.turns && !stats.failed) {
    dom.stats.textContent = agent.history.length
      ? `restored · ${plural(agent.history.length, 'message')} in memory · no turns this run`
      : 'no turns yet';
    return;
  }
  const parts = [
    `${stats.turns} turn${stats.turns === 1 ? '' : 's'}`,
    `${agent.history.length} in memory`,
    `${stats.promptTokens} in / ${stats.completionTokens} out`
      + (stats.reasoningTokens ? ` (${stats.reasoningTokens} thinking)` : ''),
    `${stats.cacheHitTokens} cached`,
    money(stats.cost),
    seconds(stats.elapsed),
  ];
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
  'memory:trim': (e) => `dropped ${e.dropped}, kept ${e.kept} · ~${e.estimatedTokens}/${e.budget} tokens`,
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
  reset: (e) => `forgot ${e.forgotten} messages`,
  'agent:restored': (e) => `${plural(e.messages, 'message')} back in memory`
    + (e.savedAt ? ` · saved ${relative(e.savedAt)}` : '')
    + (e.heldUnder ? ` · held under ${e.heldUnder.name} on ${e.heldUnder.model}` : ''),
  'store:save': (e) => `${e.id} · ${plural(e.messages, 'message')} · ${size(e.bytes)}`,
  'store:remove': (e) => `${e.id} deleted`,
  'store:import': (e) => `${plural(e.messages, 'message')} in`
    + (e.renamed ? ' · id was taken, given a fresh one' : ''),
  'store:unreadable': (e) => `${e.key} · ${e.kind} · ${e.message}`,
};

function matchesFilter(event, filter) {
  if (!filter) return true;
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
  }
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

  wrap.append(label, thinking, body);
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
        body.textContent = '(empty reply)';
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
  link.download = `task7-session-${record.id}.json`;
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
  dom.stop.hidden = !isWorking;
  dom.status.textContent = isWorking ? 'thinking…' : '';
}

async function submit() {
  const text = dom.input.value.trim();
  if (!text || agent.busy) return;

  bubble('user', 'you', Date.now()).set(text);
  dom.input.value = '';

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
    await agent.send(text, {
      onChunk: (chunk, kind) => reply.append(chunk, kind),
      signal: controller.signal,
    });
    reply.render();
    persist(null);
  } catch (error) {
    if (error.name === 'AbortError') reply.fail('Stopped.');
    else reply.fail(error.message);
    // The turn ended — badly, but it ended. It is not interrupted, and the
    // agent never wrote it into memory, so there is nothing new to keep.
    persist(null);
    forgetIfEmpty();
  } finally {
    controller = null;
    working(false);
    syncStats();
    syncFields();
    dom.input.focus();
  }
}

/* ---------- wiring ---------- */

function buildAgent(transportId) {
  const transport = TRANSPORTS.find((entry) => entry.id === transportId) || TRANSPORTS[0];
  agent = new Agent({ transport, onEvent: record, ...savedConfig() });
  saveConfig(agent.config);
}

function start() {
  for (const transport of TRANSPORTS) {
    const option = document.createElement('option');
    option.value = transport.id;
    option.textContent = transport.label;
    dom.transport.append(option);
  }

  buildAgent(TRANSPORTS[0].id);
  buildFields();
  boot();
  syncFields();
  syncStats();

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
