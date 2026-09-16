/* The profile: a schema, three people, and the block that goes up the wire.
 *
 * Two different objects are called "a profile" and they are kept apart here
 * because they behave differently.
 *
 *   descriptive   facts about the person      role, expertise, name
 *   prescriptive  instructions about output   language, length, shape, forbid
 *
 * A descriptive field reaches the answer through an inference the model draws
 * and nobody can see. A prescriptive one reaches it as an instruction, and
 * whether it arrived is decidable by looking at the reply. Every field carries
 * `checkable` for exactly that reason: four of the nine are not, and a
 * compliance score computed over all nine would be inventing four of them.
 *
 * Nothing in this file talks to a model, reads storage or touches the DOM.
 * `compile()` is a pure function from a profile to a string, which is what
 * lets test.js exercise the whole schema with no key and no network.
 */

/* Token estimate, carried from task 11 unchanged.
 *
 * Crude on purpose — a budget, not a bill — with one thing taken seriously:
 * a tokeniser trained mostly on English spends roughly twice as many tokens
 * per character on Cyrillic. The profile block is the only thing this task
 * adds to every request, so its size is worth printing honestly, and Дина's
 * block is not the same size as Sam's.
 */
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

function article(word) {
  return /^[aeiou]/i.test(String(word || '').trim()) ? 'an' : 'a';
}

/* ------------------------------------------------------------ the numbers */

/* The thresholds live in one place and are put into the prompt verbatim.
 *
 * That is the difference between checking obedience and checking
 * interpretation. If the block said "be brief" and the checker drew the line
 * at 120 words, a 140-word answer would be scored as a failure to obey an
 * instruction that was never given. So the block says "at most 120 words",
 * the checker counts to 120, and a failure means the model was told a number
 * and did not keep to it.
 *
 * The numbers themselves are arbitrary. They are fixed, documented, and
 * applied identically to every row, which makes the comparisons valid and the
 * absolute values meaningless.
 */
const LIMITS = {
  terse: 120,
  normal: 350,
  thorough: 250, // a floor, not a ceiling
  bullets: 5,
};

/* --------------------------------------------------------------- the ban list */

/* A constraint is a pair: the sentence that asks for it, and the predicate
 * that decides whether it was kept. If the predicate cannot be written, the
 * thing is not a constraint — it is a hope with a confident name.
 *
 * Which is why this catalogue is closed. "Never use jargon" is not a
 * constraint; "never use these ten words" is, and the ten words are listed in
 * the prompt so that the model is refusing something it was actually shown.
 * The editor still accepts free text, and anything not in this catalogue goes
 * into the block and is reported as unchecked rather than quietly passing.
 */
const JARGON = [
  'idempotent', 'sharding', 'backpressure', 'eventual consistency',
  'connection pool', 'p99', 'throughput', 'ACID', 'quorum', 'replication lag',
];

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

const PLEASANTRIES = [
  "I'd be happy to", 'I would be happy to', 'Great question',
  'Certainly!', "That's a great", 'Happy to help',
];

