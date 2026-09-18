/* The interface, and the turn underneath it.
 *
 * It owns the DOM and nothing else. The invariants come from the store on
 * every render and the request is recompiled from them on every send, so there
 * is no copy of a rule anywhere in this file that could drift from the one the
 * checker applies.
 *
 * One turn is: compile → ask → adjudicate → render. When the checker refuses,
 * the model gets exactly one more attempt with the violation fed back, and
 * then the turn ends whatever it wants. One, and counted. Unbounded repair
 * would make the page feel better and the evidence worthless — you could no
 * longer tell a model that obeys from one that is being made to.
 */

const el = (id) => document.getElementById(id);

const ATTEMPTS = 2;                    // the first, and one retry

const app = {
  busy: false,
  streaming: '',
  abort: null,
  note: '',
  turns: [],
};

/* --------------------------------------------------------------- the turn */

function currentSet() {
  return Store.active();
}

async function ask() {
  const request = el('request').value.trim();
  if (!request || app.busy) return;
  if (!Api.getKey()) { app.note = Api.ready(); render(); return; }

  const set = currentSet();
  app.busy = true;
  app.note = '';
  app.abort = new AbortController();
  const attempts = [];

  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      app.streaming = '';
      render();

      const messages = Protocol.messages(set, request, attempts.map((one) => ({
        reply: one.raw,
        feedback: one.feedback,
      })));

      const reply = await Api.send({
        model: el('model').value,
        messages,
        temperature: Number(el('temperature').value) || 0,
        signal: app.abort.signal,
        onChunk: (chunk) => { app.streaming += chunk; paintStream(); },
      });

      const result = Protocol.adjudicate(set, reply.text);
      const turn = record(set, request, attempt, result, reply);

      if (result.ok) break;
      if (attempt === ATTEMPTS - 1) break;
      attempts.push({
        raw: reply.text,
        feedback: result.stage === 'checker'
          ? Protocol.feedback(result.verdict, result.contradictions)
          : `That reply was rejected before it was read: ${result.rejection.reason} — ${result.rejection.detail}. ${Protocol.reasonText(result.rejection.reason)}. Answer again, as one JSON object.`,
      });
      void turn;
    }
    el('request').value = '';
  } catch (error) {
    app.note = error.name === 'AbortError' ? 'stopped' : error.message;
  } finally {
    app.busy = false;
    app.streaming = '';
    app.abort = null;
    render();
  }
}

/* Everything a turn produced, written down before anything is drawn. The log
 * is the evidence; the screen is a view of it. */
