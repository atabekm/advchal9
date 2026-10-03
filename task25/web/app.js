// The page: sessions on the left, the conversation in the middle, the task memory on the right.
// Everything comes from the JSON API in rag/server.py; nothing is kept in the browser except
// which session was open last.

const $ = (id) => document.getElementById(id);
const LAST_KEY = 'task25.session';

const state = { info: null, sessions: [], current: null, busy: false, lastTurn: 0 };

// ------------------------------------------------------------------ helpers

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(tag, attrs = {}, html = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  if (html) node.innerHTML = html;
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

function remember(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* private mode: fine */ }
}

function recalled() {
  try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; }
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function showError(text) {
  const box = $('error');
  box.textContent = text || '';
  box.hidden = !text;
}

// The answer text: paragraphs, "- " / "1. " lists, and [n] markers as links to the sources.
function renderText(text, refs) {
  const cite = (s) => s.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, group) =>
    group.split(',').map((n) => n.trim()).map((n) =>
      refs.has(Number(n)) ? `<a class="cite" href="#" data-ref="${n}">[${n}]</a>` : `[${n}]`).join(''));
  const blocks = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      const ordered = /^\d/.test(line);
      if (!list || list.ordered !== ordered) { list = { ordered, items: [] }; blocks.push(list); }
      list.items.push(item[1]);
      continue;
    }
    list = null;
    if (line) blocks.push(line);
  }
  return blocks.map((b) => typeof b === 'string'
    ? `<p>${cite(esc(b))}</p>`
    : `<${b.ordered ? 'ol' : 'ul'}>${b.items.map((i) => `<li>${cite(esc(i))}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`).join('');
}

function changeText(c) {
  if (c.op === 'set_goal') return `goal → ${c.text}`;
  if (c.op === 'set_scope') return `scope → ${c.text}`;
  return `${c.op === 'add' ? '+' : '−'} ${c.field}: ${c.text}`;
}

// ------------------------------------------------------------------ sessions

function renderSessions() {
  const list = $('sessionList');
  list.innerHTML = '';
  for (const s of state.sessions) {
    const del = el('button', { class: 'del', title: 'delete', 'aria-label': 'delete' }, '✕');
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!del.classList.contains('armed')) {  // two clicks instead of a confirm() dialog
        del.classList.add('armed');
        del.textContent = 'delete?';
        setTimeout(() => { del.classList.remove('armed'); del.textContent = '✕'; }, 2500);
        return;
      }
      await api('DELETE', `/api/sessions/${s.id}`).catch((e) => showError(e.message));
      if (state.current === s.id) state.current = null;
      await loadSessions();
      if (!state.current) await openSession(state.sessions[0]?.id || (await newSession()));
    });
    const li = el('li', { 'aria-current': String(s.id === state.current) },
      `<div class="name"><b>${esc(s.title)}</b><span class="dim">${s.turns} turn${s.turns === 1 ? '' : 's'} · ${ago(s.updated)}</span></div>`);
    li.append(del);
    li.addEventListener('click', () => { openSession(s.id); $('sessions').classList.remove('open'); });
    list.append(li);
  }
}

async function loadSessions() {
  state.sessions = await api('GET', '/api/sessions');
  renderSessions();
}

async function newSession() {
  const s = await api('POST', '/api/sessions');
  await loadSessions();
  return s.id;
}

async function openSession(id) {
  if (!id) return;
  showError('');
  let data;
  try {
    data = await api('GET', `/api/sessions/${id}`);
  } catch (e) {
    return openSession(await newSession());
  }
  state.current = id;
  state.lastTurn = data.session.turns;
  remember(id);
  renderSessions();
  const log = $('log');
  log.innerHTML = '';
  if (!data.messages.length) log.append(emptyState());
  for (const m of data.messages) log.append(m.role === 'user' ? userMessage(m.text) : replyMessage(m));
  renderMemory(data.memory, data.session.turns);
  log.scrollTop = log.scrollHeight;
  $('input').focus();
}

// ------------------------------------------------------------------ messages

function emptyState() {
  const docs = (state.info?.documents || []).map((d) => `<li>${esc(d.title)} <span class="dim">(${esc(d.source)})</span></li>`).join('');
  const box = el('div', { class: 'empty' }, `
    <h3>Start with your goal and a question</h3>
    <p>The assistant answers only from these documents, with sources and quotes checked against them:</p>
    <ul>${docs}</ul>
    <p>Tell it what you are trying to do and how you want answers; the task memory on the right keeps that for the whole conversation.</p>
    <div class="try"></div>`);
  const tries = [
    'I want to lose about 8 kg using Gutless. Keep answers short. What are the main rules?',
    'I am planning a speech dataset for a low-resource language. How was TatarTTS built?',
  ];
  for (const t of tries) {
    box.querySelector('.try').append(el('button', { type: 'button', onclick: () => { $('input').value = t; $('input').focus(); } }, esc(t)));
  }
  return box;
}

function userMessage(text) {
  const wrap = el('div', { class: 'msg user' });
  wrap.append(el('div', { class: 'bubble' }, esc(text)));
  return wrap;
}

function replyMessage(m) {
  const d = m.data || {};
  const wrap = el('div', { class: 'msg assistant' });
  const status = d.status || 'answer';
  const label = { answer: 'answer', unknown: "I don't know", meta: 'no retrieval' }[status] || status;
  const scope = d.retrieval?.scope?.length ? ` · scope ${d.retrieval.scope.join(', ')}` : '';
  wrap.append(el('div', { class: 'meta-line' },
    `<span>turn ${m.turn}</span><span class="badge ${esc(status)}">${esc(label)}</span>` +
    `<span>${d.seconds != null ? `${d.seconds.toFixed(1)} s` : ''}${esc(scope)}</span>`));
  if (d.kind === 'question' && d.standalone) {
    wrap.append(el('div', { class: 'standalone' }, `searched as <b>${esc(d.standalone)}</b>`));
  }

  const bubble = el('div', { class: 'bubble' });
  const sources = d.sources || [];
  const refs = new Set(sources.map((s) => s.ref));
  bubble.innerHTML = renderText(m.text, refs);

  if (sources.length) {
    const box = el('div', { class: 'sources' });
    for (const s of sources) {
      box.append(el('div', { class: 'row', 'data-ref': s.ref },
        `<span class="n">[${s.ref}]</span><span class="where">${esc(s.source)} · ${esc(s.section || '—')} · ${esc(s.pages)} <code>${esc(s.chunk_id)}</code></span>`));
    }
    bubble.append(box);
  } else if (status === 'answer') {
    bubble.append(el('div', { class: 'sources dim' }, 'no sources'));
  }

  const quotes = d.quotes || [];
  const dropped = d.dropped_quotes || [];
  if (quotes.length || dropped.length) {
    const det = el('details', {}, `<summary>Quotes (${quotes.length} checked${dropped.length ? `, ${dropped.length} dropped` : ''})</summary>`);
    for (const q of quotes) det.append(quoteRow(q, true));
    for (const q of dropped) det.append(quoteRow(q, false));
    bubble.append(det);
  }

  const r = d.retrieval;
  if (r) {
    const best = r.best == null ? '—' : r.best.toFixed(3);
    const det = el('details', {}, `<summary>Retrieval (${esc(r.mode)}, best ${best}, threshold ${r.threshold}, ${r.kept.length} kept)</summary>`);
    det.append(el('div', {}, `<span class="dim">queries:</span> ${r.queries.map(esc).join(' · ')}`));
    const ul = el('ul', { class: 'chunks' });
    for (const h of r.kept) {
      ul.append(el('li', {}, `<span class="s">[${h.ref}] ${h.rerank == null ? '' : h.rerank.toFixed(3)}</span> ${esc(h.source)} · ${esc(h.section || '—')} · ${esc(h.pages)}`));
    }
    det.append(ul);
    bubble.append(det);
  }

  const changes = d.memory_changes || [];
  const errors = d.memory_errors || [];
  if (changes.length || errors.length) {
    const box = el('div', { class: 'changes' });
    for (const c of changes) box.append(el('span', { class: `chg ${c.op === 'remove' ? 'remove' : ''}`, title: 'memory change' }, esc(changeText(c))));
    for (const e of errors) box.append(el('span', { class: 'chg err', title: 'rejected memory edit' }, esc(e)));
    bubble.append(box);
  }

  bubble.addEventListener('click', (ev) => {
    const a = ev.target.closest('.cite');
    if (!a) return;
    ev.preventDefault();
    const row = bubble.querySelector(`.sources .row[data-ref="${a.dataset.ref}"]`);
    if (row) {
      row.classList.add('flash');
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(() => row.classList.remove('flash'), 1200);
    }
  });
  wrap.append(bubble);
  return wrap;
}

function quoteRow(q, ok) {
  return el('div', { class: 'quote' },
    `<span class="score ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${q.match == null ? '' : Number(q.match).toFixed(0)}</span>` +
    `<span><span class="dim">[${q.ref}]</span> <q>${esc(q.quote)}</q></span>`);
}

