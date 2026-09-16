/* The interface.
 *
 * It owns the DOM, the key field, and the one mutable thing in the app — which
 * profile is current. It owns no opinion about what a profile is: the schema,
 * the block, the ban catalogue and the checks all live elsewhere, and this
 * file would still be correct if every field in the schema changed tomorrow.
 *
 * The editor is drawn from `Profile.FIELDS`, not written out by hand, for that
 * reason. A panel that hard-codes the nine fields is a second schema, and
 * within a week it is the one that is out of date.
 */

const SELECTED = 'task12.selected';
const CUSTOM = 'task12.custom';

const el = (id) => document.getElementById(id);

const state = {
  /* The profile is the thing that persists. The conversation is not — it is
   * the whole of this task's relationship to task 11's memory model, and it is
   * one key rather than a subsystem. Reload the page: the agent still knows
   * how you want to be answered and has forgotten everything you said. */
  who: 'sam',
  custom: null,
  history: [],
  busy: false,
};

const COLOURS = { dina: 'var(--dina)', sam: 'var(--sam)', priya: 'var(--priya)', none: 'var(--none)', custom: 'var(--accent)' };

function currentProfile() {
  if (state.who === 'none') return { ...Profile.EMPTY };
  if (state.who === 'custom') return { ...Profile.EMPTY, ...(state.custom || {}) };
  return { ...Profile.EMPTY, ...Profile.PEOPLE[state.who] };
}

function currentName() {
  if (state.who === 'none') return 'no profile';
  const p = currentProfile();
  return p.name || 'someone';
}

/* Editing any field turns the current selection into a custom profile rather
 * than overwriting Дина. The three people are fixtures the grid compares
 * against; a panel that let you edit them in place would make every run of the
 * grid a run against different subjects with the same names. */
function edit(field, value) {
  const base = currentProfile();
  state.custom = { ...base, [field]: value };
  state.who = 'custom';
  save();
  render();
}

function save() {
  try {
    localStorage.setItem(SELECTED, state.who);
    if (state.custom) localStorage.setItem(CUSTOM, JSON.stringify(state.custom));
  } catch (error) { /* storage disabled; the page still works for this session */ }
}

function load() {
  try {
    const who = localStorage.getItem(SELECTED);
    if (who) state.who = who;
    const custom = localStorage.getItem(CUSTOM);
    if (custom) state.custom = JSON.parse(custom);
  } catch (error) { /* same */ }
  if (state.who === 'custom' && !state.custom) state.who = 'sam';
}

/* ---------------------------------------------------------------- editor */

