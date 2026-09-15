/* Extraction: what the model is asked to propose, and what it is not allowed
 * to invent.
 *
 * One rule comes across whole from task 10's fact store, and it is the only
 * defence this app has against the failure mode that makes memory worse than
 * no memory:
 *
 *     a value that is not a verbatim span of a cited message is not storable
 *
 * It is checked here, on write, by string containment against the message
 * named in `from` — not requested in the prompt, not graded afterwards, not
 * left to a model's good intentions. Whatever produces candidates, a careful
 * model or a careless one, cannot put a sentence into a memory layer that
 * nobody said. That matters more here than it did in task 10, because a
 * long-term store is not emptied at the end of the conversation: an invention
 * that reaches it sits in the system slot of every future request, for months,
 * where it is indistinguishable from something that happened.
 *
 * What is new is one field. A candidate now proposes a *layer* as well as a
 * value, and the proposal is recorded and then ignored by anything that
 * writes. router.js decides. The proposal is kept because the disagreements
 * between what a model thinks is permanent and what the rules think is
 * permanent are the most interesting thing on the screen.
 *
 *   buildRequest({ turn, memory })  the messages for the extraction call
 *   parseCandidates(text)           JSON in, normalised candidates out
 *   gate(candidate, turn)           the verbatim rule
 *   KINDS                           what a candidate may claim to be
 */

/* The kinds. Each one is a claim about lifetime as much as about content,
 * which is why the router can read a kind and reach a layer.
 *
 * `profile` and `knowledge` are new in this task. Task 10 had no layer that
 * outlived a conversation, so it had no need for a kind that meant "this is
 * not about the conversation at all". */
const KINDS = [
  'profile',        // about the person: what to call them, what language
  'knowledge',      // true regardless of any task
  'goal',           // what this task is for
  'constraint',     // what the answer may not do
  'open_question',  // asked, not yet answered
  'decision',       // settled inside this task
  'agreement',      // settled between both of them
  'identifier',     // a name, path, number whose exact characters matter
  'artifact',       // something the task produced
  'other',
];

const LAYER_NAMES = ['short', 'working', 'long'];

/* The instruction.
 *
 * It lives beside the gate that enforces its first clause, for the reason task
 * 9 put its summary prompt beside the compressor: this is not a persona, it is
 * a specification of what may be remembered, and that is this file's business.
 *
 * Clause 1 is the only one that cannot be enforced from here, which is exactly
 * why it is also enforced in `gate()`. A model that ignores it does not
 * corrupt a layer; it produces nothing, loudly, in the rejected column.
 *
 * Clause 2 is the new one. It asks for a layer and explains the three
 * lifetimes in the terms the rules use, so that when the router overrules the
 * model the disagreement is about judgement rather than about vocabulary.
 */
const EXTRACT_SYSTEM = [
  'You maintain the memory of another assistant. It has three separate stores,',
  'and they are told apart by how long things live in them:',
  '',
  '  short   the current dialogue. It already holds the last few messages',
  '          verbatim, so nothing needs to be copied into it.',
  '  working the current task. Emptied when the task is finished.',
  '  long    the person. Survives every conversation, forever, until someone',
  '          deletes it by hand.',
  '',
  'You are given one turn — what the user said, what the assistant replied —',
  'and what is already stored. Reply with JSON and nothing else:',
  '',
  '{"candidates":[{"key":"deadline","value":"11 March","kind":"decision",'
    + '"layer":"working","from":"user","op":"set"}]}',
  '',
  'Rules:',
  '1. Every value must be copied WORD FOR WORD from the message named in',
  '   "from" — "user" or "assistant". Do not rephrase, reformat a date, round',
  '   a number or expand an abbreviation, and do not quote one message while',
  '   naming the other. A value that is not in the message you named is',
  '   discarded before it reaches any store, so writing one loses the fact',
  '   entirely.',
  '2. "layer" is your judgement about how long this should outlive the',
  '   conversation. Ask: would this still be worth knowing next month, in a',
  '   conversation about something else? If yes, "long". If it only matters',
  '   until this piece of work is finished, "working". If it will not matter',
  '   after the next few messages, do not propose it at all.',
  '3. "kind" is one of: profile, knowledge, goal, constraint, open_question,',
  '   decision, agreement, identifier, artifact, other.',
  '4. Reuse a key from the stored list whenever the turn is about the same',
  '   thing. Invent a key only when nothing in the list fits. A key must name',
  '   what the value is about — "deadline", "database", "staging_box" — never',
  '   a pronoun: "it", "that", "this", "one".',
  '5. When the turn changes something already stored, write that same key with',
  '   the new value. That is the only way a store can stop believing the old',
  '   one.',
  '6. Use op "clear", with no value, only when the turn explicitly withdraws',
  '   something already stored.',
  '7. Keep values short — a few words. A value the length of a sentence is',
  '   prose, and prose is what these stores exist to avoid.',
  '8. Small talk carries nothing. Reply {"candidates":[]} rather than',
  '   reaching. Most turns are small talk.',
  '9. A question is a request, not a statement. Take nothing from one — the',
  '   words in "which database are we using?" are the user asking what you',
  '   already store, and writing them back would overwrite the answer with',
  '   the question.',
  '10. From the reply, take only what was settled or produced there: a',
  '    commitment the assistant made, a value it worked out, the wording of',
  '    an agreement the user then accepted. Never an option it was offering,',
  '    a guess, or anything it was only asking about.',
  '11. When both halves of the turn carry the same thing, name "user". The',
  '    user states it and the assistant acknowledges it; the statement is the',
  '    commitment and the acknowledgement is not.',
].join('\n');