function pendingMessage() {
  const wrap = el('div', { class: 'msg assistant pending' });
  const bubble = el('div', { class: 'bubble' });
  const steps = el('div', { class: 'steps' });
  const names = state.info?.memory ? ['condense', 'retrieve', 'answer', 'memory'] : ['condense', 'retrieve', 'answer'];
  for (const n of names) steps.append(el('span', {}, n));
  const clock = el('span', { class: 'dim' }, '0 s');
  steps.append(clock);
  bubble.append(steps);
  wrap.append(bubble);
  // The API answers once per turn; the steps only show the order and roughly where it is.
  const started = Date.now();
  const marks = [0, 2, 5, 9];
  const timer = setInterval(() => {
    const s = (Date.now() - started) / 1000;
    clock.textContent = `${s.toFixed(0)} s`;
    steps.querySelectorAll('span').forEach((span, i) => {
      if (i < names.length) span.classList.toggle('on', s >= marks[i] && (i === names.length - 1 || s < marks[i + 1]));
    });
  }, 250);
  wrap.stop = () => clearInterval(timer);
  return wrap;
}

// ------------------------------------------------------------------ memory panel

function renderMemory(mem, turn) {
  const body = $('memoryBody');
  body.innerHTML = '';
  if (!mem || !mem.on) {
    body.append(el('p', { class: 'off' }, 'The memory is off for this server (<code>--no-memory</code>): only the last messages go into the prompts.'));
    return;
  }
  const fresh = (t) => (t === turn && turn > 0 ? ' new' : '');
  body.append(el('h3', {}, '<span>Goal</span>'));
  body.append(el('div', { class: `goal${fresh(mem.goal_turn)}` }, mem.goal ? esc(mem.goal) : '<span class="none">not stated yet</span>'));

  const sections = [['clarified', 'Clarified by you'], ['constraints', 'Constraints'], ['terms', 'Terms']];
  for (const [key, title] of sections) {
    const items = mem[key] || [];
    body.append(el('h3', {}, `<span>${title}</span><span>${items.length || ''}</span>`));
    if (!items.length) { body.append(el('div', { class: 'none' }, 'none')); continue; }
    const ul = el('ul');
    for (const i of items) {
      ul.append(el('li', { class: fresh(i.turn).trim() }, `<span class="id">${esc(i.id)}</span><span>${esc(i.text)}</span><span class="t">t${i.turn}</span>`));
    }
    body.append(ul);
  }

  body.append(el('h3', {}, '<span>Scope</span>'));
  const scope = el('div', { class: 'scope' });
  for (const s of (mem.scope?.length ? mem.scope : ['all documents'])) scope.append(el('span', {}, esc(s)));
  body.append(scope);

  const log = mem.log || [];
  if (log.length) {
    const det = el('details', {}, `<summary>Change log (${log.length})</summary>`);
    const rows = el('div', { class: 'logrows' });
    for (const c of log.slice().reverse()) rows.append(el('div', {}, `<span class="tn">t${c.turn}</span>${esc(changeText(c))}`));
    det.append(rows);
    body.append(det);
  }
}

