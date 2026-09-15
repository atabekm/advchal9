/* The interface.
 *
 * It renders three layers, a log of routing decisions, a task, and the request
 * that would go up the wire if you pressed send right now. It contains not one
 * line of what-is-a-layer, what-is-a-fact or which-rule-applies: every one of
 * those questions is answered in layers.js, extract.js and router.js, and this
 * file's job is to show the answers in a way that makes a wrong one obvious.
 *
 * The one rule it follows throughout: never draw a conclusion the model could
 * not have drawn. If an item is on screen, it is in a layer; if a layer is
 * dimmed, it was not sent; if a rule number is shown, that rule is what put it
 * there. A panel that summarised would be a fourth memory nobody could audit.
 */

const $ = (id) => document.getElementById(id);

/* The placeholder is taken out of the document once and kept, because
 * `renderChat` clears the log by emptying it — and a node that has been
 * emptied out of the DOM cannot be found by id again. */
const EMPTY = document.getElementById('empty');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function row(label, value) {
  const line = el('div', 'row');
  line.append(el('span', 'k', label), el('span', 'v', String(value)));
  return line;
}

function none(message) {
  return el('p', 'none hint', message);
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function money(n) {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

function ago(at) {
  if (!at) return 'never';
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/* ------------------------------------------------------------------ boot */

const events = [];
function note(type, detail) {
  events.unshift({ at: Date.now(), type, detail });
  events.length = Math.min(events.length, 200);
}

const store = new Persistence(localBackend, { onEvent: note });
const memory = new Memory();
const agent = new Agent({ transport: deepseekTransport, memory, onEvent: note });

let dialogue = null;
let controller = null;

/* Restore, layer by layer, from three different places. This function is the
 * shape of the whole task: the person comes back whatever else happened, the
 * task comes back if it is still open, and the dialogue comes back only if it
 * is the one that was last on screen. */
function boot() {
  const profile = store.loadProfile();
  if (profile) memory.long.restore(profile);

  const lastId = store.lastActive();
  const record = lastId ? store.loadDialogue(lastId) : null;
  if (record) {
    dialogue = record;
    memory.short.restore(record.short);
    agent.dialogueId = record.id;
    agent.router.restoreLog(record.log);
    const task = store.loadTask(record.taskId);
    if (task && !task.closed) memory.working.restore({ task, items: task.items });
  } else {
    dialogue = store.createDialogue({ short: memory.short.snapshot() });
    agent.dialogueId = dialogue.id;
  }
}

/* Save, layer by layer, to three different places. Three writes rather than
 * one is the cost of the separation, and it is the whole of the cost. */
function persist() {
  const snapshot = memory.snapshot();
  try {
    store.saveProfile(snapshot.long);
    const task = memory.working.task;
    store.saveTask({
      id: task.id,
      goal: task.goal,
      opened: task.opened,
      closed: null,
      dialogueId: dialogue.id,
      items: snapshot.working.items,
    });
    dialogue = store.saveDialogue({
      ...dialogue,
      short: snapshot.short,
      taskId: task.id,
      log: agent.router.log,
    });
    store.setLastActive(dialogue.id);
  } catch (error) {
    banner(error.message, 'error');
  }
}

/* --------------------------------------------------------------- the chat */

function banner(message, kind = 'error') {
  const node = $('banner');
  node.hidden = !message;
  node.className = `banner${kind === 'error' ? '' : ' notice'}`;
  node.textContent = message || '';
}

function messageNode(role, content, { pending = false } = {}) {
  const node = el('div', `msg ${role}${pending ? ' pending' : ''}`);
  node.append(el('div', 'who', role === 'user' ? 'you' : agent.config.name));
  const body = el('div', 'body');
  if (role === 'assistant') body.innerHTML = renderMarkdown(content);
  else body.textContent = content;
  node.append(body);
  return node;
}

// What this turn put where, under the reply. Four words, so that the memory
// model stays in view without anybody having to open a panel.
function storedStrip(entries) {
  const strip = el('div', 'stored');
  const written = entries.filter((entry) => entry.layer);
  if (!written.length) {
    strip.append(el('span', null, entries.length ? 'nothing stored — everything was dropped or refused' : 'nothing to store'));
    return strip;
  }
  strip.append(el('span', null, 'stored:'));
  for (const entry of written) {
    const badge = el('span', `badge ${entry.layer}`, `${entry.key} → ${entry.layer}${entry.compartment ? `.${entry.compartment}` : ''}`);
    badge.title = `rule ${entry.rule.n} (${entry.rule.name}): ${entry.rule.why}`;
    strip.append(badge);
  }
  const lost = entries.length - written.length;
  if (lost) strip.append(el('span', null, `· ${lost} not stored`));
  return strip;
}

function renderChat() {
  const log = $('log');
  log.innerHTML = '';
  const messages = memory.short.all();
  if (!messages.length) {
    EMPTY.hidden = false;
    log.append(EMPTY);
    return;
  }
  EMPTY.hidden = true;
  const turns = agent.turns;
  messages.forEach((message, index) => {
    const node = messageNode(message.role, message.content);
    if (message.role === 'assistant') {
      const turn = turns.find((t) => t.index === index - 1);
      if (turn && turn.entries) node.append(storedStrip(turn.entries));
    }
    log.append(node);
  });
  log.scrollTop = log.scrollHeight;
}

/* ------------------------------------------------------- the memory board */

function itemActions(item, layer) {
  const actions = el('div', 'actions');
  const move = (to, compartment, label) => {
    const button = el('button', 'tiny', label);
    button.addEventListener('click', () => {
      agent.router.manual({ item, to, compartment, kind: item.kind === 'decision' ? 'decision' : 'artifact' });
      persist();
      renderAll();
    });
    return button;
  };
  if (layer === 'working') {
    actions.append(move('long', 'decisions', '→ decisions'));
    actions.append(move('long', 'knowledge', '→ knowledge'));
  } else {
    /* "Still true" is the other half of the stale flag. An agent that could
     * only delete an out-of-date fact would make forgetting the cheapest
     * option, and the whole argument for a long-term layer is that forgetting
     * should be the expensive one. */
    const confirm = el('button', 'tiny', 'still true');
    confirm.addEventListener('click', () => {
      memory.long.put({
        compartment: item.compartment,
        key: item.key,
        value: item.value,
        from: item.from,
        source: item.source,
        rule: item.rule,
      });
      persist();
      renderAll();
    });
    actions.append(confirm);
    if (item.compartment !== 'knowledge') actions.append(move('long', 'knowledge', '→ knowledge'));
    actions.append(move('working', null, '→ task'));
  }
  actions.append(move('short', null, 'forget'));
  return actions;
}

function itemNode(item, layer) {
  const node = el('div', `item${item.stale ? ' stale' : ''}`);
  const line = el('div', 'line');
  line.append(el('span', 'key', item.key), el('span', 'value', item.value));
  node.append(line);

  const meta = el('div', 'meta');
  if (item.kind) meta.append(el('span', 'badge kind', item.kind));
  if (item.rule === 0) meta.append(el('span', 'badge manual', 'by hand'));
  else if (item.rule === 'opened') meta.append(el('span', 'badge kind', 'named with the task'));
  else if (item.rule) meta.append(el('span', 'badge rule', `rule ${item.rule}`));
  if (item.proposed && item.proposed !== layer) {
    meta.append(el('span', 'badge overruled', `model said ${item.proposed}`));
  }
  meta.append(el('span', null, `said by the ${item.from}`));
  if (item.confirmations) meta.append(el('span', null, `confirmed ×${item.confirmations}`));
  if (item.lastConfirmed) meta.append(el('span', null, ago(item.lastConfirmed)));
  if (item.history && item.history.length) {
    const was = el('span', null, `was "${item.history[item.history.length - 1].value}"`);
    was.title = item.history.map((h) => h.value).join(' → ');
    meta.append(was);
  }
  if (item.promotedFrom && item.promotedFrom.goal) {
    meta.append(el('span', null, `decided in "${item.promotedFrom.goal}"`));
  }
  if (item.promotable) meta.append(el('span', null, 'promotable when the task closes'));
  if (item.stale) meta.append(el('span', 'badge overruled', 'nobody has mentioned this in months'));
  meta.append(itemActions(item, layer));
  node.append(meta);
  return node;
}

function layerHead(layer, { name, lifetime, counts, off }) {
  const head = el('div', 'layer-head');
  head.append(el('div', 'name', name));
  head.append(el('div', 'lifetime', lifetime));
  head.append(el('div', 'counts', counts + (off ? ' · not being sent' : '')));
  return head;
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const config = agent.config;
  const stats = memory.stats();

  // short
  const short = el('div', `layer short${config.useShort ? '' : ' off'}`);
  short.append(layerHead('short', {
    name: 'short-term · this dialogue',
    lifetime: 'emptied when the conversation is reset',
    counts: `${stats.short.items} messages · ${stats.short.sent} sent · ~${stats.short.tokens} tokens`,
    off: !config.useShort,
  }));
  const peek = el('div', 'messages-peek');
  const messages = memory.short.all();
  const from = memory.short.windowFrom();
  if (!messages.length) peek.append(none('Nothing said yet.'));
  messages.slice(-12).forEach((message, offset) => {
    const index = messages.length - Math.min(12, messages.length) + offset;
    const line = el('div', `m${index < from ? ' out' : ''}`);
    line.append(el('span', 'r', message.role === 'user' ? 'you' : 'agent'));
    line.append(el('span', 't', message.content));
    line.title = index < from ? 'on screen, not in the request' : 'in the request';
    peek.append(line);
  });
  short.append(peek);
  board.append(short);

  // working
  const task = memory.working.task;
  const working = el('div', `layer working${config.useWorking ? '' : ' off'}`);
  working.append(layerHead('working', {
    name: `working · ${task.goal ? `"${task.goal}"` : 'no task named yet'}`,
    lifetime: 'emptied when the task is closed',
    counts: `${stats.working.items} items · ${stats.working.sent} sent · ~${stats.working.tokens} tokens`,
    off: !config.useWorking,
  }));
  const items = memory.working.all();
  if (!items.length) working.append(none('Nothing about this task yet.'));
  for (const item of items) working.append(itemNode(item, 'working'));
  board.append(working);

  // long
  const long = el('div', `layer long${config.useLong ? '' : ' off'}`);
  long.append(layerHead('long', {
    name: 'long-term · this person',
    lifetime: 'survives every conversation, until retracted',
    counts: `${stats.long.items} items · ${stats.long.sent} sent · ~${stats.long.tokens} tokens`,
    off: !config.useLong,
  }));
  let anything = false;
  for (const compartment of LongTerm.compartments) {
    const list = memory.long.all(compartment);
    if (!list.length) continue;
    anything = true;
    long.append(el('div', 'compartment', compartment));
    for (const item of list) long.append(itemNode({ ...item, compartment }, 'long'));
  }
  if (!anything) long.append(none('Nothing known about anybody yet.'));
  board.append(long);
}

function renderStorage() {
  const node = $('storage');
  node.innerHTML = '';
  const usage = store.usage();
  const widest = Math.max(1, ...usage.layers.map((layer) => layer.bytes));
  for (const layer of usage.layers) {
    const wrap = el('div', 'nsrow');
    const top = el('div', 'top');
    top.append(el('span', null, `${layer.layer} — ${layer.records} record${layer.records === 1 ? '' : 's'}`));
    top.append(el('span', null, bytes(layer.bytes)));
    wrap.append(top);
    wrap.append(el('div', 'ns', layer.namespace));
    const bar = el('div', `bar ${layer.layer}`);
    const fill = el('span');
    fill.style.width = `${Math.round((layer.bytes / widest) * 100)}%`;
    bar.append(fill);
    wrap.append(bar);
    node.append(wrap);
  }
  node.append(row('backend', usage.backend.label));
  if (!usage.persistent) {
    node.append(el('p', 'hint', 'This browser refused localStorage, so nothing here survives the tab.'));
  }
}

/* Built from the layer objects rather than written out here. A table of
 * lifetimes typed into the HTML would be a promise; this one changes when the
 * code does, which is the difference between documentation and a caption. */
function renderSurvives() {
  const node = $('survives');
  node.innerHTML = '';
  for (const layer of memory.layers) {
    node.append(row(`${layer.label} — ${layer.scope}`, layer.lifetime));
  }
}

function renderRetracted() {
  const node = $('retracted');
  node.innerHTML = '';
  const list = memory.long.retracted;
  if (!list.length) {
    node.append(none('Nothing has been withdrawn.'));
    return;
  }
  for (const item of list.slice(0, 12)) {
    node.append(row(`${item.compartment}.${item.key} — ${item.reason}`, `"${item.value}"`));
  }
}

/* ------------------------------------------------------------- the routing */

function renderRules() {
  const node = $('rules');
  node.innerHTML = '';
  for (const rule of Router.rules) {
    const line = el('div', 'rule');
    line.append(el('span', 'n', String(rule.n)));
    line.append(el('span', 'name', rule.name));
    line.append(el('span', 'why', rule.why));
    node.append(line);
  }
}

function matchesFilter(entry, filter) {
  if (!filter) return true;
  if (filter === 'written') return Boolean(entry.layer);
  if (filter === 'dropped') return entry.outcome === 'dropped';
  if (filter === 'rejected') return entry.outcome === 'rejected';
  if (filter === 'overruled') return entry.agreed === false;
  if (filter === 'manual') return entry.rule && entry.rule.n === 0;
  return true;
}

function renderRoutes() {
  const node = $('routes');
  node.innerHTML = '';
  const filter = $('routeFilter').value;
  const log = agent.router.log;
  const shown = log.filter((entry) => matchesFilter(entry, filter));

  const overruled = log.filter((entry) => entry.agreed === false).length;
  const refused = log.filter((entry) => entry.outcome === 'rejected').length;
  $('routeSummary').textContent = log.length
    ? `${log.length} decisions · ${log.filter((e) => e.layer).length} stored · `
      + `${refused} refused by the gate · ${overruled} where the rules overruled the model`
    : 'Nothing has been proposed yet.';

  if (!shown.length) {
    node.append(none(log.length ? 'Nothing matches that filter.' : 'Nothing yet.'));
    return;
  }

  for (const entry of shown.slice(0, 80)) {
    const line = el('div', `route${entry.layer ? '' : ' no'}`);
    const head = el('div', 'head');

    const value = el('span', 'val');
    value.append(el('span', 'q', `${entry.key}: `));
    value.append(document.createTextNode(entry.value ? `"${entry.value}"` : '(withdrawn)'));
    head.append(value);

    if (entry.layer) {
      head.append(el('span', `badge ${entry.layer}`,
        entry.layer + (entry.compartment ? `.${entry.compartment}` : '')));
    } else {
      head.append(el('span', 'badge overruled', entry.outcome));
    }
    if (entry.rule) {
      head.append(el('span', `badge ${entry.rule.n === 0 ? 'manual' : 'rule'}`,
        entry.rule.n === 0 ? entry.rule.name : `rule ${entry.rule.n} · ${entry.rule.name}`));
    } else {
      head.append(el('span', 'badge overruled', 'the gate'));
    }
    line.append(head);

    const why = el('div', 'why');
    const parts = [];
    if (entry.rule) parts.push(entry.rule.why);
    if (entry.reason) parts.push(entry.reason);
    if (entry.note) parts.push(entry.note);
    if (entry.previous) parts.push(`replaced "${entry.previous}"`);
    if (entry.outcome === 'confirmed') parts.push('already knew this — the clock moved, nothing else');
    if (entry.proposed) {
      parts.push(entry.agreed === false
        ? `the model wanted ${entry.proposed}`
        : `the model agreed: ${entry.proposed}`);
    }
    parts.push(ago(entry.at));
    why.textContent = parts.join(' · ');
    line.append(why);

    // A refusal shows the message it claimed to be quoting. Without it the
    // gate is an assertion; with it, anybody can check.
    if (entry.claimed) {
      const claimed = el('div', 'claimed', `the ${entry.from} actually said: ${entry.claimed}`);
      line.append(claimed);
    }
    node.append(line);
  }
}

/* ---------------------------------------------------------------- the task */

function renderTask() {
  const node = $('taskBox');
  node.innerHTML = '';
  const task = memory.working.task;
  const items = memory.working.all();

  node.append(el('div', 'goal', task.goal || 'No task named yet — working memory is unfiled'));
  node.append(el('div', 'age', task.goal
    ? `opened ${ago(task.opened)} · ${items.length} items · ${items.filter((i) => i.promotable).length} could outlive it`
    : `${items.length} items are being kept against no particular task`));

  const tools = el('div', 'tools');
  const input = el('input');
  input.placeholder = task.goal ? 'rename, or start a different task…' : 'what are we working on?';
  input.value = '';
  const open = el('button', 'primary', task.goal ? 'start a new task' : 'open a task');
  open.addEventListener('click', () => {
    const goal = input.value.trim();
    if (!goal) return;
    if (task.goal) closeTask();
    agent.openTask(goal);
    persist();
    renderAll();
  });
  tools.append(input, open);
  if (task.goal) {
    const close = el('button', null, 'close this task');
    close.addEventListener('click', () => { closeTask(); renderAll(); });
    tools.append(close);
  }
  node.append(tools);
}

/* Closing a task is two things that are easy to conflate: archiving the record,
 * and deciding what outlives it. The first happens here. The second is put on
 * screen and left there until somebody answers it — which is the only moment in
 * this app where the boundary between two layers is a judgement rather than a
 * rule that already fired. */
let pendingPromotion = null;

function closeTask() {
  const task = memory.working.task;
  const { record, promotable } = agent.closeTask();
  store.saveTask({ ...record, dialogueId: dialogue.id, closed: Date.now(), id: task.id });
  pendingPromotion = promotable.length ? { record, promotable } : null;
  persist();
  if (!pendingPromotion) {
    banner(`Closed "${record.goal || 'the unfiled task'}". Nothing in it was a decision, so nothing outlives it.`, 'notice');
  }
}

function renderPromotion() {
  const section = $('promoteSection');
  const node = $('promote');
  node.innerHTML = '';
  section.hidden = !pendingPromotion;
  if (!pendingPromotion) return;

  const { record, promotable } = pendingPromotion;
  node.append(el('p', 'hint', `"${record.goal || 'the unfiled task'}" is closed. `
    + `${promotable.length} decision${promotable.length === 1 ? ' was' : 's were'} made inside it. `
    + 'Promote the ones that are still true when this task is forgotten.'));

  for (const item of promotable) {
    const line = el('div', 'cand');
    line.append(el('span', 'key', item.key));
    line.append(el('span', 'value', item.value));
    /* Both handlers read `pendingPromotion.promotable` rather than the
     * `promotable` this render closed over. They are the same array until the
     * first click, and after it they are not — a handler that filtered the
     * captured one would put a decision back on screen that had just been
     * dealt with. */
    const settle = () => {
      pendingPromotion.promotable = pendingPromotion.promotable.filter((other) => other !== item);
      if (!pendingPromotion.promotable.length) pendingPromotion = null;
      renderAll();
    };
    const keep = el('button', 'tiny primary', 'promote');
    keep.addEventListener('click', () => {
      agent.router.promote(item, { taskId: record.id, goal: record.goal });
      settle();
      persist();
    });
    const drop = el('button', 'tiny', 'leave it with the task');
    drop.addEventListener('click', settle);
    line.append(keep, drop);
    node.append(line);
  }

  const all = el('div', 'tools');
  const every = el('button', null, 'promote them all');
  every.addEventListener('click', () => {
    for (const item of pendingPromotion.promotable) {
      agent.router.promote(item, { taskId: record.id, goal: record.goal });
    }
    pendingPromotion = null;
    persist();
    renderAll();
  });
  const nothing = el('button', null, 'archive them all with the task');
  nothing.addEventListener('click', () => { pendingPromotion = null; renderAll(); });
  all.append(every, nothing);
  node.append(all);
}

function renderArchive() {
  const node = $('archive');
  node.innerHTML = '';
  const archived = store.archivedTasks();
  if (!archived.length) {
    node.append(none('No task has been closed yet.'));
    return;
  }
  for (const task of archived.slice(0, 12)) {
    node.append(row(task.goal || '(unfiled)', `${task.items.length} items · closed ${ago(task.closed)}`));
  }
}

/* ---------------------------------------------------------------- the wire */

function renderWire() {
  const node = $('wire');
  node.innerHTML = '';
  const draft = $('input').value.trim();
  const plan = agent.assemble(draft);

  for (const block of plan.blocks) {
    const box = el('div', `block ${block.layer}`);
    const head = el('div', 'bhead');
    head.append(el('span', null, block.label));
    const right = el('span', 'role');
    const shown = block.shown != null && block.held != null ? `${block.shown}/${block.held} · ` : '';
    right.textContent = `${shown}~${block.tokens} tokens`;
    head.append(right);
    box.append(head);
    box.append(el('pre', null, block.text || '(empty — this layer sent nothing)'));
    node.append(box);
  }

  const total = el('div', 'readonly');
  total.append(row('messages in the request', plan.messages.length));
  total.append(row('estimated prompt', `~${plan.tokens} tokens`));
  if (!draft) total.append(row('plus', 'whatever you type next'));
  node.append(total);
}

function renderCalls() {
  const node = $('callRows');
  node.innerHTML = '';
  const turn = agent.turns[agent.turns.length - 1];
  if (!turn) {
    node.append(none('No turn yet.'));
    return;
  }
  const reply = turn.reply || {};
  node.append(row('1 · the reply', `${reply.usage ? reply.usage.promptTokens : '—'} in · `
    + `${reply.usage ? reply.usage.completionTokens : '—'} out · ${money(reply.cost)}`));
  const extraction = turn.extraction;
  if (!extraction) node.append(row('2 · the extraction', 'not run yet'));
  else if (extraction.skipped) node.append(row('2 · the extraction', extraction.skipped));
  else if (extraction.failed) node.append(row('2 · the extraction', `failed — ${extraction.failed}`));
  else {
    node.append(row('2 · the extraction', `${extraction.usage ? extraction.usage.promptTokens : '—'} in · `
      + `${extraction.usage ? extraction.usage.completionTokens : '—'} out · ${money(extraction.cost)}`));
    node.append(row('it proposed', `${extraction.proposed} candidate${extraction.proposed === 1 ? '' : 's'}`));
    if (extraction.error) node.append(row('and the JSON was', extraction.error));
  }
  const both = (reply.cost || 0) + (extraction && extraction.cost ? extraction.cost : 0);
  node.append(row('the turn cost', money(both)));
}

/* ------------------------------------------------------------ the ablation */

let ablationController = null;

function ablationStatus(message) {
  $('ablationStatus').textContent = message || '';
}

function verdictCell(answer) {
  const cell = el('td');
  const mark = { hit: '✓', miss: '✗', stale: '✗ stale', error: '!' }[answer.verdict] || '?';
  const span = el('span', `verdict ${answer.verdict === 'hit' ? 'hit' : 'miss'}`, mark);
  span.title = answer.detail || answer.answer || '';
  cell.append(span);
  return cell;
}

function renderAblation() {
  const node = $('ablation');
  node.innerHTML = '';
  const result = Ablation.load();
  if (!result) {
    node.append(none('Not run yet. It is about 34 requests — seven turns to build the memory, '
      + 'then five questions under each of four configurations.'));
    return;
  }

  const head = el('div', 'readonly');
  head.append(row('run', `${ago(result.at)} · ${result.model} · ${result.elapsed.toFixed(0)}s`));
  head.append(row('what it cost', money(result.cost)));
  head.append(row('the memory it built',
    `${result.setup.stats.long.items} long-term · ${result.setup.stats.working.items} working`));
  node.append(head);

  // What landed where, which is the brief's first question answered by a
  // transcript rather than by a diagram.
  node.append(el('h2', null, 'what the setup stored, and where'));
  const stored = el('div', 'readonly');
  for (const item of result.setup.stored) {
    const detail = [`${item.layer} · rule ${item.rule}`];
    if (item.agreed === false) detail.push(`model said ${item.proposed}`);
    if (item.previous) detail.push(`replaced "${item.previous}"`);
    stored.append(row(`${item.key}: "${item.value}"`, detail.join(' · ')));
  }
  if (!result.setup.stored.length) stored.append(none('Nothing was stored.'));
  node.append(stored);

  if (result.setup.refused.length) {
    node.append(el('h2', null, 'and what it refused'));
    const refused = el('div', 'readonly');
    for (const item of result.setup.refused) {
      refused.append(row(`${item.key}: "${item.value}"`, `${item.outcome} — ${item.reason || ''}`));
    }
    node.append(refused);
  }

  // The table.
  node.append(el('h2', null, 'the same five questions, four times'));
  const table = el('table');
  const header = el('tr');
  header.append(el('th', null, 'question'));
  for (const run of result.runs) header.append(el('th', null, run.name));
  table.append(header);

  ABLATION_PROBES.forEach((probe, index) => {
    const line = el('tr');
    const question = el('td', 'q');
    question.append(el('div', null, probe.ask));
    question.append(el('div', 'hint', `${probe.layer} · ${probe.why}`));
    line.append(question);
    for (const run of result.runs) line.append(verdictCell(run.answers[index]));
    table.append(line);
  });

  const totals = el('tr');
  totals.append(el('th', null, 'answered'));
  for (const run of result.runs) {
    totals.append(el('th', null, `${run.score}/${ABLATION_PROBES.length}`));
  }
  table.append(totals);
  node.append(table);

  // The answers themselves. A score with no transcript under it is a number
  // asking to be trusted.
  for (const run of result.runs) {
    const runHead = el('div', 'runhead');
    runHead.append(el('span', 'name', run.name));
    runHead.append(el('span', 'hint', Object.entries(run.config)
      .filter(([, on]) => !on).map(([key]) => `${key.replace('use', '').toLowerCase()} off`).join(', ') || 'nothing switched off'));
    node.append(runHead);
    for (const answer of run.answers) {
      const line = el('div', 'answer');
      line.append(el('span', `verdict ${answer.verdict === 'hit' ? 'hit' : 'miss'}`,
        answer.verdict === 'hit' ? '✓ ' : '✗ '));
      line.append(document.createTextNode(answer.answer
        ? answer.answer.replace(/\s+/g, ' ').slice(0, 220)
        : `(${answer.detail || 'nothing'})`));
      node.append(line);
    }
  }
}

async function runAblation() {
  const problem = agent.ready();
  if (problem) { ablationStatus(problem); return; }

  ablationController = new AbortController();
  $('ablationRun').disabled = true;
  $('ablationStop').hidden = false;
  try {
    const ablation = new Ablation({
      transport: deepseekTransport,
      config: { model: agent.config.model, systemPrompt: agent.config.systemPrompt, thinking: 'off' },
    });
    await ablation.run({ report: ablationStatus, signal: ablationController.signal });
    ablationStatus('done.');
  } catch (error) {
    ablationStatus(error.name === 'AbortError' ? 'stopped — nothing was saved.' : `failed: ${error.message}`);
  } finally {
    ablationController = null;
    $('ablationRun').disabled = false;
    $('ablationStop').hidden = true;
    renderAblation();
  }
}

/* -------------------------------------------------------------- the config */

function renderConfig() {
  const node = $('fields');
  if (node.childElementCount) return;  // built once; values are pushed below
  for (const field of Agent.schema) {
    const wrap = el('div', `field ${field.type}`);
    const id = `cfg_${field.key}`;
    const label = el('label', null, field.label);
    label.htmlFor = id;

    let input;
    if (field.type === 'textarea') {
      input = el('textarea');
      input.rows = 4;
    } else if (field.type === 'select') {
      input = el('select');
      for (const option of field.options) input.append(new Option(option, option));
    } else if (field.type === 'toggle') {
      input = el('input');
      input.type = 'checkbox';
    } else if (field.type === 'range') {
      input = el('input');
      input.type = 'range';
      input.min = field.min; input.max = field.max; input.step = field.step;
    } else if (field.type === 'number') {
      input = el('input');
      input.type = 'number';
      input.min = field.min; input.max = field.max; input.step = field.step;
    } else {
      input = el('input');
      input.type = 'text';
    }
    input.id = id;
    input.dataset.key = field.key;

    if (field.type === 'toggle') {
      wrap.append(input, label);
    } else if (field.type === 'range') {
      wrap.append(label);
      const line = el('div', 'rangeline');
      const output = el('output');
      output.id = `${id}_out`;
      line.append(input, output);
      wrap.append(line);
    } else {
      wrap.append(label, input);
    }
    wrap.append(el('div', 'help', field.help));
    node.append(wrap);

    const push = () => {
      const value = field.type === 'toggle' ? input.checked : input.value;
      agent.configure({ [field.key]: value });
      if (field.key === 'extract') $('extract').checked = agent.config.extract;
      syncConfig();
      renderAll();
      persist();
    };
    input.addEventListener(field.type === 'textarea' || field.type === 'text' ? 'input' : 'change', push);
    if (field.type === 'range') input.addEventListener('input', push);
  }
  syncConfig();
}

function syncConfig() {
  const config = agent.config;
  for (const field of Agent.schema) {
    const input = $(`cfg_${field.key}`);
    if (!input) continue;
    if (field.type === 'toggle') input.checked = Boolean(config[field.key]);
    else input.value = config[field.key];
    const output = $(`cfg_${field.key}_out`);
    if (output) output.textContent = config[field.key];
  }
  const node = $('readonly');
  node.innerHTML = '';
  node.append(row('endpoint', deepseekTransport.endpoint));
  for (const [key, value] of Object.entries(deepseekTransport.displayHeaders())) node.append(row(key, value));
  node.append(row('storage', store.backend.label));
  node.append(row('schema version', Persistence.version));
}

function renderStats() {
  const stats = agent.stats;
  const memoryStats = memory.stats();
  $('stats').textContent = stats.turns
    ? `${stats.turns} turns · ${stats.calls} requests · ${money(stats.replyCost + stats.extractionCost)} `
      + `(${money(stats.extractionCost)} of it remembering) · `
      + `${memoryStats.short.items} messages, ${memoryStats.working.items} task items, ${memoryStats.long.items} known about you`
    : `no turns yet · ${memoryStats.long.items} things known about you from before`;
  $('sessionMeta').textContent = `${memory.short.length} messages · saved ${ago(dialogue.updated)}`;
}

function renderAll() {
  renderBoard();
  renderStorage();
  renderSurvives();
  renderRetracted();
  renderPromotion();
  renderRoutes();
  renderTask();
  renderArchive();
  renderWire();
  renderCalls();
  renderAblation();
  renderStats();
}

/* -------------------------------------------------------------- the turn */

async function submit(text) {
  banner('');
  const problem = agent.ready();
  if (problem) { banner(problem); return; }

  const log = $('log');
  EMPTY.hidden = true;
  log.append(messageNode('user', text));
  const pending = messageNode('assistant', '', { pending: true });
  const body = pending.querySelector('.body');
  log.append(pending);
  log.scrollTop = log.scrollHeight;

  controller = new AbortController();
  $('send').disabled = true;
  $('stop').hidden = false;
  $('status').textContent = 'thinking…';

  let streamed = '';
  let turn = null;
  try {
    turn = await agent.send(text, {
      signal: controller.signal,
      onChunk: (chunk, kind) => {
        if (kind !== 'content') return;
        streamed += chunk;
        body.innerHTML = renderMarkdown(streamed);
        log.scrollTop = log.scrollHeight;
      },
    });
  } catch (error) {
    pending.remove();
    banner(error.name === 'AbortError' ? 'Stopped.' : error.message,
      error.name === 'AbortError' ? 'notice' : 'error');
    $('send').disabled = false;
    $('stop').hidden = true;
    $('status').textContent = '';
    return;
  } finally {
    controller = null;
  }

  pending.classList.remove('pending');
  $('stop').hidden = true;
  $('status').textContent = agent.config.extract ? 'remembering…' : '';
  renderAll();
  persist();

  // The second request. The reply is already on screen and the conversation is
  // already usable; this only decides what survives it.
  const outcome = await agent.remember(turn);
  if (outcome && outcome.failed) banner(`The reply arrived; remembering it did not: ${outcome.failed}`, 'notice');
  if (turn.entries) pending.append(storedStrip(turn.entries));

  $('send').disabled = false;
  $('status').textContent = '';
  renderAll();
  persist();
}

/* -------------------------------------------------------------- the wiring */

function wire() {
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('input');
    const text = input.value.trim();
    if (!text || agent.busy) return;
    input.value = '';
    submit(text);
  });

  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('input').addEventListener('input', renderWire);

  $('stop').addEventListener('click', () => { if (controller) controller.abort(); });

  $('reset').addEventListener('click', () => {
    agent.resetDialogue();
    dialogue = store.createDialogue({ short: memory.short.snapshot() });
    agent.dialogueId = dialogue.id;
    persist();
    renderChat();
    renderAll();
    banner('New conversation. The task and everything known about you came with it.', 'notice');
  });

  $('extract').addEventListener('change', (event) => {
    agent.configure({ extract: event.target.checked });
    syncConfig();
  });

  $('title').addEventListener('change', (event) => {
    dialogue = { ...dialogue, title: event.target.value.trim() || 'Untitled' };
    persist();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      for (const panel of document.querySelectorAll('.tabpanel')) {
        panel.hidden = panel.id !== `${tab.dataset.tab}Panel`;
      }
      renderAll();
    });
  }

  $('ablationRun').addEventListener('click', runAblation);
  $('ablationStop').addEventListener('click', () => { if (ablationController) ablationController.abort(); });
  $('ablationClear').addEventListener('click', () => { Ablation.clear(); ablationStatus(''); renderAblation(); });

  $('routeFilter').addEventListener('change', renderRoutes);
  $('clearLog').addEventListener('click', () => { agent.router.clearLog(); persist(); renderRoutes(); });

  for (const button of document.querySelectorAll('[data-wipe]')) {
    button.addEventListener('click', () => {
      const which = button.dataset.wipe;
      const what = { short: 'every conversation', working: 'every task', long: 'everything known about you', all: 'all three layers' }[which];
      if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
      store.wipe(which);
      // The layers in memory have to be emptied too, or the next save would
      // write them straight back and the demonstration would prove nothing.
      if (which === 'long' || which === 'all') memory.long.clear();
      if (which === 'working' || which === 'all') memory.working.clear();
      if (which === 'short' || which === 'all') {
        memory.short.clear();
        agent.router.clearLog();
        dialogue = store.createDialogue({ short: memory.short.snapshot() });
        agent.dialogueId = dialogue.id;
      }
      renderChat();
      renderAll();
      banner(`Deleted ${what}. Ask the agent something it used to know.`, 'notice');
    });
  }

  const key = $('key');
  key.value = getKey();
  key.addEventListener('input', () => {
    setKey(key.value);
    syncConfig();
    banner(agent.ready(), 'notice');
  });

  const model = $('model');
  for (const name of deepseekTransport.models) model.append(new Option(name, name));
  model.value = agent.config.model;
  model.addEventListener('change', () => { agent.configure({ model: model.value }); syncConfig(); });
}

/* ------------------------------------------------------------------ start */

boot();
wire();
renderRules();
renderConfig();
$('title').value = dialogue.title;
$('extract').checked = agent.config.extract;
renderChat();
/* Save once at boot. Nothing has been said yet, so this writes three nearly
 * empty records — which is the point: the storage panel should be able to show
 * three namespaces before anybody has typed anything, and the restore path
 * should be the one that runs on the second page load rather than a path that
 * only ever runs after a turn. */
persist();
renderAll();

/* The demonstration, on the one screen where it cannot be missed.
 *
 * Long-term memory that is only visible in a panel is a panel. Long-term
 * memory that greets you before you have said anything is the claim the brief
 * is actually asking about, and this line is the whole of it. */
const carried = memory.long.all();
const problem = agent.ready();
if (carried.length && !memory.short.length) {
  const name = memory.long.get('profile', 'name');
  banner(`${carried.length} thing${carried.length === 1 ? '' : 's'} came back from earlier conversations`
    + `${name ? `, including that you are called ${name.value}` : ''}. `
    + `This conversation is empty; that store is not.${problem ? ` — ${problem}` : ''}`, 'notice');
} else {
  banner(problem, 'notice');
}
