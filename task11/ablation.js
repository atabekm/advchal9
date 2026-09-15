/* The ablation.
 *
 * The brief's second question is "how does this affect the agent's answers?",
 * and there is exactly one way to answer it that is not an opinion: build the
 * memory once, then ask the same questions four times with different parts of
 * it switched off, and print what came back.
 *
 * The design has one deliberate property that makes it a measurement rather
 * than a demonstration. The setup runs once. All four probe runs are handed
 * the *same* memory — the same items, the same values, the same provenance —
 * and differ only in which layers are allowed into the request. So a
 * difference in the answers cannot be a difference in what was remembered. It
 * can only be a difference in what was sent.
 *
 * The probes are asked in a *new conversation*, with short-term memory empty.
 * That is not a handicap invented to make the other layers look good; it is
 * the situation the entire task is about. Coming back tomorrow is when the
 * difference between a dialogue, a task and a person stops being a diagram.
 *
 * Every run is live. There is no stub in this task, so these numbers cost
 * money and are not reproducible to the character — which is why the answers
 * are printed in full beside the verdicts instead of only a score.
 */

const ABLATION_KEY = 'task11.ablation';

// What the agent is told, in order. Seven turns, each of which is meant to put
// something somewhere: two for the person, three for the shape of the work, one
// revision, and one piece of small talk that should reach no layer at all.
const ABLATION_SCRIPT = [
  "Call me Atabek — I'm a backend engineer on the payments team.",
  "We're migrating the billing service to Postgres. That's the job for this month.",
  'Hard constraint: no downtime. The cutover has to be invisible to customers.',
  "Let's put the cutover on 4 March.",
  'Actually, make that 11 March — the 4th is a public holiday.',
  "We'll use Postgres 16, not 15.",
  'Great, thanks. Sounds good to me.',
];

const ABLATION_GOAL = 'migrate the billing service to Postgres';

/* The questions, and what a right answer has to contain.
 *
 * Grading by substring is crude and it is the only grading here that could be
 * checked by a reader who does not trust it. `forbid` is the half that matters
 * most: an agent that answers "4 March" has not forgotten the cutover, it has
 * remembered a superseded value, and those two failures deserve different
 * names.
 */
const ABLATION_PROBES = [
  {
    ask: 'What are you supposed to call me?',
    expect: ['Atabek'],
    layer: 'long',
    why: 'the name was said seven turns ago and is in the profile',
  },
  {
    ask: 'What do I do for a living?',
    expect: ['backend', 'engineer'],
    layer: 'long',
    why: 'same message, different field',
  },
  {
    ask: 'What are we working on?',
    expect: ['billing', 'postgres', 'migrat'],
    layer: 'working',
    why: 'the goal of the open task',
  },
  {
    ask: 'When is the cutover? Answer with just the date.',
    expect: ['11 march', '11th of march', '11.03', '11 марта'],
    forbid: ['4 march', '4th of march'],
    layer: 'working',
    why: 'a decision that was revised — only the current value should be there',
  },
  {
    ask: 'Which Postgres version did we settle on?',
    expect: ['16'],
    forbid: ['15'],
    layer: 'working',
    why: 'a decision made inside the task',
  },
];

// The four configurations. The names are what they are: this is not four
// strategies, it is one memory with parts of it unplugged.
const ABLATION_RUNS = [
  { id: 'all', name: 'everything', config: { useLong: true, useWorking: true, useShort: true } },
  { id: 'nolong', name: 'no long-term', config: { useLong: false, useWorking: true, useShort: true } },
  { id: 'noworking', name: 'no working', config: { useLong: true, useWorking: false, useShort: true } },
  { id: 'neither', name: 'the dialogue only', config: { useLong: false, useWorking: false, useShort: true } },
];

function gradeAnswer(answer, probe) {
  const text = String(answer || '').toLowerCase();
  const hit = probe.expect.some((needle) => text.includes(needle.toLowerCase()));
  const wrong = (probe.forbid || []).filter((needle) => text.includes(needle.toLowerCase()));
  if (wrong.length) return { verdict: 'stale', detail: `said "${wrong[0]}", which was superseded` };
  return hit ? { verdict: 'hit', detail: null } : { verdict: 'miss', detail: 'not in the answer' };
}

class Ablation {
  constructor({ transport = deepseekTransport, config = {} } = {}) {
    this._transport = transport;
    this._config = config;
  }