const BANS = {
  emoji: {
    say: 'use emoji',
    violated: (reply) => EMOJI.test(reply),
  },
  pleasantries: {
    say: 'open with a pleasantry such as "I\'d be happy to" or "Great question"',
    violated: (reply) => PLEASANTRIES.some((p) => reply.toLowerCase().includes(p.toLowerCase())),
  },
  code: {
    say: 'include code blocks',
    violated: (reply) => /```/.test(reply),
  },
  jargon: {
    say: `use any of these words: ${JARGON.join(', ')}`,
    violated: (reply) => JARGON.some((term) => new RegExp(`\\b${term}\\b`, 'i').test(reply)),
  },
};

/* --------------------------------------------------------------- the schema */

/* Nine fields. Small enough to hold in your head, and every one chosen because
 * two different people would fill it in differently — a field everybody
 * answers the same way personalises nothing and costs tokens forever.
 *
 * `line` renders the field as a sentence rather than `key=value`. Carried from
 * task 11 for the reason that was true there: a model uses "they want answers
 * of at most 120 words"; a table row it may or may not decide is about the
 * person in front of it. A `line` that returns null is a field nobody has set,
 * and an unset field puts nothing in the block at all — see EMPTY below for
 * why that is not the same as a default.
 */
const FIELDS = {
  name: {
    kind: 'identity',
    type: 'text',
    label: 'name',
    checkable: false,
    line: (v) => (v ? `They are called ${v}.` : null),
  },
  role: {
    kind: 'identity',
    type: 'text',
    label: 'role',
    checkable: false,
    line: (v) => (v ? `They work as ${article(v)} ${v}.` : null),
  },
  expertise: {
    kind: 'identity',
    type: 'choice',
    label: 'expertise',
    values: ['novice', 'working', 'expert'],
    checkable: false,
    line: (v) => ({
      novice: 'They are new to this material — do not assume background knowledge.',
      working: 'They know this material at a working level.',
      expert: 'They are an expert — skip the basics.',
    })[v] || null,
  },
  language: {
    kind: 'format',
    type: 'choice',
    label: 'language',
    values: ['English', 'Russian'],
    checkable: true,
    line: (v) => (v ? `Answer in ${v}.` : null),
  },
  length: {
    kind: 'style',
    type: 'choice',
    label: 'length',
    values: ['terse', 'normal', 'thorough'],
    checkable: true,
    line: (v) => ({
      terse: `Keep it short: at most ${LIMITS.terse} words.`,
      normal: `Keep it under ${LIMITS.normal} words.`,
      thorough: `Be thorough: at least ${LIMITS.thorough} words, and do not skip steps.`,
    })[v] || null,
  },
  shape: {
    kind: 'format',
    type: 'choice',
    label: 'shape',
    values: ['prose', 'code-first', 'bullets'],
    checkable: true,
    line: (v) => ({
      prose: 'Write in prose. Do not use bullet lists.',
      'code-first': 'Lead with code: the answer opens with a code block, explanation after it.',
      bullets: `Answer as a bullet list of at most ${LIMITS.bullets} items.`,
    })[v] || null,
  },
  examples: {
    kind: 'format',
    type: 'choice',
    label: 'examples',
    values: ['required', 'never'],
    checkable: true,
    line: (v) => ({
      required: 'Always include a concrete example.',
      never: 'Do not include examples.',
    })[v] || null,
  },
  tone: {
    kind: 'style',
    type: 'choice',
    label: 'tone',
    values: ['dry', 'warm'],
    checkable: false,
    line: (v) => ({
      dry: 'Keep the tone dry and matter-of-fact.',
      warm: 'Be warm and encouraging.',
    })[v] || null,
  },
  forbid: {
    kind: 'constraint',
    type: 'list',
    label: 'never',
    checkable: true,
    line: (v) => {
      const items = (v || []).map((id) => (BANS[id] ? BANS[id].say : id)).filter(Boolean);
      return items.length ? `Never ${items.join('; never ')}.` : null;
    },
  },
};

const FIELD_ORDER = Object.keys(FIELDS);
const IDENTITY = FIELD_ORDER.filter((f) => FIELDS[f].kind === 'identity');
const PREFERENCES = FIELD_ORDER.filter((f) => FIELDS[f].kind !== 'identity');

/* A profile that asks for nothing.
 *
 * Not a set of defaults — the absence of every preference. The two are easy to
 * conflate and the baseline row of the grid is exactly the difference between
 * them: `length: normal` is an instruction ("under 350 words") and the model
 * will obey it, while an unset `length` is the question the baseline asks,
 * which is what this agent does when nobody has told it anything.
 *
 * So every choice field has an unset state, spelled '', and none of the value
 * lists contains a "no opinion" member. `tone: neutral` would have been a
 * third way of saying the same thing and the first one somebody set by
 * accident.
 */
const EMPTY = {
  name: '', role: '', expertise: '',
  language: '', length: '', shape: '',
  examples: '', tone: '', forbid: [],
};

/* --------------------------------------------------------------- the people */

/* Three profiles that pull in different directions on every axis a checker can
 * count. B and C are near-opposites, which is what makes a difference between
 * their answers attributable to something rather than interesting. A exists
 * because a second language is the one preference whose violation cannot be
 * missed, including by someone watching a video.
 */
const PEOPLE = {
  dina: {
    id: 'dina',
    name: 'Дина',
    role: 'junior developer',
    expertise: 'novice',
    language: 'Russian',
    length: 'thorough',
    shape: 'prose',
    examples: 'required',
    tone: 'warm',
    forbid: [],
  },
  sam: {
    id: 'sam',
    name: 'Sam',
    role: 'staff backend engineer',
    expertise: 'expert',
    language: 'English',
    length: 'terse',
    shape: 'code-first',
    examples: '',
    tone: 'dry',
    forbid: ['emoji', 'pleasantries'],
  },
  priya: {
    id: 'priya',
    name: 'Priya',
    role: 'product manager',
    expertise: 'novice',
    language: 'English',
    length: 'normal',
    shape: 'bullets',
    examples: 'never',
    tone: '',
    forbid: ['code', 'jargon'],
  },
};

/* ------------------------------------------------------------- compilation */

const HEAD = 'Who you are talking to, and how they want to be answered.';

const IDENTITY_HEAD = 'The person:';
const PREFERENCE_HEAD = 'How they want the answer:';

/* One block, two paragraphs, in that order.
 *
 * Who they are first, because it is the frame the instructions are read
 * inside: "at most 120 words" lands differently on an expert than on someone
 * new to the material. Then what they asked for, because it is the part the
 * model is being held to and the part closest to the reply wins arguments.
 *
 * A profile with nothing in it compiles to nothing at all, not to an empty
 * heading. The baseline row of the grid depends on that: "no profile" has to
 * mean no block, not a block that says nothing, or the comparison is between
 * two different prompts and one of them is pretending.
 */
function compile(profile) {
  const p = { ...EMPTY, ...(profile || {}) };
  const identity = [];
  const preferences = [];

  for (const field of FIELD_ORDER) {
    const value = p[field];
    if (value === '' || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const line = FIELDS[field].line(value);
    if (!line) continue;
    (FIELDS[field].kind === 'identity' ? identity : preferences).push({ field, line });
  }

  if (!identity.length && !preferences.length) {
    return { text: '', tokens: 0, lines: [], empty: true };
  }

  const parts = [HEAD];
  if (identity.length) parts.push(`${IDENTITY_HEAD}\n${identity.map((l) => l.line).join(' ')}`);
  if (preferences.length) {
    parts.push(`${PREFERENCE_HEAD}\n${preferences.map((l) => `- ${l.line}`).join('\n')}`);
  }

  const text = parts.join('\n\n');
  return {
    text,
    tokens: estimate(text),
    lines: [...identity, ...preferences],
    empty: false,
  };
}

/* A profile with one field removed — the ablation's only primitive.
 *
 * It returns the field to its neutral value rather than deleting the key,
 * because deleting `length` and setting it to `normal` are different
 * experiments: one asks what the agent does with no instruction, the other
 * asks what it does with a different one. The ablation wants the first.
 */
function without(profile, field) {
  const stripped = { ...profile };
  stripped[field] = FIELDS[field].type === 'list' ? [] : '';
  return stripped;
}

/* Which fields this profile actually asks for anything with. A field sitting
 * at its neutral value contributes no line, so it cannot be ablated: there is
 * nothing to remove and its absence would be indistinguishable from its
 * presence. */
function statedFields(profile) {
  const p = { ...EMPTY, ...(profile || {}) };
  return FIELD_ORDER.filter((field) => {
    const value = p[field];
    if (value === '' || value === null || value === undefined) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return Boolean(FIELDS[field].line(value));
  });
}

const Profile = {
  FIELDS, FIELD_ORDER, IDENTITY, PREFERENCES, EMPTY, PEOPLE, LIMITS, BANS, JARGON,
  compile, without, statedFields, estimate,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Profile;
