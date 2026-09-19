/* The interface, and the turn underneath it.
 *
 * It owns the DOM and nothing else. Every render reads the state by folding the
 * log, and every decision about what may be done next comes from
 * `Lifecycle.offers(state)` — so there is no list of buttons anywhere in this
 * file that could drift from the table the runtime adjudicates against. A
 * button that is disabled is disabled because a guard is shut, and it says
 * which one.
 *
 * One model move is: compile → ask → parse → adjudicate. When the runtime
 * refuses, the model gets exactly one more attempt with the refusal fed back,
 * and then the turn passes to the person whatever it wanted. One retry, and
 * counted. Unbounded retrying would make the page feel better and the evidence
 * worthless — you could no longer tell a model that stays inside the lifecycle
 * from one that is being made to.
 */

const el = (id) => document.getElementById(id);

const ATTEMPTS = 2;   // the first, and one retry
const MOVES = 14;     // the most accepted model moves one send will drive

const app = {
  log: [],
  busy: false,
  streaming: '',
  abort: null,
  note: '',
  target: null,
};

function stateNow() {
  return Lifecycle.reduce(app.log);
}

/* ------------------------------------------------------------------ moving */

/* The only way anything enters the log. A refused move is written down too —
 * what was attempted is the record this task exists to produce — and carries
 * the refusal as the person would read it, which is also what the model was
 * shown. */
function commit(move, say = '') {
  const result = Lifecycle.step(stateNow(), move);
  const entry = result.ok
    ? { ...move, say }
    : {
      ...move,
      say,
      rejected: true,
      reason: result.rejection.reason,
      refusal: Protocol.explain(result.rejection, 'user'),
    };
  app.log = Store.append(app.log, entry);
  return result;
}

function userMoveFor(state, text) {
  if (state.state === null) return { type: 'transition', actor: 'user', trigger: 'start', goal: text };
  if (state.question) return { type: 'action', actor: 'user', kind: 'answer', text };
  return { type: 'action', actor: 'user', kind: 'remark', text };
}

async function runModel() {
  if (!Api.getKey()) { app.note = Api.ready(); return; }
  app.abort = new AbortController();
  let moved = 0;

  try {
    while (Lifecycle.turn(stateNow()) === 'model' && moved < MOVES) {
      let rejection = null;
      let landed = false;

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        app.streaming = '';
        render();

        const state = stateNow();
        const reply = await Api.send({
          model: el('model').value,
          messages: Protocol.messages(state, { rejection }),
          temperature: Number(el('temperature').value) || 0,
          signal: app.abort.signal,
          onChunk: (chunk) => { app.streaming += chunk; paintStream(); },
        });

        const parsed = Protocol.parse(reply.text);
        if (!parsed.ok) {
          rejection = { move: null, reason: parsed.reason, detail: parsed.detail, guards: null, route: null };
          app.log = Store.append(app.log, {
            type: 'action', actor: 'model', kind: '(unreadable)', say: parsed.say,
            rejected: true, reason: parsed.reason,
            refusal: `REFUSED — ${parsed.reason}\n  ${parsed.detail}`,
            raw: String(reply.text || '').slice(0, 1200),
          });
          continue;
        }

        const result = commit(parsed.move, parsed.say);
        if (result.ok) { landed = true; moved += 1; break; }
        rejection = result.rejection;
      }

      if (!landed) {
        app.note = 'two attempts, both refused — the turn is back with you';
        break;
      }
    }
    if (moved >= MOVES) app.note = `${MOVES} moves in one go — stopping so you can look`;
  } catch (error) {
    app.note = error.name === 'AbortError' ? 'stopped' : error.message;
  } finally {
    app.busy = false;
    app.streaming = '';
    app.abort = null;
    render();
  }
}

async function send() {
  if (app.busy) return;
  const text = el('request').value.trim();
  const state = stateNow();

  if (text) {
    const result = commit(userMoveFor(state, text), '');
    if (!result.ok) {
      app.note = `${result.rejection.reason} — ${result.rejection.detail}`;
      render();
      return;
    }
    el('request').value = '';
  } else if (Lifecycle.turn(state) !== 'model') {
    app.note = 'nothing to send, and the machine is waiting on you';
    render();
    return;
  }

  app.busy = true;
  app.note = '';
  render();
  await runModel();
}

/* A move the person makes with a button rather than with words. */
async function take(move) {
  if (app.busy) return;
  const result = commit(move);
  app.note = result.ok ? '' : `${result.rejection.reason} — ${result.rejection.detail}`;
  if (!result.ok) { render(); return; }
  if (Lifecycle.turn(stateNow()) === 'model' && Api.getKey()) {
    app.busy = true;
    render();
    await runModel();
  } else {
    render();
  }
}

/* ------------------------------------------------------------- the drawing */