function renderPeople() {
  const options = [
    ...Object.keys(Profile.PEOPLE).map((id) => ({ id, label: Profile.PEOPLE[id].name })),
    { id: 'none', label: 'no profile' },
  ];
  if (state.custom) options.push({ id: 'custom', label: state.custom.name ? `${state.custom.name} (edited)` : 'edited' });

  el('people').replaceChildren(...options.map(({ id, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'person';
    button.textContent = label;
    button.style.color = COLOURS[id] || 'var(--accent)';
    button.setAttribute('aria-pressed', String(state.who === id));
    button.addEventListener('click', () => { state.who = id; save(); render(); });
    return button;
  }));
}

function renderFields() {
  const profile = currentProfile();
  const rows = [];

  for (const field of Profile.FIELD_ORDER) {
    const spec = Profile.FIELDS[field];
    if (spec.type === 'list') continue; // the bans have their own section

    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('label');
    label.textContent = spec.label;
    label.htmlFor = `f-${field}`;
    row.append(label);

    let input;
    if (spec.type === 'choice') {
      input = document.createElement('select');
      // The unset option is first and is spelled as an absence, not as a
      // default. It is the difference the baseline row of the grid rests on.
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— not stated —';
      input.append(none);
      for (const value of spec.values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        input.append(option);
      }
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '— not stated —';
    }
    input.id = `f-${field}`;
    input.value = profile[field] || '';
    input.addEventListener('change', () => edit(field, input.value));
    row.append(input);

    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = spec.checkable ? `${spec.kind} · checked` : `${spec.kind} · not checkable`;
    row.append(kind);

    rows.push(row);
  }

  el('fields').replaceChildren(...rows);
}

function renderBans() {
  const profile = currentProfile();
  const forbid = profile.forbid || [];
  const rows = [];

  for (const [id, ban] of Object.entries(Profile.BANS)) {
    const row = document.createElement('label');
    row.className = 'ban';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = forbid.includes(id);
    box.addEventListener('change', () => {
      const next = box.checked ? [...forbid, id] : forbid.filter((x) => x !== id);
      edit('forbid', next);
    });
    const text = document.createElement('span');
    text.textContent = id;
    const say = document.createElement('span');
    say.className = 'say';
    say.textContent = `— ${ban.say}`;
    row.append(box, text, say);
    rows.push(row);
  }

  for (const entry of forbid.filter((x) => !Profile.BANS[x])) {
    const row = document.createElement('div');
    row.className = 'ban custom';
    const text = document.createElement('span');
    text.innerHTML = '';
    text.textContent = entry;
    const note = document.createElement('span');
    note.className = 'say';
    note.textContent = '— unchecked';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'remove';
    remove.addEventListener('click', () => edit('forbid', forbid.filter((x) => x !== entry)));
    const left = document.createElement('span');
    left.append(text, ' ', note);
    row.append(left, remove);
    rows.push(row);
  }

  el('banList').replaceChildren(...rows);
}

function renderBlock() {
  const block = Profile.compile(currentProfile());
  const pre = el('blockText');
  if (block.empty) {
    pre.textContent = 'Nothing. No profile block is sent — the request is the persona, '
      + 'the conversation, and the question.';
    pre.classList.add('empty');
    el('blockTokens').textContent = '0 tokens';
  } else {
    pre.textContent = block.text;
    pre.classList.remove('empty');
    el('blockTokens').textContent = `${block.tokens} tokens, on every request`;
  }
}

function renderNote() {
  const stated = Profile.statedFields(currentProfile());
  const checkable = stated.filter((f) => Profile.FIELDS[f].checkable);
  el('editorNote').textContent = stated.length === 0
    ? 'Nothing is stated, so nothing can be checked.'
    : `${stated.length} of ${Profile.FIELD_ORDER.length} fields stated; `
      + `${checkable.length} of those can be checked against the reply. `
      + 'The rest are asked for and taken on trust.';
}

function render() {
  renderPeople();
  renderFields();
  renderBans();
  renderBlock();
  renderNote();
}

/* ------------------------------------------------------------------ chat */

function bubbleFor(turn) {
  const wrap = document.createElement('div');
  wrap.className = `turn ${turn.role}${turn.error ? ' error' : ''}`;

  const byline = document.createElement('div');
  byline.className = 'byline';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = turn.role === 'user' ? (COLOURS[turn.who] || 'var(--accent)') : 'var(--dim)';
  byline.append(dot, turn.role === 'user' ? `${turn.asked} asked` : 'the assistant');
  if (turn.meta) {
    const meta = document.createElement('span');
    meta.className = 'dim';
    meta.textContent = turn.meta;
    byline.append(meta);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (turn.role === 'assistant') bubble.innerHTML = renderMarkdown(turn.content || '');
  else bubble.textContent = turn.content;

  wrap.append(byline, bubble);
  if (turn.role === 'assistant' && turn.done && !turn.error) wrap.append(verdictStrip(turn));
  return { wrap, bubble };
}

/* The compliance strip.
 *
 * A violated constraint is shown beside the reply with the rule it broke, and
 * the turn is not asked again. The checker stays a measuring instrument rather
 * than becoming a control loop: a score achieved on the second attempt is a
 * fact about the retry, and failures on screen are worth more than a clean
 * number that had to be negotiated.
 *
 * Fields that cannot be checked are collapsed into one grey chip. They are
 * still on screen — a panel that showed only the graded fields would quietly
 * imply the profile was fully accounted for.
 */
function verdictStrip(turn) {
  const strip = document.createElement('div');
  strip.className = 'verdicts';

  // No question metadata in free chat: nobody declared what this question
  // cannot exercise, so nothing is excused. See check.js for why that is the
  // safe direction to be wrong in.
  const results = Check.checkReply({ profile: turn.profile, reply: turn.content });
  const graded = results.filter((r) => r.verdict !== 'unchecked');
  const unchecked = results.filter((r) => r.verdict === 'unchecked');

  for (const result of graded) {
    const chip = document.createElement('span');
    chip.className = `verdict ${result.verdict}`;
    const mark = { pass: '✓', fail: '✗', na: '–' }[result.verdict] || '·';
    const label = document.createElement('b');
    label.textContent = `${mark} ${result.label}`;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = result.why;
    chip.append(label, why);
    strip.append(chip);
  }

  if (unchecked.length) {
    const chip = document.createElement('span');
    chip.className = 'verdict unchecked';
    chip.textContent = `${unchecked.length} asked for, none of it checkable: `
      + unchecked.map((r) => r.field).join(', ');
    strip.append(chip);
  }

  if (!results.length) {
    const chip = document.createElement('span');
    chip.className = 'verdict unchecked';
    chip.textContent = 'nothing was asked for, so nothing can be checked';
    strip.append(chip);
  }

  return strip;
}

function redrawLog() {
  const log = el('log');
  log.replaceChildren(...state.history.map((turn) => bubbleFor(turn).wrap));
  log.scrollTop = log.scrollHeight;
}

async function ask(question) {
  if (state.busy) return;
  const profile = currentProfile();
  const { messages, block } = Profile.assemble({
    profile,
    // The history is sent verbatim. There is no window policy here and no
    // summary chain — that was task 10, and re-litigating it would bury the
    // one thing this task is about under five that it is not.
    history: state.history.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })),
    question,
  });

  state.history.push({ role: 'user', content: question, who: state.who, asked: currentName() });
  const answer = { role: 'assistant', content: '', profile, meta: '', done: false };
  state.history.push(answer);
  redrawLog();

  const log = el('log');
  const last = log.lastElementChild;
  const bubble = last.querySelector('.bubble');

  state.busy = true;
  el('send').disabled = true;

  try {
    const result = await Api.send({
      model: el('model').value,
      messages,
      temperature: Number(el('temperature').value),
      onChunk: (chunk) => {
        answer.content += chunk;
        bubble.innerHTML = renderMarkdown(answer.content);
        log.scrollTop = log.scrollHeight;
      },
    });
    answer.content = result.text || answer.content;
    answer.meta = [
      block.empty ? 'no profile block' : `${block.tokens}-token profile block`,
      result.usage ? `${result.usage.promptTokens} in · ${result.usage.completionTokens} out` : '',
      result.cost != null ? `$${result.cost.toFixed(5)}` : '',
    ].filter(Boolean).join(' · ');
  } catch (error) {
    answer.error = true;
    answer.content = error.message || String(error);
  } finally {
    answer.done = !answer.error;
    state.busy = false;
    el('send').disabled = false;
    redrawLog();
  }
}

