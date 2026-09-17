/* The interface, and the turn engine underneath it.
 *
 * It owns the DOM and one mutable thing: the log. Everything on screen is
 * derived from Machine.reduce(log) on every render, which means the page has
 * no state of its own that could drift from the machine's — and a reload is
 * indistinguishable from never having left.
 *
 * The engine continues by itself while the machine is waiting on the model,
 * and hands back the moment it is waiting on a person. That is the whole of
 * what makes this an agent rather than a form, and it runs on a leash: six
 * consecutive model turns, then it stops whatever the machine wants.
 */

const el = (id) => document.getElementById(id);

const BUDGET = 6;

const app = {
  log: [],
  state: Machine.empty(),
  busy: false,
  streaming: '',
  abort: null,
  turns: 0,            // consecutive model turns since a person last moved
  note: '',            // a line under the header, for whatever just happened
  auto: true,
};

/* ------------------------------------------------------------------ the fold */

function refold() {
  app.state = Machine.reduce(app.log);
}

function record(entry) {
  app.log = Store.append(app.log, entry);
  refold();
}

/* Every move goes through here, the model's and the person's alike. A rejected
 * event is written to the log too — with `rejected` on it, so the fold walks
 * past it — because the record of what was refused is the only evidence that
 * the guard does anything. */
function commit(event, say = '') {
  const moved = Machine.step(app.state, event);
  if (!moved.ok) {
    record({ ...event, say, rejected: moved.rejection.reason, detail: moved.rejection.detail });
    return moved.rejection;
  }
  record(say ? { ...event, say } : event);
  if (moved.broken.length) {
    app.note = `the machine broke an invariant: ${moved.broken.join('; ')}`;
  }
  return null;
}

function act(event, say = '') {
  app.turns = 0;                 // a person moved; the leash is reset
  const rejection = commit(event, say);
  if (rejection) app.note = `${rejection.reason} — ${rejection.detail}`;
  else app.note = '';
  render();
  schedule();
}

/* -------------------------------------------------------------- the model turn */

function schedule() {
  if (!app.auto) return;
  const { state } = app;
  if (app.busy || state.paused || !state.expect || state.expect.actor !== 'model') return;
  if (app.turns >= BUDGET) {
    app.note = `the leash: ${BUDGET} model turns in a row without a person. Press continue.`;
    render();
    return;
  }
  setTimeout(turn, 30);
}

async function turn() {
  const { state } = app;
  if (app.busy || state.paused || !state.expect || state.expect.actor !== 'model') return;
  if (!Api.getKey()) { app.note = Api.ready(); render(); return; }

  app.busy = true;
  app.turns += 1;
  let rejection = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    app.streaming = '';
    app.note = attempt ? 'rejected — one more attempt' : '';
    render();

    const controller = new AbortController();
    app.abort = controller;
    let reply;
    try {
      reply = await Api.send({
        model: el('model').value,
        messages: Protocol.messages(app.state, { rejection }),
        temperature: Number(el('temperature').value) || 0,
        maxTokens: 2200,
        stream: true,
        signal: controller.signal,
        onChunk: (chunk) => { app.streaming += chunk; paintStream(); },
      });
    } catch (error) {
      app.abort = null;
      app.busy = false;
      app.streaming = '';
      app.note = error.name === 'AbortError' ? '' : `the request failed: ${error.message}`;
      render();
      return;
    }
    app.abort = null;

    // The pause landed while the tokens were in flight. The reply is dropped:
    // acting on it would move a machine the person has stopped.
    if (app.state.paused) break;

    const parsed = Protocol.parse(reply.text);
    if (!parsed.ok) {
      rejection = { kind: null, reason: parsed.reason, detail: parsed.detail };
      record({ kind: 'malformed_reply', say: reply.text.slice(0, 400), rejected: parsed.reason, detail: parsed.detail });
      continue;
    }

    rejection = commit(parsed.event, parsed.say);
    if (!rejection) break;
  }

  app.busy = false;
  app.streaming = '';
  if (rejection) {
    app.note = `${rejection.reason} — ${rejection.detail}. The turn goes back to you.`;
  }
  render();
  schedule();
}

function pause() {
  if (app.abort) app.abort.abort();
  app.abort = null;
  app.busy = false;
  app.streaming = '';
  act({ kind: 'pause' });
}