function tag(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function paintStream() {
  const box = el('stream');
  box.hidden = !app.streaming;
  box.textContent = app.streaming;
}

function moveLabel(entry) {
  if (entry.type === 'transition') return entry.trigger || `→ ${entry.to}`;
  return entry.kind;
}

function chip(entry) {
  const node = tag('span', `chip ${entry.type}${entry.rejected ? ' refused' : ''}`);
  node.append(tag('b', null, moveLabel(entry)));
  if (entry.type === 'transition' && !entry.rejected) {
    const edge = Lifecycle.edgeByTrigger(entry.trigger);
    if (edge) node.append(tag('span', 'dim', ` ${edge.from} → ${edge.to}`));
  }
  if (entry.step) node.append(tag('span', 'dim', ` ${entry.step}`));
  return node;
}

function bubbleFor(entry) {
  const bubble = tag('div', `bubble ${entry.actor}${entry.rejected ? ' refused' : ''}`);
  const byline = tag('div', 'byline');
  byline.append(tag('span', 'whom', entry.actor === 'user' ? 'you' : 'the assistant'));
  byline.append(chip(entry));
  bubble.append(byline);

  const said = entry.say || entry.text || entry.goal || entry.question || entry.note || entry.reason;
  if (said) {
    const body = tag('div', 'said');
    body.innerHTML = renderMarkdown(String(said));
    bubble.append(body);
  }
  if (entry.artifact) {
    const art = tag('details', 'artifact');
    art.append(tag('summary', null, `the work attached to ${entry.step}`));
    art.append(tag('pre', 'block', entry.artifact));
    bubble.append(art);
  }
  if (entry.verdicts) {
    const list = tag('div', 'verdicts');
    for (const verdict of entry.verdicts) {
      list.append(tag('div', `verdict ${verdict.verdict}`, `${verdict.id} ${verdict.verdict} — ${verdict.evidence}`));
    }
    bubble.append(list);
  }
  if (entry.rejected) bubble.append(tag('pre', 'refusalblock', entry.refusal || ''));
  return bubble;
}

function paintLog() {
  const box = el('log');
  if (!app.log.length) {
    box.replaceChildren(tag('div', 'empty',
      'Nothing has been asked yet. Say what you want done — the assistant will propose a plan, and it cannot start on it until you approve.'));
    return;
  }
  box.replaceChildren(...app.log.map(bubbleFor));
  el('chatCount').textContent = `${app.log.length} moves · ${app.log.filter((e) => e.rejected).length} refused · log ${Store.fingerprint(app.log)}`;
}

/* ------------------------------------------------------------- the aside */

function paintHead(state) {
  el('stateName').textContent = state.state === null ? 'not started' : state.state;
  const whose = Lifecycle.turn(state);
  const bits = [];
  if (state.paused) bits.push('paused');
  bits.push(whose === null ? 'closed' : `waiting on the ${whose === 'user' ? 'person' : 'assistant'}`);
  if (state.rounds) bits.push(`${state.rounds} round trip${state.rounds === 1 ? '' : 's'} through rework`);
  if (state.outcome) bits.push(state.outcome.result);
  el('stateLine').textContent = bits.join(' · ');

  const fresh = el('freshLine');
  if (!state.validation) {
    fresh.className = 'fresh';
    fresh.textContent = `revision ${state.revision} · nothing validated yet`;
  } else {
    const stale = state.validation.at !== state.revision;
    fresh.className = `fresh ${stale ? 'stale' : 'ok'}`;
    fresh.textContent = stale
      ? `revision ${state.revision} · validated at ${state.validation.at} · STALE — ${state.revision - state.validation.at} change(s) since`
      : `revision ${state.revision} · validated at ${state.validation.at} · fresh`;
  }
}

function paintEdges(state) {
  const offered = Lifecycle.offers(state);
  const box = el('edgeList');
  if (!offered.transitions.length) {
    box.replaceChildren(tag('div', 'dim', 'none — the machine is closed'));
    return;
  }
  box.replaceChildren(...offered.transitions.map((edge) => {
    const row = tag('div', `edge ${edge.open ? 'open' : 'shut'}`);
    const head = tag('div', 'edgehead');
    head.append(tag('b', null, edge.trigger));
    head.append(tag('span', 'dim', `${edge.from} → ${edge.to}`));
    head.append(tag('span', 'owner', edge.actor === 'user' ? 'yours' : "the assistant's"));
    head.append(tag('span', 'mark', edge.open ? 'open' : 'shut'));
    row.append(head);
    for (const guard of edge.guards) {
      const line = tag('div', `guard ${guard.holds ? 'holds' : 'shut'}`);
      line.append(tag('span', 'tick', guard.holds ? '✓' : '✗'));
      line.append(tag('span', null, guard.label));
      if (!guard.holds) line.append(tag('span', 'remedy', `— ${guard.remedy}`));
      row.append(line);
    }
    if (edge.blocked === 'question-open') {
      row.append(tag('div', 'guard shut', '✗ a question is waiting for an answer'));
    }
    return row;
  }));
}

function control(edge, state) {
  const row = tag('div', `move ${edge.open ? '' : 'shut'}`);
  const button = tag('button', null, edge.trigger);
  button.setAttribute('type', 'button');
  row.append(button);

  let read = () => ({ type: 'transition', actor: 'user', trigger: edge.trigger });

  if (edge.trigger === 'rework') {
    const picker = document.createElement('select');
    const closed = state.steps.filter((s) => s.status === 'done' || s.status === 'skipped');
    picker.replaceChildren(...closed.map((s) => {
      const option = document.createElement('option');
      option.value = s.id;
      option.textContent = `${s.id} · ${s.title}`;
      return option;
    }));
    const why = document.createElement('input');
    why.placeholder = 'what was wrong with it';
    row.append(picker, why);
    read = () => ({
      type: 'transition', actor: 'user', trigger: 'rework', step: picker.value, reason: why.value.trim(),
    });
  }

  if (edge.trigger === 'abandon') {
    const why = document.createElement('input');
    why.placeholder = 'why you are stopping';
    row.append(why);
    read = () => ({ type: 'transition', actor: 'user', trigger: 'abandon', reason: why.value.trim() });
  }

  button.disabled = !edge.open || app.busy;
  if (!edge.open) {
    const shut = edge.guards.filter((g) => !g.holds);
    row.append(tag('span', 'dim', shut.length ? `shut: ${shut.map((g) => g.label).join('; ')}` : 'shut'));
  }
  button.addEventListener('click', () => take(read()));
  return row;
}

function paintMoves(state) {
  const offered = Lifecycle.offers(state);
  const box = el('moves');
  const rows = offered.transitions
    .filter((edge) => edge.actor === 'user')
    .map((edge) => control(edge, state));

  if (offered.actions.some((a) => a.kind === 'revise_plan')) {
    const row = tag('div', 'move');
    const button = tag('button', null, 'send the plan back');
    button.setAttribute('type', 'button');
    button.disabled = app.busy;
    button.addEventListener('click', () => {
      const note = el('request').value.trim();
      if (!note) { app.note = 'say what to change first — the box below'; render(); return; }
      el('request').value = '';
      take({ type: 'action', actor: 'user', kind: 'revise_plan', note });
    });
    row.append(button, tag('span', 'dim', 'uses what is in the box below'));
    rows.push(row);
  }

  if (!rows.length) rows.push(tag('div', 'dim', 'nothing is yours to move right now'));
  box.replaceChildren(...rows);
}

function paintPlan(state) {
  const box = el('planList');
  if (!state.steps.length) {
    box.replaceChildren(tag('div', 'dim', 'nothing planned yet'));
  } else {
    box.replaceChildren(...state.steps.map((step) => {
      const row = tag('div', `step ${step.status}`);
      row.append(tag('span', 'stepid', step.id));
      row.append(tag('span', 'status', step.status));
      row.append(tag('span', 'what', step.title));
      if (step.note) row.append(tag('div', 'dim', `sent back: ${step.note}`));
      return row;
    }));
  }

  const crits = el('critList');
  if (!state.acceptance.length) {
    crits.replaceChildren(tag('div', 'dim', 'not yet fixed'));
    return;
  }
  crits.replaceChildren(...state.acceptance.map((criterion) => {
    const row = tag('div', `crit ${criterion.verdict}`);
    row.append(tag('span', 'stepid', criterion.id));
    row.append(tag('span', 'status', criterion.verdict));
    row.append(tag('span', 'what', criterion.text));
    if (criterion.evidence) row.append(tag('div', 'dim', criterion.evidence));
    return row;
  }));
}

/* -------------------------------------------------------------- the graph */

function paintEdgeTable(state) {
  const table = el('edgeTable');
  const rows = [['trigger', 'from', 'to', 'whose', 'guards, against the state right now']];
  for (const edge of Lifecycle.TRANSITIONS) {
    const here = edge.from === state.state;
    const guards = edge.guards.length
      ? Lifecycle.guardReport(state, edge)
        .map((g) => `${here ? (g.holds ? '✓ ' : '✗ ') : '· '}${g.label}`).join('\n')
      : '— none, this edge is always open to whoever owns it';
    rows.push([edge.trigger, edge.from === null ? '(the start)' : edge.from, edge.to,
      edge.actor === 'user' ? 'the person' : 'the assistant', guards]);
  }
  table.replaceChildren(...rows.map((cells, i) => {
    const tr = document.createElement('tr');
    if (i === 0) tr.className = 'head';
    else if (cells[1] === (state.state === null ? '(the start)' : state.state)) tr.className = 'here';
    for (const cell of cells) tr.append(tag(i === 0 ? 'th' : 'td', null, cell));
    return tr;
  }));
}

function paintRoute(state) {
  el('routeFrom').textContent = `from ${state.state === null ? 'the start' : state.state} to…`;
  el('routeButtons').replaceChildren(...Lifecycle.STATES.map((name) => {
    const button = tag('button', app.target === name ? 'on' : null, name);
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => { app.target = name; render(); });
    return button;
  }));
  el('routeOut').textContent = app.target
    ? Protocol.renderRoute(state, app.target, 'user')
    : 'pick a state.';
}