/* ------------------------------------------------------------------ grid */

const MARK = { pass: '✓', fail: '✗', na: '–', unchecked: '·' };

function answerDetails(cell, label) {
  const details = document.createElement('details');
  details.className = 'answer';
  const summary = document.createElement('summary');
  summary.textContent = label;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(cell.text || '');
  details.append(summary, bubble);
  return details;
}

function marksFor(cell, noise) {
  const marks = document.createElement('div');
  marks.className = 'marks';
  if (cell.error) {
    const mark = document.createElement('span');
    mark.className = 'mark fail';
    mark.textContent = cell.error.slice(0, 60);
    marks.append(mark);
    return marks;
  }
  const graded = cell.results.filter((r) => r.verdict !== 'unchecked');
  if (!graded.length) {
    const mark = document.createElement('span');
    mark.className = 'mark na';
    mark.textContent = 'nothing asked for';
    marks.append(mark);
    return marks;
  }
  for (const result of graded) {
    const unstable = Grid.isUnstable(noise, cell.questionId, result.label);
    const mark = document.createElement('span');
    mark.className = `mark ${unstable ? 'unstable' : result.verdict}`;
    mark.textContent = `${unstable ? '?' : MARK[result.verdict]} ${result.label}`;
    mark.title = unstable
      ? `the repeat run disagreed with itself here — ${result.why}`
      : result.why;
    marks.append(mark);
  }
  return marks;
}