  static get script() { return ABLATION_SCRIPT.slice(); }
  static get probes() { return ABLATION_PROBES.map((probe) => ({ ...probe })); }
  static get runs() { return ABLATION_RUNS.map((run) => ({ ...run })); }

  static load() {
    try {
      const raw = localStorage.getItem(ABLATION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  static save(result) {
    try {
      localStorage.setItem(ABLATION_KEY, JSON.stringify(result));
    } catch (error) {
      /* a measurement is not worth failing over */
    }
  }

  static clear() {
    try { localStorage.removeItem(ABLATION_KEY); } catch (error) { /* already gone */ }
  }

  /* Build the memory once.
   *
   * Nothing here touches the running app's layers or its storage — a fresh
   * Memory, a fresh Agent, and everything discarded at the end except the
   * snapshot. An ablation that overwrote what the user had been building would
   * be a very expensive way to lose an afternoon.
   */
  async _setup(report, signal) {
    const memory = new Memory({ keepTurns: 3 });
    const agent = new Agent({
      transport: this._transport,
      memory,
      ...this._config,
      useLong: true,
      useWorking: true,
      useShort: true,
      extract: true,
      temperature: 0,
    });
    agent.openTask(ABLATION_GOAL);

    for (let i = 0; i < ABLATION_SCRIPT.length; i += 1) {
      report(`building the memory — turn ${i + 1} of ${ABLATION_SCRIPT.length}`);
      const turn = await agent.send(ABLATION_SCRIPT[i], { signal });
      await agent.remember(turn, { signal });
    }

    return {
      snapshot: memory.snapshot(),
      log: agent.router.log,
      stats: memory.stats(),
      cost: agent.stats.replyCost + agent.stats.extractionCost,
    };
  }

  /* Ask the probes under one configuration.
   *
   * Short-term is cleared before each probe as well as before the run. Two
   * probes in a row would otherwise mean the second one could be answered from
   * the first one's reply, and the column would be measuring the transcript
   * rather than the layer.
   */
  async _probe(run, setup, report, signal) {
    const memory = new Memory({ keepTurns: 3 });
    memory.restore(setup.snapshot);

    const agent = new Agent({
      transport: this._transport,
      memory,
      ...this._config,
      ...run.config,
      extract: false,
      temperature: 0,
    });

    const answers = [];
    for (let i = 0; i < ABLATION_PROBES.length; i += 1) {
      const probe = ABLATION_PROBES[i];
      report(`${run.name} — question ${i + 1} of ${ABLATION_PROBES.length}`);
      memory.short.clear();
      let text = '';
      let failed = null;
      try {
        const turn = await agent.send(probe.ask, { signal });
        text = turn.assistant;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        failed = error.message;
      }
      answers.push({
        ask: probe.ask,
        answer: text,
        failed,
        ...(failed ? { verdict: 'error', detail: failed } : gradeAnswer(text, probe)),
        tokens: agent.assemble(probe.ask).tokens,
      });
    }

    return {
      id: run.id,
      name: run.name,
      config: run.config,
      answers,
      score: answers.filter((answer) => answer.verdict === 'hit').length,
      cost: agent.stats.replyCost,
    };
  }

  async run({ report = () => {}, signal = null } = {}) {
    const started = Date.now();
    const setup = await this._setup(report, signal);
    const runs = [];
    for (const run of ABLATION_RUNS) {
      runs.push(await this._probe(run, setup, report, signal));
    }
    const result = {
      at: started,
      elapsed: (Date.now() - started) / 1000,
      model: this._config.model || Agent.defaults.model,
      setup: {
        stats: setup.stats,
        cost: setup.cost,
        stored: setup.log.filter((entry) => entry.layer).map((entry) => ({
          key: entry.key,
          value: entry.value,
          layer: entry.layer + (entry.compartment ? `.${entry.compartment}` : ''),
          rule: entry.rule ? entry.rule.n : null,
          proposed: entry.proposed,
          agreed: entry.agreed,
          // A revised key appears twice in the log and once in the block. Saying
          // which write replaced which is the difference between a list that
          // looks duplicated and one that shows a decision changing.
          previous: entry.previous || null,
        })),
        refused: setup.log.filter((entry) => !entry.layer).map((entry) => ({
          key: entry.key,
          value: entry.value,
          outcome: entry.outcome,
          reason: entry.reason,
        })),
      },
      runs,
      cost: setup.cost + runs.reduce((sum, run) => sum + (run.cost || 0), 0),
    };
    Ablation.save(result);
    return result;
  }
}