/* Comparison for the verbatim rule.
 *
 * Case, whitespace and curly quotes are folded because they carry nothing a
 * stored value depends on, and rejecting a fact over an apostrophe would be
 * absurd. Nothing else is normalised. A synonym, a reformatted date, a rounded
 * number — substitution is exactly what the rule exists to catch, so "4th of
 * March" does not match "4 March" and must not.
 */
function flatten(text) {
  return String(text || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// What the extractor is shown of what is already stored: keys, not values.
// Keys are enough to make it reuse one instead of inventing a synonym, and
// sending the values back would invite it to restate them as new candidates
// every turn — a store that re-proposes its own contents forever.
function renderKnown(memory) {
  const lines = [];
  const profile = memory.long.all('profile');
  const decisions = memory.long.all('decisions');
  const knowledge = memory.long.all('knowledge');
  const working = memory.working.all();

  lines.push(`long.profile: ${profile.length ? profile.map((i) => i.key).join(', ') : '(empty)'}`);
  lines.push(`long.decisions: ${decisions.length ? decisions.map((i) => i.key).join(', ') : '(empty)'}`);
  lines.push(`long.knowledge: ${knowledge.length ? knowledge.map((i) => i.key).join(', ') : '(empty)'}`);
  const task = memory.working.task;
  lines.push(`working${task.goal ? ` (task: "${task.goal}")` : ' (no task named yet)'}: `
    + `${working.length ? working.map((i) => i.key).join(', ') : '(empty)'}`);
  return lines.join('\n');
}

function buildRequest({ turn, memory }) {
  const source = [
    '--- already stored ---',
    renderKnown(memory),
    '',
    '--- the turn ---',
    `user: ${turn.user || ''}`,
    `assistant: ${turn.assistant || ''}`,
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: source },
    ],
    source,
  };
}

/* JSON, eventually.
 *
 * Models fence their JSON, apologise before it, and occasionally add a
 * sentence after it. None of that is a reason to lose a turn's memory, so the
 * first balanced object in the text is taken and the rest is ignored. A reply
 * with no object at all is a failure and is reported as one — quietly dropping
 * it would make a broken extractor look like a quiet conversation.
 */
function parseCandidates(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return { candidates: [], error: 'no JSON in the reply' };

  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { candidates: [], error: 'the JSON object was never closed' };

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return { candidates: [], error: `unparseable JSON: ${error.message}` };
  }

  const list = Array.isArray(parsed.candidates) ? parsed.candidates
    : Array.isArray(parsed.facts) ? parsed.facts
      : [];
  return { candidates: list.map(normalise).filter(Boolean), error: null };
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const op = raw.op === 'clear' ? 'clear' : 'set';
  const key = String(raw.key || '').trim();
  if (!key) return null;
  return {
    key,
    value: op === 'clear' ? '' : String(raw.value == null ? '' : raw.value).trim(),
    kind: KINDS.includes(raw.kind) ? raw.kind : 'other',
    // The model's opinion, kept under a name that cannot be mistaken for a
    // decision. Nothing downstream is allowed to read this and write.
    proposed: LAYER_NAMES.includes(raw.layer) ? raw.layer : null,
    from: raw.from === 'assistant' ? 'assistant' : 'user',
    op,
  };
}

/* The gate.
 *
 * Three ways to fail, and all three are reported rather than silently
 * dropped — the rejected column is the only evidence anyone has that the rule
 * is doing something, and an empty rejected column next to an empty store
 * means something very different from an empty rejected column next to a full
 * one.
 */
function gate(candidate, turn) {
  if (candidate.op === 'clear') return { ok: true, reason: null };

  if (!candidate.value) {
    return { ok: false, reason: 'no value' };
  }

  const said = candidate.from === 'assistant' ? turn.assistant : turn.user;
  if (!said) {
    return { ok: false, reason: `quoted the ${candidate.from}, who said nothing this turn` };
  }

  if (!flatten(said).includes(flatten(candidate.value))) {
    return {
      ok: false,
      reason: `not a verbatim span of the ${candidate.from}'s message`,
      claimed: said,
    };
  }

  return { ok: true, reason: null };
}