function paintLogTable() {
  const table = el('logTable');
  const rows = [['#', 'who', 'move', 'verdict']];
  app.log.forEach((entry, i) => {
    rows.push([
      String(i + 1),
      entry.actor || '—',
      `${entry.type === 'transition' ? 'transition' : 'action'} ${moveLabel(entry)}`,
      entry.rejected ? `refused — ${entry.reason}` : 'accepted',
    ]);
  });
  table.replaceChildren(...rows.map((cells, i) => {
    const tr = document.createElement('tr');
    if (i === 0) tr.className = 'head';
    else if (app.log[i - 1] && app.log[i - 1].rejected) tr.className = 'refused';
    for (const cell of cells) tr.append(tag(i === 0 ? 'th' : 'td', null, cell));
    return tr;
  }));
  el('logMeta').textContent = `${app.log.length} moves · fingerprint ${Store.fingerprint(app.log)}`;
}

/* ------------------------------------------------------------- the request */

function paintRequest(state) {
  const block = Protocol.compile(state);
  el('requestText').textContent = block.user;
  el('requestRules').textContent = block.system;
  el('requestMeta').textContent = `${block.tokens} tokens — ${block.rulesTokens} of rules + ${block.stateTokens} of state`;
}

function render() {
  const state = stateNow();
  paintHead(state);
  paintEdges(state);
  paintMoves(state);
  paintPlan(state);
  paintLog();
  paintRequest(state);
  paintEdgeTable(state);
  paintRoute(state);
  paintLogTable();
  paintStream();

  el('note').hidden = !(app.note || app.busy);
  el('note').textContent = app.note || (app.busy ? 'asking…' : '');
  el('send').disabled = app.busy;
  el('stop').hidden = !app.busy;
  el('pauseRun').textContent = state.paused ? 'resume' : 'pause';
  el('pauseRun').disabled = state.state === null || state.state === 'done';
  el('keyNote').textContent = Api.getKey() ? '' : Api.ready();
}

