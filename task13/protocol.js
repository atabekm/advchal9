/* The protocol: what the model is shown, and what it is allowed to say back.
 *
 * `compile(state)` is the whole request. There is no dialogue underneath it and
 * there is no second version of this function for resuming — that is the claim
 * the task is built on. If resuming needed its own prompt, the state was never
 * sufficient, and the experiment in resume.js would be measuring a special
 * case written to pass.
 *
 * The static half goes in the system message and the state goes in the user
 * message. That split is not cosmetic: the static half is identical on every
 * request of every run, which is exactly what a prompt cache is for.
 *
 * Nothing here talks to a model, reads storage, or touches the DOM.
 */

/* Token estimate, carried from task 12 unchanged. Crude on purpose — a budget,
 * not a bill. The state block is the entire request here, so what it costs is
 * worth printing honestly. */
function estimate(text) {
  const source = String(text || '');
  if (!source) return 0;
  let latin = 0;
  let other = 0;
  for (const char of source) {
    if (/[Ѐ-ӿԀ-ԯ一-鿿぀-ヿ]/.test(char)) other += 1;
    else latin += 1;
  }
  return Math.ceil(latin / 3.8 + other / 2);
}

/* What each event the model may emit carries. Printed in full, every turn,
 * because a model that has to guess the payload spends a turn being rejected. */
const SHAPES = {
  propose_plan: 'steps: [{"title": "…"}], acceptance: [{"text": "…"}]',
  attach_artifact: 'step: "<id>", artifact: "<the work itself, in full>"',
  complete_step: 'step: "<id>"',
  skip_step: 'step: "<id>", reason: "<why it is not needed>"',
  ask_user: 'question: "<the one thing you need settled>"',
  validate: 'verdicts: [{"id": "<id>", "verdict": "met" | "unmet", "evidence": "…"}]',
};

const RULES = [
  'You are working inside a task state machine. You do not control it.',
  '',
  'The machine has four stages and moves through them in one direction:',
  '',
  '    planning  →  execution  →  validation  →  done',
  '',
  'You cannot ask for a stage. Stages change as a consequence of the events you',
  'emit, and the machine decides when. There is no event that names a stage.',
  '',
  'Every reply you send is exactly one JSON object and nothing else — no prose',
  'around it, no code fence:',
  '',
  '    {"say": "a sentence or two, for the person watching",',
  '     "event": {"kind": "…", …}}',
  '',
  'The events you may emit, and what each carries:',
  '',
  ...Object.entries(SHAPES).map(([kind, shape]) => `    ${kind.padEnd(16)}${shape}`),
  '',
  'Rules the machine enforces, so that you do not spend a turn discovering them:',
  '',
  '  · A plan is steps AND acceptance criteria, in one event. The criteria are',
  '    what your work will be judged against at the end. They are fixed the',
  '    moment the plan is approved, and nothing can revise them afterwards, so',
  '    write the ones you are willing to be held to.',
  '  · You may act only on the step the machine says is active.',
  '  · A step cannot be completed until an artifact has been attached to it.',
  '    The artifact is the work itself, in full — not a description of it.',
  '  · Anything under ALREADY SETTLED has been decided. Do not ask about it',
  '    again, and do not reopen it.',
  '  · If an event is rejected you will be told the reason and get one more',
  '    attempt. After that the turn passes back to the person.',
].join('\n');

/* ----------------------------------------------------------- rendering state */

