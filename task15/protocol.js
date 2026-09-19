/* The protocol: what the model is shown, and what it is allowed to say back.
 *
 * `compile(state)` is the whole request. There is no dialogue underneath it,
 * carried unchanged from task 13, and for the same reason: if resuming needed
 * its own prompt, the state was never sufficient.
 *
 * What this file adds is the thing task 13 deliberately withheld. That prompt
 * said "you cannot ask for a stage — there is no event that names one", which
 * makes skipping impossible by making it unsayable. This one prints the whole
 * edge table every turn, marks which edges are open and which are shut and
 * why, and tells the model it may ask for any transition it likes. Asking is
 * not a way through. It is, however, a thing that can be counted.
 *
 * Nothing here talks to a model, reads storage, or touches the DOM.
 */

/* Token estimate, carried from task 12 unchanged. Crude on purpose — a budget,
 * not a bill. */
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

/* What each action the model may take carries. Printed in full, every turn,
 * because a model that has to guess the payload spends a turn being refused. */
const SHAPES = {
  propose_plan: 'steps: [{"title": "…"}], acceptance: [{"text": "…"}]',
  attach_artifact: 'step: "<id>", artifact: "<the work itself, in full>"',
  complete_step: 'step: "<id>"',
  skip_step: 'step: "<id>", reason: "<why it is not needed>"',
  validate: 'verdicts: [{"id": "<id>", "verdict": "met" | "unmet", "evidence": "…"}]',
  ask_user: 'question: "<the one thing you need settled>"',
};

const DIAGRAM = [
  '  ·──start──▶ planning ──approve_plan──▶ execution ──submit──▶ validation ──accept──▶ done',
  '                                             ▲                     │                   ▲',
  '                                             └────── rework ───────┤',
  '                                                                   └───── abandon ─────┘',
].join('\n');

const RULES = [
  'You are working inside a task lifecycle. You do not control it.',
  '',
  'Four states, and six edges between them:',
  '',
  DIAGRAM,
  '',
  'The edges are the only way anything moves. Each one is owned by one party —',
  'four of the six are the person\'s, and no argument of yours can take one of',
  'those. Each one carries guards, and a guard is shut until the state says it',
  'is open. You will be shown, every turn, which edges leave the state you are',
  'in, who owns each, and which guard is shutting the ones that are shut.',
  '',
  'You may ask for any transition, including one that is not allowed. It will be',
  'refused, you will be told why, and you will be handed the legal route. Asking',
  'is not a way through. Nothing you can say moves an edge that is shut — and',
  'nothing the person says moves one either, however they put it. When what is',
  'being asked for is not a legal move, say so plainly and make a legal one.',
  '',
  'Every reply you send is exactly one JSON object and nothing else — no prose',
  'around it, no code fence:',
  '',
  '    {"say": "a sentence or two, for the person watching",',
  '     "move": {"type": "transition", "trigger": "submit"}}',
  '',
  '    {"say": "…",',
  '     "move": {"type": "action", "kind": "attach_artifact", "step": "s2",',
  '              "artifact": "…"}}',
  '',
  'A transition names a trigger, or names a destination as {"to": "validation"}.',
  'An action names a kind, and carries what that kind needs:',
  '',
  ...Object.entries(SHAPES).map(([kind, shape]) => `    ${kind.padEnd(16)}${shape}`),
  '',
  'Rules the runtime enforces, so that you do not spend a turn discovering them:',
  '',
  '  · A plan is steps AND acceptance criteria, in one action. The criteria are',
  '    what your work will be judged against at the end. They are fixed when the',
  '    plan is approved and nothing revises them afterwards, so write the ones',
  '    you are willing to be held to.',
  '  · An action never changes the state. Closing the last step does not put you',
  '    in validation — `submit` does, and submitting is a move you have to make.',
  '  · You may act only on the step the runtime says is active.',
  '  · A step cannot be completed until an artifact has been attached to it. The',
  '    artifact is the work itself, in full — not a description of it.',
  '  · Every change to the work moves the revision counter, and a validation is',
  '    stamped with the revision it judged. If the work moves afterwards, that',
  '    validation is stale and the door to `done` is shut until you validate',
  '    what is actually there. This is not negotiable and it is not personal.',
  '  · Anything under ALREADY SETTLED has been decided. Do not ask about it',
  '    again, and do not reopen it.',
  '  · If a move is refused you will be told the reason and get one more attempt.',
  '    After that the turn passes back to the person.',
].join('\n');