// ------------------------------------------------------------------ sending

async function send(text) {
  if (state.busy || !text.trim() || !state.current) return;
  state.busy = true;
  $('send').disabled = true;
  showError('');
  const log = $('log');
  log.querySelector('.empty')?.remove();
  log.append(userMessage(text));
  const pending = pendingMessage();
  log.append(pending);
  log.scrollTop = log.scrollHeight;
  $('input').value = '';
  const session = state.current;
  try {
    const res = await api('POST', `/api/sessions/${session}/messages`, { text });
    pending.stop();
    if (state.current !== session) return;  // switched away meanwhile; it is saved
    pending.replaceWith(replyMessage(res.reply));
    renderMemory(res.memory, res.turn);
    log.scrollTop = log.scrollHeight;
  } catch (e) {
    pending.stop();
    pending.remove();
    log.lastElementChild?.remove();  // the user message: nothing was saved
    $('input').value = text;
    showError(e.message);
  } finally {
    state.busy = false;
    $('send').disabled = false;
    loadSessions().catch(() => {});
    $('input').focus();
  }
}

// ------------------------------------------------------------------ start

async function start() {
  $('composer').addEventListener('submit', (ev) => { ev.preventDefault(); send($('input').value); });
  $('input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send($('input').value); }
  });
  $('newSession').addEventListener('click', async () => { await openSession(await newSession()); $('sessions').classList.remove('open'); });
  $('toggleSessions').addEventListener('click', () => { $('sessions').classList.toggle('open'); $('memory').classList.remove('open'); });
  $('toggleMemory').addEventListener('click', () => { $('memory').classList.toggle('open'); $('sessions').classList.remove('open'); });

  try {
    state.info = await api('GET', '/api/info');
    $('info').textContent = `${state.info.model} · ${state.info.mode} · memory ${state.info.memory ? 'on' : 'off'} · last ${state.info.window} messages`;
    await loadSessions();
    const last = recalled();
    const id = state.sessions.find((s) => s.id === last)?.id || state.sessions[0]?.id || (await newSession());
    await openSession(id);
  } catch (e) {
    showError(`Cannot reach the server: ${e.message}`);
  }
}

start();
