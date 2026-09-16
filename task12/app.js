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
  return { wrap, bubble };
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
  const answer = { role: 'assistant', content: '', profile, meta: '' };
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
    state.busy = false;
    el('send').disabled = false;
    redrawLog();
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
