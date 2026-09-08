/* The interface.
 *
 * It owns no conversation, no payload and no HTTP. It reads `agent.config` and
 * `Agent.schema` to draw the config tab, mirrors the agent's event stream into
 * the debug tab, and calls `agent.send(text)` to take a turn. Everything it
 * displays was either typed by the user or emitted by the agent.
 */

const CONFIG_STORAGE = 'task6.agent.config';
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
};

let agent = null;
let controller = null;
let log = [];

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
    dom.stats.textContent = 'no turns yet';
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
};

function matchesFilter(event, filter) {
  if (!filter) return true;
  if (filter === 'problems') return event.type === 'retry' || event.type === 'error';
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

function bubble(role, who) {
  dom.empty.hidden = true;

  const wrap = document.createElement('div');
  wrap.className = `turn ${role}`;

  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who;

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

function working(isWorking) {
  dom.send.disabled = isWorking;
  dom.input.disabled = isWorking;
  dom.reset.disabled = isWorking;
  dom.transport.disabled = isWorking;
  dom.stop.hidden = !isWorking;
  dom.status.textContent = isWorking ? 'thinking…' : '';
}

async function submit() {
  const text = dom.input.value.trim();
  if (!text || agent.busy) return;

  bubble('user', 'you').set(text);
  dom.input.value = '';

  const reply = bubble('agent', agent.config.name);
  controller = new AbortController();
  working(true);

  try {
    await agent.send(text, {
      onChunk: (chunk, kind) => reply.append(chunk, kind),
      signal: controller.signal,
    });
    reply.render();
  } catch (error) {
    if (error.name === 'AbortError') reply.fail('Stopped.');
    else reply.fail(error.message);
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
  dom.transport.addEventListener('change', () => {
    buildAgent(dom.transport.value);
    dom.log.replaceChildren(dom.empty);
    dom.empty.hidden = false;
    syncFields();
    syncStats();
    dom.status.textContent = 'new agent — the conversation was not carried over';
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

  dom.reset.addEventListener('click', () => {
    agent.reset();
    dom.log.replaceChildren(dom.empty);
    dom.empty.hidden = false;
    dom.input.focus();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
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

  dom.input.focus();
}

start();