function renderGrid(run) {
  const out = el('gridOut');
  const table = document.createElement('table');
  table.className = 'grid';

  const head = document.createElement('tr');
  head.append(document.createElement('th'));
  for (const question of run.questions) {
    const th = document.createElement('th');
    th.append(question.text);
    const note = document.createElement('div');
    note.className = 'dim';
    note.style.fontWeight = '400';
    note.textContent = question.note;
    th.append(note);
    head.append(th);
  }
  table.append(head);

  for (const row of run.rows) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'row';
    name.style.color = `var(--${row.colour})`;
    const score = run.scores[row.id];
    name.append(row.label);
    const sub = document.createElement('div');
    sub.className = 'dim';
    sub.textContent = score.graded
      ? `${score.pass}/${score.graded} kept${score.dropped ? `, ${score.dropped} unstable` : ''}`
      : 'nothing to grade';
    name.append(sub);
    tr.append(name);

    for (const question of run.questions) {
      const td = document.createElement('td');
      const cell = run.cells.find((c) => c.rowId === row.id && c.questionId === question.id);
      if (!cell) { td.append('—'); tr.append(td); continue; }
      td.append(marksFor(cell, run.noise));
      if (!cell.error) {
        const count = Check.words(Check.withoutCode(cell.text));
        td.append(answerDetails(cell, `the answer — ${count} words`));
      }
      tr.append(td);
    }
    table.append(tr);
  }

  const summary = document.createElement('div');
  summary.className = 'scoreline';
  const { noise } = run;
  summary.append(
    noteSpan(`${run.cells.length} requests`),
    noteSpan(`$${run.cost.toFixed(4)}`),
    noteSpan(noise.compared
      ? `the model disagreed with itself on ${noise.unstable.length} of ${noise.compared} repeated verdicts`
      : 'no repeat row ran, so there is no noise floor'),
  );

  const caveat = document.createElement('p');
  caveat.className = 'dim';
  caveat.textContent = 'Every ? is a verdict the repeat row could not reproduce. Those cells are '
    + 'excluded from the scores on the left: a denominator that quietly includes the coin-flips '
    + 'is a denominator that makes every profile look about the same.';

  out.replaceChildren(summary, table, caveat);
}

function noteSpan(text) {
  const span = document.createElement('span');
  span.className = 'dim';
  span.textContent = text;
  return span;
}

let gridAbort = null;

async function startGrid() {
  const button = el('runGrid');
  const stop = el('stopGrid');
  gridAbort = new AbortController();
  button.disabled = true;
  stop.hidden = false;
  el('gridOut').replaceChildren();

  try {
    const run = await Grid.runGrid({
      model: el('model').value,
      temperature: Number(el('temperature').value),
      signal: gridAbort.signal,
      onProgress: ({ done, total, row, question }) => {
        el('gridStatus').textContent = `${done}/${total} — asking ${row}: “${question}”`;
      },
    });
    el('gridStatus').textContent = `${run.cells.length} requests, `
      + `${run.cells.filter((c) => c.error).length} of them failed.`;
    renderGrid(run);
  } catch (error) {
    el('gridStatus').textContent = error.name === 'AbortError'
      ? 'Stopped. A partial grid is a partial answer, so nothing is shown.'
      : `The run stopped: ${error.message}`;
  } finally {
    button.disabled = false;
    stop.hidden = true;
    gridAbort = null;
  }
}

/* ------------------------------------------------------------------ boot */

function boot() {
  for (const model of Api.models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    el('model').append(option);
  }

  el('key').value = Api.getKey();
  el('key').addEventListener('change', () => {
    Api.setKey(el('key').value);
    el('keyNote').textContent = Api.ready();
  });
  el('keyNote').textContent = Api.ready();

  el('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const question = el('input').value.trim();
    if (!question) return;
    el('input').value = '';
    ask(question);
  });

  el('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      el('composer').requestSubmit();
    }
  });

  el('runGrid').addEventListener('click', startGrid);
  el('stopGrid').addEventListener('click', () => gridAbort && gridAbort.abort());

  el('customBan').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el('customBanText').value.trim();
    if (!text) return;
    el('customBanText').value = '';
    edit('forbid', [...(currentProfile().forbid || []), text]);
  });

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

  load();
  render();
}

boot();
