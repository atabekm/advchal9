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

function pills(items) {
  const wrap = tag('div', 'pills');
  for (const one of items) {
    const pill = tag('span', `pill ${one.tone || ''}`.trim());
    pill.append(tag('b', '', one.head));
    if (one.tail) pill.append(tag('span', 'why', one.tail));
    wrap.append(pill);
  }
  return wrap;
}

/* The verdict, as a strip rather than a card. Task 12 drew its checker results
 * this way and it was right: a violation is one fact, and one fact does not
 * need a heading, a panel and a border to be read. */
function verdictStrip(turn) {
  const marks = [];
  for (const violation of turn.violations) {
    marks.push({
      tone: 'fail',
      head: `${violation.id} · ${violation.code}`,
      tail: `${violation.facet}: ${violation.offending.join(', ')}`,
    });
  }
  for (const found of turn.contradictions) {
    marks.push({
      tone: 'warn',
      head: 'prose · contradiction',
      tail: `implies ${found.facet}: ${found.implied}, undeclared — heuristic`,
    });
  }
  for (const id of turn.missed) {
    marks.push({ tone: 'warn', head: `${id} · unnamed`, tail: 'it bore, and went unlisted' });
  }
  return marks.length ? pills(marks) : null;
}

function declaredLine(turn) {
  const touched = Invariant.FACET_NAMES.filter((facet) => turn.declare && turn.declare[facet].length);
  if (!touched.length) return tag('div', 'declared dim', 'declared nothing at all — which is itself a claim');
  const wrap = tag('div', 'declared');
  wrap.append(tag('span', 'dim', 'declared'));
  for (const facet of touched) {
    const item = tag('span', 'facet');
    item.append(tag('b', '', facet));
    item.append(tag('span', '', turn.declare[facet].join(', ')));
    wrap.append(item);
  }
  return wrap;
}

const GRADE_TEXT = {
  cites: 'names the rule, in the prose',
  names: 'names what collided',
  classifies: 'one move, not a hedge',
  offers: 'a way through, or none plainly',
};

function gradeStrip(turn) {
  return pills(Object.keys(GRADE_TEXT).map((key) => ({
    tone: turn.grade[key] ? 'pass' : 'fail',
    head: turn.grade[key] ? '✓' : '✗',
    tail: GRADE_TEXT[key],
  })));
}

function userBubble(text) {
  const node = tag('div', 'turn user');
  node.append(tag('div', 'bubble', text));
  return node;
}

/* "accepted" beside a refusal reads as a contradiction, and it is not one —
 * the envelope was accepted; the answer inside it was a no. Saying which is
 * the difference between the model declining and the runtime refusing, and
 * that difference is the whole task. */
function bylineVerb(turn) {
  if (!turn.ok) return `refused by the ${turn.stage}`;
  if (turn.move === 'refuse') return 'the model refused';
  if (turn.move === 'request_amendment') return 'asked for an amendment';
  return 'accepted';
}

function modelTurn(turn) {
  const node = tag('div', turn.ok ? 'turn' : 'turn refused');

  const byline = tag('div', 'byline');
  byline.append(tag('span', 'move', turn.move || 'unparsed'));
  byline.append(tag('span', '', bylineVerb(turn)));
  if (turn.attempt > 0) byline.append(tag('span', '', `attempt ${turn.attempt + 1} of ${ATTEMPTS}`));
  byline.append(tag('span', '', `${turn.set} · rev ${turn.rev}`));
  if (turn.usage) {
    byline.append(tag('span', '', `${turn.usage.promptTokens} in · ${turn.usage.cacheHitTokens} cached`));
  }
  node.append(byline);

  const bubble = tag('div', 'bubble');
  if (turn.say) bubble.innerHTML = renderMarkdown(turn.say);
  else bubble.append(tag('pre', 'block', turn.raw || ''));
  node.append(bubble);

  if (turn.move === 'propose') node.append(declaredLine(turn));

  const strip = verdictStrip(turn);
  if (strip) node.append(strip);

  if (turn.move === 'refuse') node.append(gradeStrip(turn));
  if (turn.alternative) node.append(tag('div', 'aside-note', `instead: ${turn.alternative}`));
  if (turn.move === 'request_amendment' && turn.amend) {
    node.append(tag('div', 'aside-note', `wants ${turn.amend.id} amended — the decision is on the right`));
  }

  return node;
}

/* The log, as a conversation. A retry is a second model turn under the same
 * ask, so the ask is drawn once and the attempts stack under it — which is
 * also what actually happened. */