/* ------------------------------------------------------------------ painting */

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function button(label, onClick, className = '') {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

function paintStream() {
  const target = el('stream');
  if (!target) return;
  target.hidden = !app.streaming;
  target.textContent = app.streaming;
  target.scrollTop = target.scrollHeight;
}

function paintRail() {
  const rail = el('rail');
  rail.replaceChildren();
  for (const stage of Machine.STAGES) {
    const reached = Machine.STAGES.indexOf(stage) < Machine.STAGES.indexOf(app.state.stage);
    const here = app.state.stage === stage;
    const chip = node('span', `stagechip${here ? ' here' : ''}${reached ? ' past' : ''}`, stage);
    rail.append(chip);
    if (stage !== 'done') rail.append(node('span', 'arrow', '→'));
  }
  el('pausedFlag').hidden = !app.state.paused;
}

function paintSteps() {
  const list = el('steps');
  list.replaceChildren();
  if (!app.state.steps.length) {
    list.append(node('p', 'dim', app.state.stage === null
      ? 'No task yet.'
      : 'Nothing planned yet — the model is being asked for steps and for what would count as done.'));
    return;
  }
  for (const step of app.state.steps) {
    const row = node('div', `step ${step.status}`);
    row.append(node('span', 'stepid', step.id));
    row.append(node('span', 'stepstatus', step.status === 'active' ? 'active' : step.status));
    const body = node('div', 'stepbody');
    body.append(node('div', 'steptitle', step.title));
    if (step.note) body.append(node('div', 'stepnote', `skipped — ${step.note}`));
    if (step.artifact) {
      const details = node('details', 'artifact');
      details.append(node('summary', '', `artifact · ${Protocol.estimate(step.artifact)} tokens`));
      const pre = node('pre', '', step.artifact);
      details.append(pre);
      body.append(details);
    }
    row.append(body);
    list.append(row);
  }
}

function paintCriteria() {
  const list = el('criteria');
  list.replaceChildren();
  if (!app.state.acceptance.length) {
    list.append(node('p', 'dim', 'Not fixed yet. Planning cannot close without it.'));
    return;
  }
  for (const criterion of app.state.acceptance) {
    const row = node('div', `criterion ${criterion.verdict}`);
    row.append(node('span', 'stepid', criterion.id));
    const body = node('div', 'stepbody');
    body.append(node('div', '', criterion.text));
    if (criterion.evidence) body.append(node('div', 'stepnote', `${criterion.verdict} — ${criterion.evidence}`));
    row.append(body);
    list.append(row);
  }
}

function paintDecisions() {
  const box = el('decisions');
  box.replaceChildren();
  box.hidden = !app.state.decisions.length;
  for (const decision of app.state.decisions) {
    const row = node('div', 'decision');
    if (decision.question) row.append(node('div', 'dim', decision.question));
    row.append(node('div', '', decision.text));
    box.append(row);
  }
}

function paintFeed() {
  const feed = el('feed');
  feed.replaceChildren();
  for (const entry of app.log) {
    if (entry.kind === 'pause' || entry.kind === 'resume') {
      feed.append(node('div', 'marker', entry.kind === 'pause' ? '⏸ paused here' : '▶ resumed here'));
      continue;
    }
    const actor = entry.rejected || (Machine.EVENTS[entry.kind] || {}).actor === 'model' ? 'model' : 'user';
    const row = node('div', `turn ${actor}${entry.rejected ? ' rejected' : ''}`);
    const head = node('div', 'turnhead');
    head.append(node('span', 'kind', entry.kind));
    if (entry.rejected) head.append(node('span', 'reason', entry.rejected));
    row.append(head);
    if (entry.say) {
      const said = node('div', 'say');
      said.innerHTML = renderMarkdown(entry.say);
      row.append(said);
    }
    if (entry.detail) row.append(node('div', 'detail', entry.detail));
    feed.append(row);
  }
  feed.scrollTop = feed.scrollHeight;
}

function paintControls() {
  const box = el('controls');
  box.replaceChildren();
  const { state } = app;

  if (state.paused) {
    box.append(node('p', 'waiting', 'Paused. The stage, the step and the open slot are exactly where you left them.'));
    box.append(button('resume', () => act({ kind: 'resume' }), 'primary'));
    return;
  }

  if (state.stage === 'done') {
    box.append(node('p', 'waiting',
      `${state.outcome.result} — ${state.outcome.unmet.length
        ? `${state.outcome.unmet.length} criteria were never met (${state.outcome.unmet.join(', ')})`
        : 'every criterion was met'}`));
    box.append(button('start another task', reset));
    return;
  }

  if (!state.expect) return;

  if (state.expect.actor === 'model') {
    box.append(node('p', 'waiting', app.busy
      ? `the model is answering — ${state.expect.why}`
      : state.expect.why));
    if (!app.busy && app.turns >= BUDGET) box.append(button('continue', () => { app.turns = 0; schedule(); }, 'primary'));
    if (app.busy) box.append(button('pause', pause));
    else box.append(button('pause', pause));
    return;
  }

  const kinds = state.expect.kinds;

  if (kinds.includes('start')) {
    const form = node('form', 'ask');
    const input = node('textarea');
    input.rows = 2;
    input.placeholder = 'A task with steps in it — something that decomposes, produces work, and can be judged.';
    const go = node('button', 'primary', 'start');
    form.append(input, go);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) act({ kind: 'start', goal: input.value.trim() });
    });
    box.append(form);
    return;
  }

  if (kinds.includes('approve_plan')) {
    box.append(node('p', 'waiting', 'The plan and its criteria need your approval. The criteria cannot be changed after this.'));
    const row = node('div', 'buttonrow');
    row.append(button('approve', () => act({ kind: 'approve_plan' }), 'primary'));
    row.append(button('pause', pause));
    box.append(row);
    const form = node('form', 'ask');
    const input = node('input');
    input.placeholder = 'or say what to change, and it plans again';
    form.append(input, node('button', '', 'revise'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) act({ kind: 'revise_plan', note: input.value.trim() });
    });
    box.append(form);
    return;
  }

  if (kinds.includes('answer')) {
    box.append(node('p', 'question', state.expect.why));
    const form = node('form', 'ask');
    const input = node('input');
    input.placeholder = 'your answer — it becomes a decision and is never asked about again';
    form.append(input, node('button', 'primary', 'answer'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) act({ kind: 'answer', text: input.value.trim() });
    });
    box.append(form);
    box.append(button('pause', pause));
    return;
  }

  if (kinds.includes('accept')) {
    box.append(node('p', 'waiting', state.expect.why));
    box.append(button('accept', () => act({ kind: 'accept' }), 'primary'));
    const form = node('form', 'ask');
    const input = node('input');
    input.placeholder = 'or abandon it, with a reason';
    form.append(input, node('button', '', 'abandon'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) act({ kind: 'abandon', reason: input.value.trim() });
    });
    box.append(form);
  }
}

