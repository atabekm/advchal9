/* The grid: the same questions, asked as different people.
 *
 * Personalization is the part of the answer determined by who is asking rather
 * than by what was asked. Hold the questions fixed, vary the person, and what
 * changes is the whole of it — so this is not a demo bolted onto the task, it
 * is the definition executed.
 *
 * Five rows, and two of them are not profiles.
 *
 * `no profile` sends no block at all. Without it there are three answers that
 * differ from each other and no way to say what the default was or which
 * direction any profile moved it.
 *
 * `Sam, again` is the same profile and the same question in a second request.
 * Whatever differs there is the model disagreeing with itself, and it is the
 * bar every other difference has to clear. One repeat cannot characterise the
 * variance, but it can catch a field that is pure coin-flip, and a field that
 * disagrees with itself is reported as unstable rather than counted.
 */

/* The questions declare what they cannot exercise, before any answer exists.
 * Per field AND value: a bullet list can be produced for any question, a
 * code-first answer cannot. See check.js for why this is a denylist. */
const QUESTIONS = [
  {
    id: 'ratelimit',
    text: 'How do I stop one client from hammering my API?',
    note: 'code applies, and so does everything else',
  },
  {
    id: 'database',
    text: 'Postgres or MongoDB for a new service that stores orders?',
    note: 'an opinion — code is possible but not required',
  },
  {
    id: 'sessions',
    text: 'Why is it a bad idea to keep user sessions in server memory?',
    note: 'the one where expertise should show, and nothing can check it',
  },
  {
    id: 'slipped',
    text: 'How should I tell the team that the launch date has slipped?',
    cannotApply: ['shape:code-first'],
    why: 'there is no code in this answer for anything to lead with',
    note: 'code-first is n/a here by declaration, not because the reply lacked code',
  },
];

const ROWS = [
  { id: 'none', label: 'no profile', colour: 'none', baseline: true, profile: () => ({ ...Profile.EMPTY }) },
  { id: 'dina', label: 'Дина', colour: 'dina', profile: () => ({ ...Profile.PEOPLE.dina }) },
  { id: 'sam', label: 'Sam', colour: 'sam', profile: () => ({ ...Profile.PEOPLE.sam }) },
  { id: 'sam2', label: 'Sam, again', colour: 'sam', repeatOf: 'sam', profile: () => ({ ...Profile.PEOPLE.sam }) },
  { id: 'priya', label: 'Priya', colour: 'priya', profile: () => ({ ...Profile.PEOPLE.priya }) },
];

/* One request. Not streamed — nobody is reading it as it arrives, and twenty
 * streams would be twenty progress bars nobody asked for. */
async function askCell({ row, question, model, temperature, signal }) {
  const profile = row.profile();
  const { messages, block } = Profile.assemble({ profile, question: question.text });
  try {
    const result = await Api.send({
      model, messages, temperature, stream: false, signal, maxTokens: 1600,
    });
    return {
      rowId: row.id,
      questionId: question.id,
      profile,
      blockTokens: block.tokens,
      text: result.text,
      usage: result.usage,
      cost: result.cost,
      results: Check.checkReply({ profile, reply: result.text, question }),
    };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return {
      rowId: row.id,
      questionId: question.id,
      profile,
      blockTokens: block.tokens,
      error: error.message || String(error),
      results: [],
    };
  }
}

/* The noise floor.
 *
 * For every field the repeat row graded, compare the two runs. Agreement means
 * the field is stable enough for a difference between two people to mean
 * something; disagreement means it is not, and the cell is marked rather than
 * counted. This is the only part of the grid that is about the model rather
 * than about the profiles, and leaving it out would make every other number
 * an anecdote with a table around it.
 */
function noiseFloor(cells) {
  const repeat = ROWS.find((row) => row.repeatOf);
  if (!repeat) return { unstable: [], compared: 0 };
  const unstable = [];
  let compared = 0;

  for (const question of QUESTIONS) {
    const first = cells.find((c) => c.rowId === repeat.repeatOf && c.questionId === question.id);
    const second = cells.find((c) => c.rowId === repeat.id && c.questionId === question.id);
    if (!first || !second || first.error || second.error) continue;
    for (const a of first.results) {
      if (a.verdict === 'unchecked') continue;
      const b = second.results.find((r) => r.label === a.label);
      if (!b) continue;
      compared += 1;
      if (a.verdict !== b.verdict) {
        unstable.push({ questionId: question.id, label: a.label, first: a.verdict, second: b.verdict });
      }
    }
  }

  return { unstable, compared, repeatOf: repeat.repeatOf, repeatId: repeat.id };
}