/* ------------------------------------------------------------------ boot */

function boot() {
  const models = Api.models;
  el('model').replaceChildren(...models.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    return option;
  }));
  el('model').value = models[0];

  el('key').value = Api.getKey();
  el('key').addEventListener('change', () => { Api.setKey(el('key').value); render(); });

  el('composer').addEventListener('submit', (event) => { event.preventDefault(); send(); });
  /* Enter sends, shift-enter breaks the line. A textarea in a form does neither
   * on its own, and the alternative is reaching for the mouse every time. */
  el('request').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  el('stop').addEventListener('click', () => { if (app.abort) app.abort.abort(); });

  el('pauseRun').addEventListener('click', () => {
    const paused = stateNow().paused;
    take({ type: 'action', actor: 'user', kind: paused ? 'resume' : 'pause' });
  });

  el('clearRun').addEventListener('click', () => {
    app.log = Store.clear();
    app.note = 'the log is empty — everything else was derived from it, so there is nothing else to clear';
    render();
  });

  el('exportLog').addEventListener('click', () => { el('logJson').value = Store.serialise(app.log); });
  el('importLog').addEventListener('click', () => {
    const result = Store.parse(el('logJson').value);
    if (!result.ok) { app.note = result.error; render(); return; }
    app.log = result.log;
    Store.write(app.log);
    app.note = result.skipped.length
      ? `loaded — ${result.skipped.length} move(s) the runtime refuses today were walked past`
      : 'loaded, and every move in it is still legal';
    render();
  });

  el('diagram').textContent = Protocol.DIAGRAM;

  for (const tabButton of document.querySelectorAll('.tab')) {
    tabButton.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.setAttribute('aria-selected', other === tabButton ? 'true' : 'false');
      }
      for (const pane of document.querySelectorAll('.pane')) {
        pane.hidden = pane.dataset.pane !== tabButton.dataset.tab;
      }
    });
  }

  /* The whole of resuming. There is no branch here for "came back after a
   * pause" and no branch for "first visit", because the log is the only thing
   * that was kept and everything else is worked out from it either way. */
  app.log = Store.read();
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
