/* Did the reply do what the profile asked?
 *
 * This file is the whole reason task 12 is not task 11 with more fields. Task
 * 11 could prove what reached the model and stopped there, because "remembered
 * the deadline" has no shape a checker can look for. A preference does:
 * "answer in Russian" is decidable, "at most 120 words" is arithmetic, "never
 * use emoji" is a regular expression.
 *
 * Four rules the checks are built on.
 *
 * 1. A verdict is three-valued — pass, fail, n/a — plus `unchecked` for the
 *    fields nobody can grade at all. Two-valued compliance forces every
 *    unaskable question into one of the two answers, and it always lands on
 *    the flattering one.
 *
 * 2. Applicability is a property of the QUESTION, not of the reply. Asking the
 *    reply whether it contains code, and marking `shape: code-first` as n/a
 *    when it does not, scores a model that ignored the preference entirely as
 *    compliant — which is the one failure the checker exists to catch. So a
 *    question declares what it cannot exercise, before any answer exists.
 *
 *    The plan had the question declare what it *could* exercise. That is the
 *    wrong way round: an allowlist means a field added to the schema later is
 *    silently n/a everywhere, and a check that quietly stops running is worse
 *    than one that runs in the wrong place, because the second is visible.
 *
 * 3. A prohibition is always applicable. You can always not do something. Only
 *    requirements can be impossible to meet, which is why the n/a list is
 *    short and every entry on it is a requirement.
 *
 * 4. The check counts what the prompt said. The block says "at most 120 words,
 *    not counting code"; the checker strips the code and counts to 120. If the
 *    two disagreed, a failure would mean the model disobeyed an instruction it
 *    was never given.
 */

const FENCE_BLOCK = /```[\s\S]*?(?:```|$)/g;
// Named BULLET_LINE, not BULLET: markdown.js already has a top-level BULLET,
// and classic scripts share one global lexical scope — see test.js.
const BULLET_LINE = /^\s{0,3}(?:[-*•]|\d+[.)])\s+/;

const EXAMPLE_MARKERS = [
  'for example', 'for instance', 'e.g.', 'such as', 'say you', 'imagine',
  'например', 'к примеру', 'скажем', 'допустим',
];

function withoutCode(reply) {
  return String(reply || '').replace(FENCE_BLOCK, ' ').replace(/`[^`]*`/g, ' ');
}

function words(text) {
  const matched = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matched ? matched.length : 0;
}

function lines(reply) {
  // Fenced code is removed first: a line inside a code block that happens to
  // start with a dash is not a bullet, and counting it as one would fail
  // `shape: prose` on any answer containing a diff.
  return withoutCode(reply).split('\n').map((l) => l.trim()).filter(Boolean);
}

function bulletCount(reply) {
  return lines(reply).filter((l) => BULLET_LINE.test(l)).length;
}

function proseLineCount(reply) {
  return lines(reply).filter((l) => !BULLET_LINE.test(l) && !/^#{1,6}\s/.test(l)).length;
}

function scripts(reply) {
  const text = withoutCode(reply);
  let cyrillic = 0;
  let latin = 0;
  for (const char of text) {
    if (/[Ѐ-ӿ]/.test(char)) cyrillic += 1;
    else if (/[A-Za-z]/.test(char)) latin += 1;
  }
  return { cyrillic, latin, total: cyrillic + latin };
}

function hasExample(reply) {
  const text = String(reply || '');
  if (/```/.test(text)) return true;
  const lower = withoutCode(text).toLowerCase();
  return EXAMPLE_MARKERS.some((marker) => lower.includes(marker));
}

/* --------------------------------------------------------------- the checks */

const verdict = (v, why) => ({ verdict: v, why });

