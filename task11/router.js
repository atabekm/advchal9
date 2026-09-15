/* The router: the explicit choice.
 *
 * The brief's second requirement is the one worth building — *you explicitly
 * choose what is stored and where*. A model that is asked nicely to pick a
 * layer does choose, but it chooses somewhere nobody can see, differently on
 * Tuesday, and there is no way to be shown the rule because there was no rule.
 *
 * So this file is a list of seven rules, in order, first match wins, and every
 * write carries the number of the rule that put it there. The model's proposal
 * is recorded next to it. Where they disagree, both are on screen and neither
 * is hidden, because the disagreements are the only evidence that a choice was
 * made at all rather than a default taken.
 *
 *   router.plan(candidates, context)   decisions, without writing anything
 *   router.commit(decisions)           the writes, and the log entries
 *   router.handle(candidates, context) both, which is what the agent calls
 *   router.manual(...)                 a person moved something: rule 0
 *   router.promote(...)                a task closed and something outlived it
 *   router.log                         newest first
 *
 * It is a pure function from candidates to layers, given the state of memory.
 * It never sends anything and never touches the DOM, and `plan()` writes
 * nothing at all — which is what makes the rules testable without a model, a
 * key, or a network.
 */

/* Aliases onto the five profile fields.
 *
 * The profile is typed, so a candidate keyed `user_name` has to become `name`
 * or be refused. Refusing would be defensible and would also mean the layer
 * quietly stays empty while the model keeps proposing the same fact under a
 * slightly different key every week. */
const PROFILE_ALIASES = {
  name: 'name',
  user_name: 'name',
  username: 'name',
  called: 'name',
  language: 'language',
  preferred_language: 'language',
  reply_language: 'language',
  tone: 'tone',
  style: 'tone',
  register: 'tone',
  timezone: 'timezone',
  tz: 'timezone',
  location: 'timezone',
  role: 'role',
  job: 'role',
  occupation: 'role',
  profession: 'role',
};

// A candidate's kind, translated into the kinds the working layer ranks by.
const WORKING_KIND = {
  goal: 'goal',
  constraint: 'constraint',
  open_question: 'open_question',
  decision: 'decision',
  agreement: 'decision',
  identifier: 'artifact',
  artifact: 'artifact',
  other: 'artifact',
};

/* Words that are in every sentence and are about nothing. Used only by rule 2,
 * and only to answer one question: does this value carry anything at all, or
 * is it a phrase that reads like content because it is grammatical? */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'it', 'this', 'that', 'we', 'i',
  'you', 'they', 'he', 'she', 'me', 'my', 'us', 'him', 'her', 'our', 'your',
  'their', 'its', 'mine', 'yours', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'have', 'has', 'had', 'not', 'no', 'yes', 'ok', 'okay',
  'so', 'as', 'by', 'from', 'about', 'just', 'like', 'get', 'got', 'thing',
  'и', 'в', 'на', 'с', 'что', 'это', 'не', 'я', 'мы', 'ты', 'он', 'она', 'они',
  'да', 'нет', 'но', 'как', 'для', 'по', 'то', 'бы', 'же',
]);

/* Acknowledgement, kept separate from the grammar words because it is a
 * different claim. "Sounds good to me" is a grammatical sentence made
 * entirely of these, and it is the single most common thing a store like this
 * fills up with: it reads like agreement, it is agreement, and it stops
 * meaning anything two messages later. The window has it for as long as it is
 * worth having. */
const PLEASANTRIES = new Set([
  'sounds', 'good', 'great', 'fine', 'sure', 'nice', 'right', 'well', 'thanks',
  'thank', 'please', 'sorry', 'hello', 'hi', 'hey', 'cool', 'perfect',
  'exactly', 'maybe', 'really', 'agreed', 'noted', 'understood', 'alright',
  'хорошо', 'отлично', 'спасибо', 'привет', 'конечно', 'ладно', 'понятно',
  'супер', 'ясно',
]);

/* Does the value say anything?
 *
 * A digit or a path-shaped string is almost always the thing worth keeping — a
 * date, a version, a hostname. Failing that, one word that is neither grammar
 * nor acknowledgement is the floor, and one is deliberately low: "Postgres" and
 * "Russian" are single words and are exactly what these stores are for.
 *
 * "Sounds good to me" is four words and clears none of the three, which is the
 * case the rule exists for. It is not a weak fact; it is the conversation
 * agreeing with itself, and it belongs in the transcript.
 */