function isUnstable(noise, questionId, label) {
  return noise.unstable.some((u) => u.questionId === questionId && u.label === label);
}

/* A row's score counts only what it graded, and drops what the repeat row
 * showed to be unreliable. A denominator that quietly includes the coin-flips
 * is a denominator that makes every profile look about the same. */
function rowScore(cells, noise, rowId) {
  let pass = 0;
  let fail = 0;
  let dropped = 0;
  for (const cell of cells.filter((c) => c.rowId === rowId && !c.error)) {
    for (const result of cell.results) {
      if (result.verdict === 'unchecked' || result.verdict === 'na') continue;
      if (isUnstable(noise, cell.questionId, result.label)) { dropped += 1; continue; }
      if (result.verdict === 'pass') pass += 1;
      else fail += 1;
    }
  }
  return { pass, fail, dropped, graded: pass + fail };
}

async function runGrid({ model, temperature, signal, onCell, onProgress }) {
  const cells = [];
  const total = ROWS.length * QUESTIONS.length;
  let done = 0;

  for (const row of ROWS) {
    for (const question of QUESTIONS) {
      if (signal && signal.aborted) throw new DOMException('stopped', 'AbortError');
      if (onProgress) onProgress({ done, total, row: row.label, question: question.text });
      const cell = await askCell({ row, question, model, temperature, signal });
      cells.push(cell);
      done += 1;
      if (onCell) onCell(cell, { done, total });
    }
  }

  const noise = noiseFloor(cells);
  return {
    cells,
    noise,
    rows: ROWS,
    questions: QUESTIONS,
    scores: Object.fromEntries(ROWS.map((row) => [row.id, rowScore(cells, noise, row.id)])),
    cost: cells.reduce((sum, c) => sum + (c.cost || 0), 0),
  };
}

/* -------------------------------------------------------------- the ablation */

/* The brief's second question: what does the assistant take into account
 * automatically?
 *
 * The grid shows that profiles produce different answers. It does not show
 * which *parts* of a profile did the producing, and a profile is a standing
 * cost — every line of it is in the system block of every request, forever. A
 * field that changes nothing is not neutral. It is rent.
 *
 * So: take one profile, drop one field, ask the same questions again, and grade
 * the new reply against the ORIGINAL profile. That last part is the whole
 * trick. Grading the ablated reply against the ablated profile would produce no
 * verdict at all for the field that was removed — nothing was asked, so nothing
 * can be judged. The question is not "did it obey an instruction it wasn't
 * given", it is "would it have done this anyway".
 *
 *   asked, obeyed → dropped, still obeyed    the field is free-riding
 *   asked, obeyed → dropped, stopped         the field is doing the work
 *   asked, ignored                           the field is not being obeyed at all
 *
 * Only checkable fields are ablated. Spending two requests to remove `tone:
 * dry` would buy a pair of answers nobody can adjudicate, and a comparison with
 * no verdict is a comparison that will be settled by whoever reads it last.
 */
const ABLATION_QUESTIONS = QUESTIONS.slice(0, 2);

function ablationFields(profile) {
  return Profile.statedFields(profile).filter((field) => Profile.FIELDS[field].checkable);
}

function fieldCost(profile, field) {
  return Profile.compile(profile).tokens - Profile.compile(Profile.without(profile, field)).tokens;
}

async function askAblationCell({ profile, gradeAs, question, model, temperature, signal }) {
  const { messages } = Profile.assemble({ profile, question: question.text });
  try {
    const result = await Api.send({
      model, messages, temperature, stream: false, signal, maxTokens: 1600,
    });
    return {
      text: result.text,
      cost: result.cost,
      // Graded against the full profile, never against the ablated one.
      results: Check.checkReply({ profile: gradeAs, reply: result.text, question }),
    };
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return { error: error.message || String(error), results: [] };
  }
}

function verdictFor(cell, label) {
  const found = (cell && cell.results || []).find((r) => r.label === label);
  return found ? found.verdict : null;
}