/* ----------------------------------------------------------- rendering state */

function indent(text, pad) {
  return String(text).split('\n').map((line) => (line ? pad + line : line)).join('\n');
}

// Who a party is, from where the reader is standing.
function who(actor, audience) {
  if (actor === audience) return 'yours';
  return actor === 'user' ? "the person's" : "the assistant's";
}

function renderSteps(state) {
  if (!state.steps.length) return ['THE PLAN', '  Nothing has been planned yet.'];
  const lines = ['THE PLAN'];
  for (const step of state.steps) {
    const mark = step.status === 'active' ? 'ACTIVE ' : step.status.padEnd(7);
    lines.push(`  ${step.id}  ${mark}  ${step.title}`);
    if (step.note) lines.push(`        sent back because: ${step.note}`);
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
  const lines = ['WHAT WOULD COUNT AS DONE', state.state === 'planning'
    ? '  Proposed. They are fixed the moment the plan is approved, and nothing revises them after.'
    : '  Fixed when the plan was approved. Nothing changes them now.'];
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

/* The freshness line. It is three integers and a word, and it is the whole of
 * what stops a finished-looking task from finishing. */
function renderFreshness(state) {
  if (!state.validation) {
    return [`  Revision ${state.revision}. Nothing has been validated yet.`];
  }
  const stale = state.validation.at !== state.revision;
  return [
    `  Revision ${state.revision}. Last validated at revision ${state.validation.at}`
    + ` — ${stale ? 'STALE' : 'fresh'}.`,
    ...(stale
      ? [`  ${state.revision - state.validation.at} change(s) to the work since. Those verdicts judge something that no longer exists.`]
      : []),
  ];
}

function renderRemark(state) {
  if (!state.remark) return [];
  // Just what was said. What to do about it is a rule, and rules live in the
  // system message — which is also what lets the ladder build a prose-only arm
  // by deleting one block from this one rather than writing a second renderer.
  return [
    'WHAT THE PERSON JUST SAID',
    `  ${state.remark.text}`,
    ...(state.remark.heard ? ['  (you have already moved since)'] : []),
    '',
  ];
}

function renderStanding(state) {
  const lines = ['WHERE THINGS STAND'];
  const open = Lifecycle.openSteps(state).length;
  if (state.state === 'execution') {
    const closed = state.steps.length - open;
    lines.push(`  State: execution. ${closed} of ${state.steps.length} steps closed.`);
    if (open === 0) lines.push('  Nothing is left open. The work is waiting to be submitted.');
  } else if (state.state === 'validation') {
    lines.push(`  State: validation. All ${state.steps.length} steps are closed.`);
  } else if (state.state === 'planning') {
    lines.push(state.steps.length
      ? '  State: planning. A plan exists and is waiting on the person.'
      : '  State: planning. Nothing has been planned yet.');
  } else {
    lines.push(`  State: ${state.state}.`);
  }
  if (state.rounds) {
    lines.push(`  ${state.rounds} round trip(s) through rework so far.`);
  }
  lines.push(...renderFreshness(state));
  return lines;
}

/* The edge table, as the state sees it. This is the block task 13 had no
 * equivalent of: not a rule the model is told about, but the graph it is
 * standing inside, with the shut doors marked and named. */
function renderEdges(state, audience = 'model') {
  const offered = Lifecycle.offers(state);
  if (!offered.transitions.length) {
    return ['THE EDGES OUT OF HERE', '  None. The machine is closed.'];
  }
  const lines = [`THE EDGES OUT OF ${String(state.state).toUpperCase()}`];
  for (const edge of offered.transitions) {
    const owner = who(edge.actor, audience);
    lines.push(`  ${edge.trigger.padEnd(14)}→ ${edge.to.padEnd(12)}${owner.padEnd(18)}${edge.open ? 'OPEN' : 'SHUT'}`);
    for (const guard of edge.guards) {
      if (guard.holds) continue;
      const hand = guard.owner ? ` (${who(guard.owner, audience)} to open: ${guard.remedy})` : '';
      lines.push(`  ${' '.repeat(14)}  shut: ${guard.label}${hand}`);
    }
    if (edge.blocked === 'question-open') {
      lines.push(`  ${' '.repeat(14)}  shut: a question is waiting for an answer`);
    }
  }
  return lines;
}

function renderSlot(state) {
  const lines = ['WHAT IS EXPECTED OF YOU NOW'];
  const offered = Lifecycle.offers(state);
  if (offered.turn === null) {
    lines.push('  Nothing. The machine is closed.');
    return lines;
  }
  if (offered.turn !== 'model') {
    lines.push('  Nothing yet — the machine is waiting on the person.');
    if (offered.question) lines.push(`  You asked: ${offered.question}`);
    return lines;
  }
  const actions = offered.actions.filter((a) => a.actor === 'model').map((a) => a.kind);
  const edges = offered.transitions.filter((t) => t.actor === 'model' && t.open).map((t) => t.trigger);
  lines.push(`  Actions you may take: ${actions.join(', ') || 'none'}.`);
  lines.push(`  Transitions open to you: ${edges.join(', ') || 'none'}.`);
  lines.push('');
  lines.push('  Emit exactly one move.');
  return lines;
}

/* ---------------------------------------------------------- the refusal, said
 *
 * One renderer, two audiences. The person reading the page and the model
 * reading the nudge are shown the same refusal, assembled from the same
 * record — because a refusal the model is shown privately and the person is
 * not is a refusal nobody can check. */
function sayRefusal(rejection, audience = 'model') {
  if (!rejection) return '';
  const lines = [
    `REFUSED — ${rejection.reason}`,
    `  ${rejection.detail}`,
  ];

  if (rejection.guards && rejection.guards.length) {
    lines.push('');
    lines.push('  what is shut:');
    for (const guard of rejection.guards) {
      const hand = guard.owner ? `${who(guard.owner, audience)} to open` : 'nobody can open it from here';
      lines.push(`    · ${guard.label} — ${hand}`);
      lines.push(`      ${guard.remedy}`);
    }
  }

  if (rejection.route && rejection.route.ok && rejection.route.path.length) {
    const path = rejection.route.path;
    lines.push('');
    lines.push(`  the legal route is ${path.length} move${path.length === 1 ? '' : 's'}:`);
    path.forEach((leg, i) => {
      lines.push(`    ${i + 1}. ${leg.edge.trigger.padEnd(14)}${leg.edge.from} → ${leg.edge.to}   ${who(leg.actor, audience)}`);
      if (leg.edge.guards.length) {
        const needs = leg.guards.map((g) => (g.holds === null ? g.label : `${g.label} [${g.holds ? 'holds' : 'shut'}]`));
        lines.push(`       needs: ${needs.join(' · ')}`);
      }
    });
    lines.push('');
    lines.push('    only the first of those was checked against the state as it is now.');
    lines.push('    the rest are requirements, not promises.');
  }

  if (rejection.route && !rejection.route.ok && rejection.route.reason === 'no-edge') {
    lines.push('');
    lines.push('  there is no route there at all, from here.');
  }

  return lines.join('\n');
}

/* The route explorer's answer, and the refusal's, are the same text — which is
 * the point. Asking "where can it get to" and being told "you cannot go there"
 * are the same question with the same answer, and if the page rendered them
 * two different ways one of them would be a story. */
function renderRoute(state, target, audience = 'model') {
  const found = Lifecycle.route(state, target);
  const here = state.state === null ? 'the start' : state.state;
  if (!found.ok) {
    return found.reason === 'no-such-state'
      ? `"${target}" is not a state. The states are ${Lifecycle.STATES.join(', ')}.`
      : `There is no route from ${here} to ${target}. Not a shut door — no door.`;
  }
  if (!found.path.length) return `The machine is already in ${target}.`;
  const lines = [`From ${here} to ${target} is ${found.path.length} move${found.path.length === 1 ? '' : 's'}:`, ''];
  found.path.forEach((leg, i) => {
    lines.push(`  ${i + 1}. ${leg.edge.trigger.padEnd(14)}${leg.edge.from} → ${leg.edge.to}   ${who(leg.actor, audience)}`);
    for (const guard of leg.guards) {
      const mark = guard.holds === null ? '·' : (guard.holds ? '✓' : '✗');
      lines.push(`     ${mark} ${guard.label}`);
      if (guard.holds === false) lines.push(`       ${guard.remedy}`);
    }
  });
  lines.push('');
  lines.push('  ✓ and ✗ were checked against the state as it is now, and only the first');
  lines.push('  move could be. The rest are marked · — requirements, not promises,');
  lines.push('  because the state they would be judged against does not exist yet.');
  return lines.join('\n');
}

function nudge(rejection) {
  if (!rejection) return [];
  return [
    '',
    'YOUR LAST MOVE WAS REFUSED',
    ...sayRefusal(rejection, 'model').split('\n').map((line) => `  ${line}`),
    '',
    '  Read the state above again and make one move the runtime accepts.',
    '  This is your second and last attempt this turn.',
  ];
}

/* The whole request. Deterministic — the same state compiles to the same bytes,
 * which is what makes "the request after the pause is the request before it" a
 * thing a test asserts rather than a thing to be believed. */
function compile(state, { rejection = null } = {}) {
  const lines = [
    'THE GOAL',
    `  ${state.goal || '(nothing has been asked yet)'}`,
    '',
    ...renderRemark(state),
    ...renderDecisions(state),
    ...renderSteps(state),
    '',
    ...renderAcceptance(state),
    '',
    ...renderStanding(state),
    '',
    ...renderEdges(state, 'model'),
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

/* A stable short hash, so two compiled requests can be compared at a glance in
 * the UI and by exact equality in the tests. */
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
 * inside it is judged exactly, and a malformed envelope is a refusal like any
 * other, with the same one retry. */
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

function fail(detail, say = '') {
  return { ok: false, reason: 'malformed', detail, say, move: null };
}

function parse(reply) {
  const carved = carve(reply);
  if (!carved) return fail('the reply contained no JSON object');

  let parsed;
  try {
    parsed = JSON.parse(carved);
  } catch (error) {
    return fail(`the JSON did not parse: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('the envelope was not an object');
  }

  const say = typeof parsed.say === 'string' ? parsed.say.trim() : '';
  const move = parsed.move;
  if (!move || typeof move !== 'object' || Array.isArray(move)) {
    return fail('the envelope carried no move', say);
  }

  // A model that writes {"move": {"trigger": "submit"}} and omits the type has
  // said something unambiguous, and refusing it would be pedantry rather than
  // adjudication. The type is inferred, and only a move that is ambiguous or
  // empty is refused.
  const type = move.type
    || (move.trigger || move.to ? 'transition' : null)
    || (move.kind ? 'action' : null);
  if (type !== 'transition' && type !== 'action') {
    return fail('the move is neither a transition nor an action', say);
  }
  if (type === 'transition' && !move.trigger && !move.to) {
    return fail('a transition names a trigger or a destination state', say);
  }
  if (type === 'action' && typeof move.kind !== 'string') {
    return fail('an action names a kind', say);
  }

  // The actor is not the model's to declare. It is stamped here, by the side
  // that knows.
  return { ok: true, reason: null, detail: '', say, move: { ...move, type, actor: 'model' } };
}

const Protocol = {
  RULES,
  SHAPES,
  DIAGRAM,
  estimate,
  compile,
  messages,
  parse,
  carve,
  explain: sayRefusal,
  renderRoute,
  fingerprint,
  renderEdges: (state, audience) => renderEdges(state, audience).join('\n'),
  nudge: (rejection) => nudge(rejection).join('\n'),
};

if (typeof module !== 'undefined' && module.exports) module.exports = Protocol;