function carriesContent(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/\d/.test(text)) return true;
  if (/[/\\@]/.test(text) && text.length > 3) return true;
  const content = text.split(/\s+/).filter((word) => {
    const bare = word.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
    return bare.length > 1 && !STOPWORDS.has(bare) && !PLEASANTRIES.has(bare);
  });
  return content.length >= 1;
}

/* The rules. The order is the rule.
 *
 * Read top to bottom: is it a withdrawal, is it worth storing anywhere, is it
 * about the person, is it true regardless of the work, is it the shape of the
 * work, is it something settled during the work, or is it none of the above.
 * Each question is narrower than the one before, which is why first-match-wins
 * is a policy rather than an accident of ordering.
 */
const RULES = [
  {
    n: 1,
    name: 'retraction',
    why: 'the turn withdrew something already stored, so the write is a deletion',
  },
  {
    n: 2,
    name: 'volatility',
    why: 'it names nothing, or says nothing the short-term window does not '
      + 'already hold for as long as it matters',
  },
  {
    n: 3,
    name: 'profile',
    why: 'it is about the person, not about the work, and the person is still '
      + 'the same person next month',
  },
  {
    n: 4,
    name: 'knowledge',
    why: 'it is true regardless of which task is open, so tying it to one '
      + 'would delete it when that task closes',
  },
  {
    n: 5,
    name: 'task shape',
    why: 'a goal, a constraint, an open question or an artifact is about this '
      + 'task by definition and stops meaning anything when it ends',
  },
  {
    n: 6,
    name: 'decision',
    why: 'a decision belongs to the task while the task is open — it gets '
      + 'revised twice before lunch — and is offered for promotion when it closes',
  },
  {
    n: 7,
    name: 'fallback',
    why: 'nothing above matched, so it goes where it can be evicted first',
  },
];

const MANUAL_RULE = {
  n: 0,
  name: 'manual',
  why: 'a person moved it, and no rule may take the credit',
};

const PROMOTION_RULE = {
  n: 0,
  name: 'promotion',
  why: 'the task it was decided in closed, and it was judged to outlive it',
};

function ruleBy(n) {
  return RULES.find((rule) => rule.n === n) || RULES[RULES.length - 1];
}

class Router {
  constructor({ memory, onEvent = null, logLimit = 200 } = {}) {
    if (!memory) throw new Error('The router needs somewhere to route to.');
    this._memory = memory;
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._log = [];
    this._limit = logLimit;
  }

  static get rules() { return RULES.map((rule) => ({ ...rule })); }

  get log() { return this._log.slice(); }

  restoreLog(entries = []) {
    this._log = Array.isArray(entries) ? entries.slice(0, this._limit) : [];
  }

  clearLog() { this._log = []; }

  _record(entry) {
    const full = { at: Date.now(), ...entry };
    this._log.unshift(full);
    this._log = this._log.slice(0, this._limit);
    this._onEvent('route', full);
    return full;
  }