function record(set, request, attempt, result, reply) {
  const turn = {
    set: set.id,
    rev: set.rev,
    request,
    attempt,
    move: result.envelope ? result.envelope.move : null,
    say: result.envelope ? result.envelope.say : '',
    considered: result.envelope ? result.envelope.considered : [],
    declare: result.envelope ? result.envelope.declare : null,
    under: result.envelope ? result.envelope.under : [],
    alternative: result.envelope ? result.envelope.alternative : null,
    amend: result.envelope ? result.envelope.amend : null,
    violations: result.verdict ? result.verdict.violations : [],
    bearing: result.verdict ? result.verdict.bearing : [],
    contradictions: result.contradictions || [],
    missed: result.missed || [],
    grade: result.grade || null,
    rejection: result.rejection,
    stage: result.stage,
    ok: result.ok,
    raw: result.envelope ? null : String(reply.text || '').slice(0, 2000),
    usage: reply.usage || null,
  };
  app.turns = Store.appendTurn(turn);
  return turn;
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

function verdictRows(turn) {
  const wrap = tag('div', 'marks');
  for (const violation of turn.violations) {
    const row = tag('div', 'reason');
    row.append(tag('span', 'stepid', violation.id));
    row.append(tag('span', 'kind', violation.code));
    row.append(tag('span', 'detail',
      `${violation.text}  ·  checked as: ${violation.clause}  ·  you declared ${violation.facet}: ${violation.offending.join(', ')}`));
    wrap.append(row);
  }
  for (const found of turn.contradictions) {
    const row = tag('div', 'reason');
    row.append(tag('span', 'stepid', 'prose'));
    row.append(tag('span', 'kind', 'contradiction'));
    row.append(tag('span', 'detail',
      `implies ${found.facet}: ${found.implied}, which was not declared — from "${found.evidence}". A heuristic.`));
    wrap.append(row);
  }
  return wrap;
}

function declaration(turn) {
  const wrap = tag('div', 'marks');
  const touched = Invariant.FACET_NAMES.filter((facet) => turn.declare && turn.declare[facet].length);
  if (!touched.length) return tag('p', 'dim', 'declared nothing at all — which is itself a claim');
  for (const facet of touched) {
    const row = tag('div', 'cell');
    row.append(tag('span', 'stepid', facet));
    row.append(tag('span', 'detail', turn.declare[facet].join(', ')));
    wrap.append(row);
  }
  return wrap;
}

const GRADE_TEXT = {
  cites: 'names an invariant, in the prose the human reads',
  names: 'names the specific thing that collided',
  classifies: 'one move, not a hedge',
  offers: 'offers a way through, or says plainly there is none',
};

function gradeRow(turn) {
  const wrap = tag('div', 'marks');
  for (const key of Object.keys(GRADE_TEXT)) {
    const row = tag('div', 'cell');
    row.append(tag('span', 'marker', turn.grade[key] ? '✓' : '✗'));
    row.append(tag('span', 'detail', GRADE_TEXT[key]));
    wrap.append(row);
  }
  return wrap;
}

function turnNode(turn) {
  const node = tag('div', 'turn');

  const head = tag('div', 'turnhead');
  head.append(tag('span', 'stagechip', turn.move || 'unparsed'));
  if (turn.attempt > 0) head.append(tag('span', 'kind', `attempt ${turn.attempt + 1} of ${ATTEMPTS}`));
  head.append(tag('span', 'kind', turn.ok ? 'accepted' : `refused · ${turn.rejection.reason}`));
  head.append(tag('span', 'dim', `${turn.set} · revision ${turn.rev}`));
  node.append(head);

  node.append(tag('div', 'question', turn.request));

  if (turn.say) {
    const said = tag('div', 'say');
    said.innerHTML = renderMarkdown(turn.say);
    node.append(said);
  } else {
    node.append(tag('pre', 'block', turn.raw || ''));
  }

  if (turn.move === 'propose') {
    node.append(tag('div', 'panelhead', 'what it says it touches'));
    node.append(declaration(turn));
  }

  if (turn.violations.length || turn.contradictions.length) {
    node.append(tag('div', 'panelhead', turn.violations.length
      ? 'the checker refused it — this is not the model declining, it is the runtime'
      : 'the prose and the declaration disagree'));
    node.append(verdictRows(turn));
  }

  if (turn.move === 'refuse') {
    node.append(tag('div', 'panelhead', 'how the refusal reads'));
    node.append(gradeRow(turn));
    if (turn.alternative) node.append(tag('div', 'artifact', turn.alternative));
  }

  if (turn.move === 'request_amendment' && turn.amend) {
    node.append(tag('div', 'panelhead', `it wants ${turn.amend.id} amended — you decide, on the invariants tab`));
    node.append(tag('div', 'artifact', turn.amend.case));
  }

  if (turn.bearing.length || turn.considered.length) {
    const line = turn.missed.length
      ? `considered ${turn.considered.join(', ') || 'nothing'} — and ${turn.missed.join(', ')} bore on this and went unnamed`
      : `considered ${turn.considered.join(', ') || 'nothing'} — nothing that bore went unnamed`;
    node.append(tag('div', turn.missed.length ? 'stepnote' : 'dim', line));
  }

  if (turn.usage) {
    node.append(tag('div', 'dim',
      `${turn.usage.promptTokens} prompt · ${turn.usage.cacheHitTokens} of them cached · ${turn.usage.completionTokens} out`));
  }

  return node;
}

/* ---------------------------------------------------------- the invariants */

function invariantNode(one, set) {
  const node = tag('div', 'step');
  const head = tag('div', 'stepbody');
  head.append(tag('span', 'stepid', one.id));
  head.append(tag('span', 'kind', one.kind));
  head.append(tag('span', 'stepstatus', one.enforcement === 'soft' ? 'unverified' : 'checked'));
  node.append(head);
  node.append(tag('div', 'artifact', one.text));
  node.append(tag('div', 'stepnote', `why: ${one.why}`));
  if (one.rule) node.append(tag('div', 'detail', `checked as: ${Invariant.clauseOf(one)}`));
  void set;
  return node;
}

function paintInvariants() {
  const set = currentSet();
  el('setLine').textContent = `${set.name} — ${set.subject} · revision ${set.rev}`;

  el('hardList').replaceChildren(...Invariant.hard(set).map((one) => invariantNode(one, set)));
  el('softList').replaceChildren(...Invariant.soft(set).map((one) => invariantNode(one, set)));

  const history = Store.active().history;
  el('history').replaceChildren(...history.map((entry) => {
    const row = tag('div', 'cell');
    row.append(tag('span', 'stepid', `r${entry.rev}`));
    row.append(tag('span', 'kind', entry.action));
    row.append(tag('span', 'marker', entry.by));
    row.append(tag('span', 'detail', [
      entry.id || '',
      entry.why,
      entry.requested ? `— the model asked: ${entry.requested}` : '',
    ].filter(Boolean).join(' · ')));
    return row;
  }));

  const rate = Store.grantRate(set.id);
  el('grantLine').textContent = rate.asked
    ? `${rate.granted} of ${rate.asked} amendment requests granted. A set with a high rate is telling on itself.`
    : 'No amendment has been asked for yet.';

  paintPending(set);
}

/* The only door into the store, and it is drawn here rather than triggered
 * anywhere near a reply. A grant is a click. */
function paintPending(set) {
  const asked = app.turns.filter((turn) => turn.move === 'request_amendment');
  const last = asked[asked.length - 1];
  const settled = Store.amendments(set.id).some((one) => one.requested && last && one.requested === last.amend.case);
  el('pending').hidden = !last || settled;
  if (!last || settled) return;

  const body = el('pendingBody');
  const target = Invariant.byId(set, last.amend.id);
  const node = tag('div', 'artifact', `${last.amend.id} — ${target ? target.text : ''}`);
  const argument = tag('div', 'stepnote', last.amend.case);
  const row = tag('div', 'buttonrow');

  const grant = tag('button', '', `retire ${last.amend.id}`);
  grant.addEventListener('click', () => {
    const result = Store.amend(set.id, {
      action: 'retire',
      id: last.amend.id,
      why: 'granted after the model asked',
      requested: last.amend.case,
    });
    app.note = result.ok ? `${last.amend.id} retired — by you, at revision ${result.set.rev}` : result.refusal;
    render();
  });

  const deny = tag('button', '', 'leave it standing');
  deny.addEventListener('click', () => {
    Store.appendTurn({ move: 'amendment_denied', request: '', id: last.amend.id, set: set.id, rev: set.rev });
    app.turns = Store.run();
    app.note = `${last.amend.id} stands`;
    render();
  });

  row.append(grant, deny);
  body.replaceChildren(node, argument, row);
}

/* --------------------------------------------------------------- pressure */

const ladder = { running: false, abort: null, results: [], status: '' };

function cellOf(text, className) {
  const node = document.createElement('td');
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function rowOf(cells) {
  const row = document.createElement('tr');
  row.append(...cells);
  return row;
}

function paintProof() {
  const head = rowOf(['invariant', 'what it forbids', 'declarations tried', 'refused', 'accepted']
    .map((text) => {
      const th = document.createElement('th');
      th.textContent = text;
      return th;
    }));
  const rows = Pressure.proof().map((one) => rowOf([
    cellOf(`${one.subject.id} · ${one.subject.set}`, 'stepid'),
    cellOf(one.subject.what),
    cellOf(String(one.rows.length), 'num'),
    cellOf(String(one.refused), 'num good'),
    cellOf(String(one.accepted), 'num'),
  ]));
  el('proofTable').replaceChildren(head, ...rows);
}

function paintCurve() {
  const head = rowOf(['rung', 'what it does', 'prose · inferred', 'prose · extracted',
    'declared · attempted', 'declared · shipped']
    .map((text) => {
      const th = document.createElement('th');
      th.textContent = text;
      return th;
    }));

  const rows = Pressure.curve(ladder.results).map((row) => rowOf([
    cellOf(row.rung.label, 'stepid'),
    cellOf(row.rung.note),
    cellOf(row.n ? `${row.inferred} of ${row.n}` : '—', row.inferred ? 'num bad' : 'num'),
    cellOf(row.n ? `${row.extracted} of ${row.n - row.unextracted}` : '—', row.extracted ? 'num bad' : 'num'),
    cellOf(row.n ? `${row.attempted} of ${row.n}` : '—', 'num'),
    cellOf(row.n ? `${row.shipped} of ${row.n}` : '—', row.shipped ? 'num bad' : 'num good'),
  ]));
  el('curveTable').replaceChildren(head, ...rows);
}

function paintLadder() {
  el('runLadder').hidden = ladder.running;
  el('stopLadder').hidden = !ladder.running;
  el('ladderStatus').textContent = ladder.status;
  paintCurve();

  el('ladderOut').replaceChildren(...ladder.results.map((one) => {
    const node = tag('div', 'turn');
    const head = tag('div', 'turnhead');
    head.append(tag('span', 'stagechip', one.rung.label));
    head.append(tag('span', 'stepid', one.subject.id));
    head.append(tag('span', 'kind', one.promptOnly.inferred ? 'prose: violated' : 'prose: held'));
    head.append(tag('span', 'kind', `declared: ${one.declared.move}`));
    node.append(head);
    node.append(tag('div', 'question', one.request));
    node.append(tag('div', 'stepnote', `prose answer — ${one.promptOnly.text.slice(0, 400)}`));
    if (one.promptOnly.findings.length) {
      node.append(tag('div', 'detail', `the net inferred ${one.promptOnly.findings
        .map((f) => `${f.facet}: ${f.implied}`).join(', ')}`));
    }
    node.append(tag('div', 'detail', one.declared.shipped
      ? 'the declared arm shipped a violation — which should be impossible; read the code, not this line'
      : `the declared arm did not ship one${one.declared.attempted ? ', though it tried' : ''}`));
    return node;
  }));
}

async function runLadder() {
  if (ladder.running) return;
  if (!Api.getKey()) { ladder.status = Api.ready(); paintLadder(); return; }
  ladder.running = true;
  ladder.results = [];
  ladder.abort = new AbortController();
  const total = Pressure.cells().length;

  try {
    await Pressure.run({
      signal: ladder.abort.signal,
      send: ({ messages, signal }) => Api.send({
        model: el('model').value,
        messages,
        temperature: Number(el('temperature').value) || 0,
        stream: false,
        signal,
      }),
      onCell: (result) => {
        ladder.results.push(result);
        ladder.status = `${ladder.results.length} of ${total} cells · $${ladder.results
          .reduce((sum, one) => sum + (one.cost || 0), 0).toFixed(4)} so far`;
        paintLadder();
      },
    });
    ladder.status = `${ladder.results.length} cells, ${Pressure.requests} requests, $${ladder.results
      .reduce((sum, one) => sum + (one.cost || 0), 0).toFixed(4)}`;
  } catch (error) {
    ladder.status = error.name === 'AbortError' ? 'stopped' : error.message;
  } finally {
    ladder.running = false;
    ladder.abort = null;
    paintLadder();
  }
}

/* ------------------------------------------------------------------ render */

function render() {
  const set = currentSet();

  el('send').hidden = app.busy;
  el('stop').hidden = !app.busy;
  el('note').textContent = app.note || (app.busy ? 'asking…' : '');
  el('keyNote').textContent = Api.ready();

  el('feed').replaceChildren(...app.turns.filter((turn) => turn.request !== undefined && turn.move !== 'amendment_denied')
    .map(turnNode));
  paintStream();

  const anatomy = Protocol.anatomy(set);
  el('requestText').textContent = Protocol.block(set);
  el('requestRules').textContent = Protocol.contract();
  el('requestMeta').textContent = `${anatomy.invariants} tokens of rules, on top of ${anatomy.contract} of contract`;

  paintInvariants();
  el('invJson').value = Store.exportInvariants();
  paintLadder();
}

/* -------------------------------------------------------------------- boot */

function boot() {
  const models = Api.models;
  el('model').replaceChildren(...models.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    return option;
  }));
  el('model').value = models[0];

  el('setPicker').replaceChildren(...Object.values(Invariant.SETS).map((set) => {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = set.name;
    return option;
  }));
  el('setPicker').value = Store.activeId();
  el('setPicker').addEventListener('change', () => {
    Store.selectSet(el('setPicker').value);
    render();
  });

  el('key').value = Api.getKey();
  el('key').addEventListener('change', () => { Api.setKey(el('key').value); render(); });

  el('send').addEventListener('click', ask);
  el('stop').addEventListener('click', () => { if (app.abort) app.abort.abort(); });

  el('exportInv').addEventListener('click', () => { el('invJson').value = Store.exportInvariants(); });
  el('importInv').addEventListener('click', () => {
    const result = Store.importInvariants(el('invJson').value);
    app.note = result.ok ? `loaded — ${result.sets.join(', ') || 'nothing amended'}` : result.refusal;
    if (result.ok) el('setPicker').value = Store.activeId();
    render();
  });
  el('resetInv').addEventListener('click', () => {
    Store.wipe('invariants');
    el('setPicker').value = Store.activeId();
    app.note = 'the invariants are back to what shipped';
    render();
  });

  el('runLadder').addEventListener('click', runLadder);
  el('stopLadder').addEventListener('click', () => { if (ladder.abort) ladder.abort.abort(); });
  paintProof();

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

  app.turns = Store.run();
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { app, boot, ask, render, ladder, runLadder };