const CHECKS = {
  /* Code is stripped before the script is counted. A Russian answer containing
   * a JavaScript snippet is still a Russian answer, and an alphabet test that
   * did not know this would fail every code-first Russian reply. */
  language: (reply, want) => {
    const { cyrillic, latin, total } = scripts(reply);
    if (total < 20) return verdict('na', 'too little prose to tell');
    const share = want === 'Russian' ? cyrillic / total : latin / total;
    const pct = Math.round(share * 100);
    return share >= 0.7
      ? verdict('pass', `${pct}% ${want === 'Russian' ? 'Cyrillic' : 'Latin'}`)
      : verdict('fail', `only ${pct}% ${want === 'Russian' ? 'Cyrillic' : 'Latin'}`);
  },

  length: (reply, want) => {
    const count = words(withoutCode(reply));
    const limits = Profile.LIMITS;
    if (want === 'terse') {
      return count <= limits.terse
        ? verdict('pass', `${count} words`)
        : verdict('fail', `${count} words, asked for ≤ ${limits.terse}`);
    }
    if (want === 'normal') {
      return count <= limits.normal
        ? verdict('pass', `${count} words`)
        : verdict('fail', `${count} words, asked for ≤ ${limits.normal}`);
    }
    return count >= limits.thorough
      ? verdict('pass', `${count} words`)
      : verdict('fail', `${count} words, asked for ≥ ${limits.thorough}`);
  },

  shape: (reply, want) => {
    const bullets = bulletCount(reply);
    if (want === 'prose') {
      return bullets === 0
        ? verdict('pass', 'no list')
        : verdict('fail', `${bullets} bullet${bullets === 1 ? '' : 's'}`);
    }
    if (want === 'bullets') {
      const prose = proseLineCount(reply);
      if (bullets === 0) return verdict('fail', 'no list at all');
      if (bullets > Profile.LIMITS.bullets) {
        return verdict('fail', `${bullets} items, asked for ≤ ${Profile.LIMITS.bullets}`);
      }
      // One lead-in line and one closing line are not "prose instead of a
      // list". Three are.
      return prose <= 2
        ? verdict('pass', `${bullets} items`)
        : verdict('fail', `${bullets} items but ${prose} loose lines`);
    }
    // code-first: the first thing in the answer is a fence, not a paragraph
    // about the fence.
    const body = String(reply || '').trim();
    if (!/```/.test(body)) return verdict('fail', 'no code at all');
    const before = body.slice(0, body.indexOf('```'));
    const lead = words(before);
    return lead <= 12
      ? verdict('pass', lead ? `${lead} words before the code` : 'opens with code')
      : verdict('fail', `${lead} words of prose before the code`);
  },

  examples: (reply, want) => {
    const present = hasExample(reply);
    if (want === 'required') {
      return present ? verdict('pass', 'an example is present') : verdict('fail', 'no example');
    }
    return present ? verdict('fail', 'an example is present') : verdict('pass', 'none');
  },
};

/* The ban list is checked entry by entry rather than as one field, because
 * "the constraints failed" is not a finding — which constraint failed is. */
function checkBans(reply, forbid) {
  return (forbid || []).map((id) => {
    const ban = Profile.BANS[id];
    if (!ban) {
      return { field: 'forbid', label: `never ${id}`, verdict: 'unchecked', why: 'no predicate for it' };
    }
    return ban.violated(reply)
      ? { field: 'forbid', label: `never ${id}`, verdict: 'fail', why: 'it is in the reply' }
      : { field: 'forbid', label: `never ${id}`, verdict: 'pass', why: 'absent' };
  });
}

/* ------------------------------------------------------------------ verdicts */

/* One reply, one profile, one question — a verdict per stated field.
 *
 * Fields the profile does not state are absent entirely rather than passing.
 * An instruction nobody gave cannot be obeyed, and a row of passes earned by
 * saying nothing is how a compliance score becomes a number that only goes up.
 */
function checkReply({ profile, reply, question = {} }) {
  const stated = Profile.statedFields(profile);
  const cannot = new Set(question.cannotApply || []);
  const results = [];

  for (const field of stated) {
    const spec = Profile.FIELDS[field];
    if (field === 'forbid') {
      results.push(...checkBans(reply, profile.forbid));
      continue;
    }
    if (!spec.checkable) {
      results.push({ field, label: `${spec.label}: ${profile[field]}`, verdict: 'unchecked', why: 'nothing to count' });
      continue;
    }
    // Applicability is declared per field *and value*, not per field. `shape:
    // bullets` can be produced for any question; `shape: code-first` cannot be
    // produced for a question whose answer has no code. Excusing the whole
    // field would hand a free n/a to the two people it does apply to.
    if (cannot.has(field) || cannot.has(`${field}:${profile[field]}`)) {
      results.push({
        field,
        label: `${spec.label}: ${profile[field]}`,
        verdict: 'na',
        why: question.why || 'this question cannot exercise it',
      });
      continue;
    }
    const outcome = CHECKS[field](reply, profile[field]);
    results.push({ field, label: `${spec.label}: ${profile[field]}`, ...outcome });
  }

  return results;
}

/* A summary that refuses to divide by the fields it could not grade. */
function score(results) {
  const pass = results.filter((r) => r.verdict === 'pass').length;
  const fail = results.filter((r) => r.verdict === 'fail').length;
  const na = results.filter((r) => r.verdict === 'na').length;
  const unchecked = results.filter((r) => r.verdict === 'unchecked').length;
  return { pass, fail, na, unchecked, graded: pass + fail };
}

const Check = { checkReply, score, CHECKS, checkBans, words, withoutCode, bulletCount, hasExample, scripts };

if (typeof module !== 'undefined' && module.exports) module.exports = Check;