  /* Where does this candidate go?
   *
   * Nothing is written here. A decision is a description of a write, and the
   * separation is what lets the whole rule set be exercised by hand-built
   * candidates with no model, no key and no network — which is how every rule
   * below was checked before anything was ever sent anywhere.
   */
  decide(candidate) {
    const key = Memory.key(candidate.key);
    const kind = candidate.kind || 'other';

    // Rule 1 — a withdrawal. Where it goes is wherever the thing already is,
    // which is the one case where the layer is a fact about the store rather
    // than a judgement about the value.
    if (candidate.op === 'clear') {
      const site = this._find(key);
      if (!site) {
        return {
          rule: ruleBy(1), layer: null, accepted: false,
          reason: `nothing is stored under "${key || candidate.key}"`,
        };
      }
      return { rule: ruleBy(1), layer: site.layer, compartment: site.compartment, op: 'clear', accepted: true, key };
    }

    // Rule 2 — the one that keeps the layers from filling up with the
    // dialogue. Most of what is said is worth remembering for two turns, and
    // short-term memory already has it; storing it again is not redundancy, it
    // is a second copy that outlives the first one's correct deletion.
    if (!key) {
      return {
        rule: ruleBy(2), layer: null, accepted: false,
        reason: `"${candidate.key}" does not name what the value is about`,
      };
    }
    /* The content test runs on every kind, not only on `other`. A model that
     * labels "sounds good" a decision has not made it one, and a layer that
     * accepted it because of the label would be storing the label. */
    if (!carriesContent(candidate.value)) {
      return {
        rule: ruleBy(2), layer: null, accepted: false,
        reason: 'carries nothing the window does not already hold',
      };
    }

    /* Rule 3 — the person.
     *
     * A profile key is only a profile key when the candidate is not obviously
     * about the work. "name" is the ambiguous one: a model that proposes
     * key "name" for the thing being built would otherwise rewrite who the
     * user is, and a profile that can be overwritten by an artifact is worse
     * than no profile. The task-shaped kinds win the tie. */
    const alias = PROFILE_ALIASES[key] || null;
    const taskShaped = ['goal', 'constraint', 'open_question', 'decision', 'agreement', 'artifact']
      .includes(kind);
    const field = kind === 'profile' ? (alias || null) : (taskShaped ? null : alias);
    if (field) {
      return {
        rule: ruleBy(3), layer: 'long', compartment: 'profile',
        key: field || key, accepted: true,
      };
    }
    /* A candidate that claims to be about the person but names a field the
     * profile does not have is not thrown away — it is knowledge about them,
     * which is the compartment with free keys. Refusing it outright would make
     * the typed profile a reason to lose facts, and the profile is typed to
     * stop it sprawling, not to police what may be remembered. */
    if (kind === 'profile') {
      return {
        rule: ruleBy(4), layer: 'long', compartment: 'knowledge', key, accepted: true,
        note: `the profile has no "${key}" field, so it is knowledge about them instead`,
      };
    }

    // Rule 4 — true regardless of the work. An identifier is only knowledge
    // when there is no task for it to be an artifact of; once a task is open,
    // the paths and hostnames being named are the task's, and they stop
    // meaning anything when it ends.
    if (kind === 'knowledge' || (kind === 'identifier' && !this._memory.working.task.goal)) {
      return { rule: ruleBy(4), layer: 'long', compartment: 'knowledge', key, accepted: true };
    }

    // Rule 5 — the shape of the work.
    if (['goal', 'constraint', 'open_question', 'artifact', 'identifier'].includes(kind)) {
      return { rule: ruleBy(5), layer: 'working', kind: WORKING_KIND[kind], key, accepted: true };
    }

    // Rule 6 — settled, for now. `promotable` is the whole of the argument:
    // it is not a lesser kind of long-term memory, it is a decision that has
    // not yet survived the thing it was made for.
    if (kind === 'decision' || kind === 'agreement') {
      return {
        rule: ruleBy(6), layer: 'working', kind: 'decision',
        key, promotable: true, accepted: true,
      };
    }

    // Rule 7.
    return { rule: ruleBy(7), layer: 'working', kind: 'artifact', key, accepted: true };
  }

  // Where is this key already? Working first: an open task's copy of a key is
  // the one being revised, and retracting the long-term one instead would
  // delete a standing fact to satisfy a sentence about this afternoon.
  _find(key) {
    if (!key) return null;
    if (this._memory.working.get(key)) return { layer: 'working' };
    for (const compartment of LongTerm.compartments) {
      if (this._memory.long.get(compartment, key)) return { layer: 'long', compartment };
    }
    return null;
  }

  /* Candidates in, decisions out. Still no writes. */
  plan(candidates = [], { turn = {}, source = null } = {}) {
    return (candidates || []).map((candidate) => {
      const check = gate(candidate, turn);
      if (!check.ok) {
        return {
          candidate,
          accepted: false,
          stage: 'gate',
          reason: check.reason,
          claimed: check.claimed || null,
          rule: null,
          layer: null,
          source,
        };
      }
      const decision = this.decide(candidate);
      return { candidate, stage: 'rule', source, ...decision };
    });
  }