function paintRequest() {
  const block = Protocol.compile(app.state);
  el('requestText').textContent = block.user;
  el('requestRules').textContent = block.system;
  el('requestMeta').textContent =
    `${block.stateTokens} tokens of state · ${block.rulesTokens} tokens of rules (identical every turn) · ${Protocol.fingerprint(block.text)}`;
}

function paintLogTab() {
  const table = el('logRows');
  table.replaceChildren();
  for (const [index, entry] of app.log.entries()) {
    const row = node('tr', entry.rejected ? 'rejected' : '');
    row.append(node('td', 'num', String(index + 1)));
    row.append(node('td', '', new Date(entry.at || 0).toLocaleTimeString()));
    row.append(node('td', '', entry.kind));
    row.append(node('td', '', entry.rejected ? `✗ ${entry.rejected}` : '✓'));
    // For a malformed reply the raw text is the evidence, so both the guard's
    // reason and what the model actually sent belong in the row.
    row.append(node('td', 'detailcell', [entry.detail, entry.say].filter(Boolean).join(' · ')));
    table.append(row);
  }
  const rejected = app.log.filter((entry) => entry.rejected).length;
  el('logMeta').textContent = app.log.length
    ? `${app.log.length} entries · ${app.log.length - rejected} accepted · ${rejected} rejected`
    : 'nothing yet';
  el('logJson').value = Store.serialise(app.log);
}

function render() {
  paintRail();
  paintSteps();
  paintCriteria();
  paintDecisions();
  paintFeed();
  paintControls();
  paintRequest();
  paintLogTab();
  paintStream();
  el('note').textContent = app.note;
  el('note').hidden = !app.note;
  el('goalLine').textContent = app.state.goal || 'no task';
  el('keyNote').textContent = Api.getKey() ? '' : 'no key — the machine runs, but nothing can be asked';
}

/* --------------------------------------------------------------------- boot */

function reset() {
  if (app.abort) app.abort.abort();
  app.log = Store.clear();
  app.turns = 0;
  app.note = '';
  refold();
  render();
}

function boot() {
  for (const model of Api.models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    el('model').append(option);
  }
  el('model').value = Api.models[0];

  el('key').value = Api.getKey();
  el('key').addEventListener('change', () => { Api.setKey(el('key').value); render(); });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.setAttribute('aria-selected', String(other === tab));
      }
      for (const pane of document.querySelectorAll('.pane')) {
        pane.hidden = pane.dataset.pane !== tab.dataset.tab;
      }
    });
  }

  el('exportLog').addEventListener('click', () => {
    el('logJson').select();
    try { document.execCommand('copy'); } catch (error) { /* selection is enough */ }
    el('logMeta').textContent = 'copied — that file replays to exactly this screen';
  });

  el('importLog').addEventListener('click', () => {
    const parsed = Store.parse(el('logJson').value);
    if (!parsed.ok) { el('logMeta').textContent = parsed.error; return; }
    app.log = parsed.log;
    Store.write(app.log);
    app.turns = 0;
    refold();
    render();
    el('logMeta').textContent = parsed.skipped.length
      ? `replayed, and ${parsed.skipped.length} entries the guard would refuse today were skipped`
      : 'replayed';
  });

  el('clearLog').addEventListener('click', reset);

  app.log = Store.read();
  refold();
  render();
  schedule();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { app, boot, commit, act, turn, render };