/* One conclusion per (label, question), and it refuses to draw one whenever
 * the two full-profile runs disagreed about that label. An ablation compared
 * against a coin-flip is a coin-flip with a narrative. */
function conclude({ full, repeat, ablated, label }) {
  const a = verdictFor(full, label);
  const b = verdictFor(repeat, label);
  const c = verdictFor(ablated, label);

  if (a === null || c === null) return { outcome: 'no data', detail: 'a request failed' };
  if (a === 'na' || c === 'na') return { outcome: 'n/a', detail: 'the question cannot exercise it' };
  if (b !== null && a !== b) {
    return { outcome: 'unstable', detail: `asked twice, got ${a} then ${b}` };
  }
  if (a === 'fail') return { outcome: 'ignored', detail: 'not obeyed even when asked for' };
  if (c === 'fail') return { outcome: 'load-bearing', detail: 'removing it broke the reply' };
  return { outcome: 'free', detail: 'the reply did it anyway' };
}

const OUTCOME_ORDER = ['load-bearing', 'free', 'ignored', 'unstable', 'n/a', 'no data'];

/* A field's verdict across the questions. Load-bearing anywhere is
 * load-bearing: a preference that matters on one question in two is still
 * buying something, and averaging that away would rank it beside a field that
 * never mattered at all. */
function rollUp(conclusions) {
  const outcomes = conclusions.map((c) => c.outcome);
  for (const outcome of OUTCOME_ORDER) {
    if (outcomes.includes(outcome)) return outcome;
  }
  return 'no data';
}

async function runAblation({ who = 'sam', model, temperature, signal, onProgress }) {
  const profile = { ...Profile.PEOPLE[who] };
  const fields = ablationFields(profile);
  const questions = ABLATION_QUESTIONS;
  const total = (2 + fields.length) * questions.length;
  let done = 0;

  const step = async (label, run) => {
    if (signal && signal.aborted) throw new DOMException('stopped', 'AbortError');
    if (onProgress) onProgress({ done, total, label });
    const cell = await run();
    done += 1;
    return cell;
  };

  const full = {};
  const repeat = {};
  for (const question of questions) {
    full[question.id] = await step(`${profile.name}, whole`, () => askAblationCell({
      profile, gradeAs: profile, question, model, temperature, signal,
    }));
  }
  for (const question of questions) {
    repeat[question.id] = await step(`${profile.name}, whole, again`, () => askAblationCell({
      profile, gradeAs: profile, question, model, temperature, signal,
    }));
  }

  const rows = [];
  for (const field of fields) {
    const stripped = Profile.without(profile, field);
    const cells = {};
    for (const question of questions) {
      cells[question.id] = await step(`without ${field}`, () => askAblationCell({
        profile: stripped, gradeAs: profile, question, model, temperature, signal,
      }));
    }

    // The labels this field is responsible for. `forbid` owns one per ban,
    // because "the constraints held" is not a finding and which one broke is.
    const labels = [...new Set(
      questions.flatMap((q) => (full[q.id].results || [])
        .filter((r) => r.field === field && r.verdict !== 'unchecked')
        .map((r) => r.label)),
    )];

    const perLabel = labels.map((label) => {
      const conclusions = questions.map((question) => ({
        questionId: question.id,
        ...conclude({
          full: full[question.id],
          repeat: repeat[question.id],
          ablated: cells[question.id],
          label,
        }),
      }));
      return { label, conclusions, outcome: rollUp(conclusions) };
    });

    rows.push({ field, cost: fieldCost(profile, field), cells, labels: perLabel });
  }

  const spent = [
    ...Object.values(full), ...Object.values(repeat),
    ...rows.flatMap((r) => Object.values(r.cells)),
  ];

  return {
    who,
    profile,
    questions,
    full,
    repeat,
    rows,
    unchecked: Profile.statedFields(profile).filter((f) => !Profile.FIELDS[f].checkable),
    requests: spent.length,
    cost: spent.reduce((sum, c) => sum + (c.cost || 0), 0),
  };
}

const Grid = {
  QUESTIONS, ROWS, runGrid, noiseFloor, rowScore, isUnstable, askCell,
  ABLATION_QUESTIONS, ablationFields, fieldCost, conclude, rollUp, runAblation, verdictFor,
  OUTCOME_ORDER,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Grid;