  /* Decisions in, writes out.
   *
   * Every branch ends in a log entry, including the ones that wrote nothing.
   * A router whose log only contained its successes would be a router nobody
   * could catch being wrong.
   */
  commit(decisions = []) {
    return decisions.map((decision) => {
      const { candidate } = decision;
      const base = {
        key: decision.key || candidate.key,
        value: candidate.value,
        kind: candidate.kind,
        from: candidate.from,
        proposed: candidate.proposed,
        source: decision.source || null,
        rule: decision.rule,
        note: decision.note || null,
      };

      if (!decision.accepted) {
        return this._record({
          ...base,
          layer: null,
          outcome: decision.stage === 'gate' ? 'rejected' : 'dropped',
          reason: decision.reason,
          claimed: decision.claimed || null,
          agreed: null,
        });
      }

      const agreed = candidate.proposed ? candidate.proposed === decision.layer : null;

      if (decision.op === 'clear') {
        const done = decision.layer === 'working'
          ? this._memory.working.remove(decision.key)
          : this._memory.long.retract(decision.compartment, decision.key, { reason: 'withdrawn in conversation' });
        return this._record({
          ...base,
          layer: decision.layer,
          compartment: decision.compartment || null,
          outcome: done ? 'retracted' : 'dropped',
          reason: done ? null : 'it was already gone',
          agreed,
        });
      }

      if (decision.layer === 'long') {
        const result = this._memory.long.put({
          compartment: decision.compartment,
          key: decision.key,
          value: candidate.value,
          from: candidate.from,
          source: decision.source,
          rule: decision.rule.n,
          proposed: candidate.proposed,
        });
        return this._record({
          ...base,
          layer: 'long',
          compartment: decision.compartment,
          outcome: !result.written ? 'dropped'
            : result.confirmed ? 'confirmed'
              : result.revised ? 'revised' : 'written',
          reason: result.reason || null,
          previous: result.previous ? result.previous.value : null,
          agreed,
        });
      }

      const result = this._memory.working.put({
        key: decision.key,
        value: candidate.value,
        kind: decision.kind,
        from: candidate.from,
        source: decision.source,
        rule: decision.rule.n,
        proposed: candidate.proposed,
        promotable: Boolean(decision.promotable),
      });
      return this._record({
        ...base,
        layer: 'working',
        workingKind: decision.kind,
        promotable: Boolean(decision.promotable),
        outcome: !result.written ? 'dropped' : result.revised ? 'revised' : 'written',
        reason: result.reason || null,
        previous: result.previous ? result.previous.value : null,
        agreed,
      });
    });
  }

  handle(candidates = [], context = {}) {
    return this.commit(this.plan(candidates, context));
  }

  /* A person moved something.
   *
   * Rule 0, and the log says `manual` rather than naming a rule, because a log
   * that let a rule take credit for a human's correction would be the one part
   * of this app that lies. The item keeps its provenance: it is the same
   * quoted span from the same message, filed somewhere else.
   */
  manual({ item, to, compartment = 'knowledge', kind = 'artifact' } = {}) {
    if (!item || !to) return null;
    const from = item.compartment ? 'long' : 'working';
    if (from === 'working') this._memory.working.remove(item.key);
    else this._memory.long.retract(item.compartment, item.key, { reason: 'moved by hand' });

    let outcome = 'moved';
    if (to === 'long') {
      const result = this._memory.long.put({
        compartment, key: item.key, value: item.value, from: item.from,
        source: item.source, rule: 0, proposed: null,
      });
      if (!result.written) outcome = 'dropped';
    } else if (to === 'working') {
      const result = this._memory.working.put({
        key: item.key, value: item.value, kind, from: item.from,
        source: item.source, rule: 0, promotable: kind === 'decision',
      });
      if (!result.written) outcome = 'dropped';
    } else {
      // to === 'short' means forget it: short-term memory is the transcript,
      // and there is nothing to put there. The item is simply gone, and the
      // log says who did it.
      outcome = 'forgotten';
    }

    return this._record({
      key: item.key,
      value: item.value,
      kind: item.kind || null,
      from: item.from,
      proposed: null,
      source: item.source || null,
      rule: MANUAL_RULE,
      layer: to === 'short' ? null : to,
      compartment: to === 'long' ? compartment : null,
      movedFrom: from,
      outcome,
      agreed: null,
    });
  }

  /* A task closed and something in it outlived the task.
   *
   * This is rule 6's other half, and it is deliberately not automatic. An
   * agent that promoted its own decisions would build a permanent record of
   * every provisional thing said on a Tuesday afternoon, which is how a
   * long-term store becomes a place nobody trusts and everybody works around.
   */
  promote(item, { taskId = null, goal = null } = {}) {
    const result = this._memory.long.put({
      compartment: 'decisions',
      key: item.key,
      value: item.value,
      from: item.from,
      source: item.source,
      rule: 0,
      promotedFrom: { taskId, goal },
    });
    return this._record({
      key: item.key,
      value: item.value,
      kind: item.kind || 'decision',
      from: item.from,
      proposed: null,
      source: item.source || null,
      rule: PROMOTION_RULE,
      layer: 'long',
      compartment: 'decisions',
      outcome: result.written ? (result.revised ? 'revised' : 'promoted') : 'dropped',
      reason: result.reason || null,
      promotedFrom: goal,
      agreed: null,
    });
  }
}