function paintLog() {
  const nodes = [];
  let lastRequest = null;
  for (const turn of app.turns) {
    if (turn.request === undefined || turn.move === 'amendment_denied') continue;
    if (turn.request !== lastRequest) {
      nodes.push(userBubble(turn.request));
      lastRequest = turn.request;
    }
    nodes.push(modelTurn(turn));
  }
  el('log').replaceChildren(...nodes);
}

/* ------------------------------------------------------- the aside marks */

/* What each rule did on the last turn. This is the reason the rules are beside
 * the conversation rather than behind a tab: a refusal that cites INV-2 is not
 * an explanation if INV-2 is on another screen.
 *
 * `bore` and `broke` are different facts and both are shown. A rule that bore
 * and held is the ordinary case and the one nobody ever renders — but it is
 * the evidence that the rule was live, rather than merely present. */
function markOf(one, turn) {
  if (one.enforcement === 'soft') return { tone: '', label: 'unverified' };
  if (!turn) return { tone: '', label: '·' };
  if (turn.violations.some((v) => v.id === one.id)) return { tone: 'fail', label: '✗ broke' };
  if (turn.bearing.includes(one.id)) {
    return turn.considered.includes(one.id)
      ? { tone: 'pass', label: '✓ bore' }
      : { tone: 'warn', label: '✓ bore · unnamed' };
  }
  if (turn.under && turn.under.includes(one.id)) return { tone: 'pass', label: '✓ refused under' };
  if (turn.amend && turn.amend.id === one.id) return { tone: 'warn', label: 'amendment asked' };
  return { tone: '', label: '·' };
}

function lastTurn() {
  const real = app.turns.filter((turn) => turn.request !== undefined && turn.move !== 'amendment_denied');
  return real.length ? real[real.length - 1] : null;
}

function paintMarks() {
  const set = currentSet();
  const turn = lastTurn();
  el('setLine').textContent = `revision ${set.rev} · ${set.subject}`;

  el('marks').replaceChildren(...Invariant.invariantsOf(set).map((one) => {
    const mark = markOf(one, turn && turn.set === set.id ? turn : null);
    const node = tag('div', `inv ${mark.tone}`.trim());
    const head = tag('div', 'invhead');
    head.append(tag('span', 'stepid', one.id));
    head.append(tag('span', 'kind', one.kind));
    head.append(tag('span', 'mark', mark.label));
    node.append(head);
    node.append(tag('div', 'invtext', one.text));
    if (one.rule) node.append(tag('div', 'invrule', Invariant.clauseOf(one)));
    return node;
  }));
}

/* ---------------------------------------------------------- the invariants */

function invariantNode(one, set) {
  const node = tag('div', 'step');
  const head = tag('div', 'stepbody');
  head.append(tag('span', 'stepid', one.id));
  head.append(tag('span', 'kind', one.kind));
  head.append(tag('span', 'stepstatus', one.enforcement === 'soft' ? 'unverified' : 'checked'));
  node.append(head);
  node.append(tag('div', 'prose', one.text));
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
    const row = tag('div', 'row');
    row.append(tag('span', 'stepid', `r${entry.rev}`));
    row.append(tag('span', 'code', entry.action));
    row.append(tag('span', 'who', entry.by));
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
}

/* The only door into the store, and it is drawn beside the rule it concerns
 * rather than triggered anywhere near a reply. A grant is a click. */
function paintPending() {
  const set = currentSet();
  const asked = app.turns.filter((turn) => turn.move === 'request_amendment');
  const last = asked[asked.length - 1];
  const settled = Store.amendments(set.id).some((one) => one.requested && last && one.requested === last.amend.case);
  el('pending').hidden = !last || settled;
  if (!last || settled) return;

  const body = el('pendingBody');
  const target = Invariant.byId(set, last.amend.id);
  const node = tag('div', 'prose', `${last.amend.id} — ${target ? target.text : ''}`);
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
  el('note').hidden = !el('note').textContent;
  el('keyNote').textContent = Api.ready();

  paintLog();
  paintStream();
  paintMarks();
  paintPending();

  const anatomy = Protocol.anatomy(set);
  el('requestText').textContent = Protocol.block(set);
  el('requestRules').textContent = Protocol.contract();
  el('requestMeta').textContent = `${anatomy.invariants} of rules + ${anatomy.contract} of contract`;

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

  el('composer').addEventListener('submit', (event) => { event.preventDefault(); ask(); });
  /* Enter sends, shift-enter breaks the line. A textarea in a form does
   * neither on its own, and the alternative is reaching for the mouse after
   * every question. */
  el('request').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      ask();
    }
  });
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