function indent(text, pad) {
  return String(text).split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

function renderSteps(state) {
  if (!state.steps.length) return ['THE PLAN', '  Nothing has been planned yet.'];
  const lines = ['THE PLAN'];
  for (const step of state.steps) {
    const mark = step.status === 'active' ? 'ACTIVE ' : step.status.padEnd(7);
    lines.push(`  ${step.id}  ${mark}  ${step.title}`);
    if (step.note) lines.push(`        skipped because: ${step.note}`);
    if (step.artifact) {
      lines.push('        what you attached:');
      lines.push(indent(step.artifact, '          '));
    }
  }
  return lines;
}

function renderAcceptance(state) {
  if (!state.acceptance.length) {
    return ['WHAT WOULD COUNT AS DONE', '  Not yet fixed. Fixing it is part of planning.'];
  }
  const lines = ['WHAT WOULD COUNT AS DONE', '  Fixed during planning. Nothing can change them now.'];
  for (const criterion of state.acceptance) {
    lines.push(`  ${criterion.id}  ${criterion.text}`);
    if (criterion.verdict !== 'unknown') {
      lines.push(`        ${criterion.verdict} — ${criterion.evidence}`);
    }
  }
  return lines;
}

function renderDecisions(state) {
  if (!state.decisions.length) return [];
  const lines = ['ALREADY SETTLED — do not ask about any of this again'];
  for (const decision of state.decisions) {
    lines.push(decision.question
      ? `  · ${decision.question} — ${decision.text}`
      : `  · ${decision.text}`);
  }
  lines.push('');
  return lines;
}

function renderStanding(state) {
  const lines = ['WHERE THINGS STAND'];
  if (state.stage === 'execution') {
    // What is active, and whether it has an artifact, is already legible in
    // THE PLAN above. Saying it twice costs tokens and teaches nothing.
    const closed = state.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    lines.push(`  Stage: execution. ${closed} of ${state.steps.length} steps closed.`);
  } else if (state.stage === 'validation') {
    lines.push(`  Stage: validation. All ${state.steps.length} steps are closed and nothing more can be`);
    lines.push('  attached to them. The machine does not go back.');
  } else if (state.stage === 'planning') {
    lines.push(state.steps.length
      ? '  Stage: planning. A plan exists and is waiting on the person.'
      : '  Stage: planning. Nothing has been planned yet.');
  } else {
    lines.push(`  Stage: ${state.stage}.`);
  }
  return lines;
}

function renderSlot(state) {
  const lines = ['WHAT IS EXPECTED OF YOU NOW'];
  if (!state.expect) {
    lines.push('  Nothing. The machine is closed.');
    return lines;
  }
  if (state.expect.actor !== 'model') {
    lines.push(`  Nothing yet — the machine is waiting on the person (${state.expect.kinds.join(' or ')}).`);
    return lines;
  }
  const kinds = Machine.legalKinds(state).filter((kind) => Machine.EVENTS[kind].actor === 'model');
  lines.push(`  ${state.expect.why}`);
  lines.push('');
  lines.push(`  Emit exactly one event, of kind: ${kinds.join(', ')}.`);
  return lines;
}

function nudge(rejection) {
  if (!rejection) return [];
  return [
    '',
    'YOUR LAST EVENT WAS REJECTED',
    `  kind:   ${rejection.kind || '(none)'}`,
    `  reason: ${rejection.reason} — ${rejection.detail}`,
    '',
    '  Read the state above again and emit one event that the machine accepts.',
    '  This is your second and last attempt this turn.',
  ];
}

/* The whole request. Deterministic — the same state compiles to the same
 * bytes, which is what makes "the request after the pause is the request
 * before it" a thing a test can assert rather than a thing to be believed. */
function compile(state, { rejection = null } = {}) {
  const lines = [
    'THE GOAL',
    `  ${state.goal || '(nothing has been asked yet)'}`,
    '',
    ...renderDecisions(state),
    ...renderSteps(state),
    '',
    ...renderAcceptance(state),
    '',
    ...renderStanding(state),
    '',
    ...renderSlot(state),
    ...nudge(rejection),
  ];
  const user = lines.join('\n');
  const text = `${RULES}\n\n${'-'.repeat(72)}\n\n${user}`;
  return {
    system: RULES,
    user,
    text,
    tokens: estimate(text),
    stateTokens: estimate(user),
    rulesTokens: estimate(RULES),
  };
}

function messages(state, options) {
  const block = compile(state, options);
  return [
    { role: 'system', content: block.system },
    { role: 'user', content: block.user },
  ];
}

/* A stable short hash, so two compiled requests can be compared at a glance
 * in the UI and by exact equality in the tests. */
function fingerprint(text) {
  let hash = 5381;
  const source = String(text);
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------- the envelope */

/* Models fence JSON, prefix it with a sentence, and follow it with an apology.
 * Finding the object is the transport's job, not the model's — but what is
 * inside it is judged exactly, and a malformed envelope is a rejection like
 * any other, with the same one retry. */
function carve(reply) {
  const source = String(reply || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : source;
  const start = body.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const char = body[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

function parse(reply) {
  const carved = carve(reply);
  if (!carved) {
    return { ok: false, reason: 'malformed', detail: 'the reply contained no JSON object', say: '', event: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(carved);
  } catch (error) {
    return { ok: false, reason: 'malformed', detail: `the JSON did not parse: ${error.message}`, say: '', event: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', detail: 'the envelope was not an object', say: '', event: null };
  }
  const say = typeof parsed.say === 'string' ? parsed.say.trim() : '';
  const event = parsed.event;
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.kind !== 'string') {
    return { ok: false, reason: 'malformed', detail: 'the envelope carried no event with a kind', say, event: null };
  }
  return { ok: true, reason: null, detail: '', say, event };
}

const Protocol = {
  RULES,
  SHAPES,
  estimate,
  compile,
  messages,
  parse,
  carve,
  fingerprint,
  nudge: (rejection) => nudge(rejection).join('\n'),
};

if (typeof module !== 'undefined' && module.exports) module.exports = Protocol;
