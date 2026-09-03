"""The four reasoning methods, and the panel of three that is one of them.

    direct   the problem, nothing else
    steps    the problem, plus "solve this step by step"
    meta     ask for a prompt first, then answer with the prompt you were given
    experts  three personas answer independently, a chair reads all three

None of these prompts asks for a particular answer format. That is on purpose:
a "state your answer on the last line" instruction would make grading trivial,
but `direct` is supposed to be the request with *no* additional instructions,
and a formatting rule added to all four to keep them comparable is still an
instruction that was not there before. The extractor in grading.py exists so
these prompts can stay as bare as the task describes.

## Why the personas are stances, not job titles

A panel of "mathematician, physicist, economist" cannot be pointed at a river
crossing puzzle. A panel defined by *how it approaches a problem* can be
pointed at anything, and -- more importantly -- stays fixed across all four
problems, so a difference between rows is a difference between methods rather
than between panels I tuned per problem.

The three run independently, on the problem alone. The critic's scepticism is a
stance it is given, not information it has that the others lack; letting it
read the other two first would sharpen its critique but make its row
incomparable to theirs, since it would be answering a strictly easier question.
Cross-reading is the chair's job.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from deepseek_client import DEFAULT_MODEL, complete

STEP_INSTRUCTION = "Solve this step by step."

META_REQUEST = (
    "Below is a problem. Do not solve it.\n"
    "Write the prompt that would give an AI the best possible chance of "
    "solving it correctly.\n"
    "Output the prompt text only, with no preamble and no commentary.\n\n"
    "Problem:\n{statement}"
)

PANEL = {
    "analyst": (
        "You are the Analyst on a three-person panel.\n"
        "Your stance: understand the problem exactly as written before "
        "solving it.\n"
        "Restate what is being asked, and list every condition the statement "
        "gives, quoting the wording rather than paraphrasing it. Note where "
        "the statement differs from how problems of this shape usually go, and "
        "note what it does not say. Then give your answer."
    ),
    "engineer": (
        "You are the Engineer on a three-person panel.\n"
        "Your stance: construct the answer mechanically rather than "
        "recognising it.\n"
        "Enumerate the cases, simulate the process move by move, or compute "
        "term by term. Show the construction. Do not rely on recalling a "
        "similar problem. Then give your answer."
    ),
    "critic": (
        "You are the Critic on a three-person panel.\n"
        "Your stance: assume the obvious answer is wrong.\n"
        "Identify what this problem resembles and exactly how it differs, name "
        "the mistake most people would make on it, then solve it while "
        "avoiding that mistake. If you check carefully and find no trap, say "
        "so plainly -- do not invent one. Then give your answer."
    ),
}

CHAIR = (
    "You are the Chair of a three-person panel.\n"
    "Three experts have answered the problem independently; their answers are "
    "below.\n"
    "Where they agree, check the agreement is not a shared mistake. Where they "
    "disagree, decide which reasoning holds up and say why. Then state the "
    "panel's final answer."
)

@dataclass
class Run:
    """One graded row: the response, what it cost, and how it was asked."""

    method: str                     # row label, e.g. "experts:critic"
    text: str                       # the response the answer is extracted from
    tokens: int
    calls: int
    elapsed: float
    messages: list = field(default_factory=list)   # what was sent
    note: str = ""                  # generated prompt, panel answers, ...
    extracted: str = ""             # filled in by grading
    correct: bool | None = None     # filled in by grading

class Session:
    """Runs the calls for one problem, telling `display` what is happening.

    `display` is how the streaming and the parallel modes differ: one prints
    chunks as they arrive, the other prints a progress line when a call is
    done. Nothing in the methods below knows which is in use.
    """

    def __init__(self, model=DEFAULT_MODEL, display=None):
        self.model = model
        self.display = display

    def call(self, label, messages, **params):
        self.display.call_start(label, messages)
        reply = complete(messages, self.model,
                         on_chunk=self.display.chunk, **params)
        self.display.call_end(label, reply)
        return reply

def _user(statement):
    return [{"role": "user", "content": statement}]

def _system(system, statement):
    return [{"role": "system", "content": system},
            {"role": "user", "content": statement}]

def direct(problem, session):
    """The problem as it stands. No system prompt, no added instruction."""
    messages = _user(problem.statement)
    reply = session.call("direct", messages)
    return [Run("direct", reply.text, reply.completion_tokens, 1,
                reply.elapsed, messages)]

def steps(problem, session):
    """The same request with four words appended to it."""
    messages = _user(f"{problem.statement}\n\n{STEP_INSTRUCTION}")
    reply = session.call("steps", messages)
    return [Run("steps", reply.text, reply.completion_tokens, 1,
                reply.elapsed, messages)]

def meta(problem, session):
    """Ask for a prompt, then answer the problem under the prompt you got.

    Two calls, and the first one's output is the interesting artefact -- what
    the model thinks it needs to be told is a more revealing answer than the
    solution it then produces.
    """
    ask_for_prompt = _user(META_REQUEST.format(statement=problem.statement))
    written = session.call("meta:prompt", ask_for_prompt)
    generated = written.text.strip()

    messages = _system(generated, problem.statement)
    reply = session.call("meta:solve", messages)

    return [Run(
        "meta", reply.text,
        written.completion_tokens + reply.completion_tokens, 2,
        written.elapsed + reply.elapsed, messages,
        note=generated,
    )]

def experts(problem, session):
    """Three independent answers, then a chair that reads all three.

    The chair's row carries the panel's whole cost -- four calls and every
    token -- because a chair with nothing to chair is not a method. Billing it
    for its own summary alone would make the most expensive method on the table
    look like the cheapest.
    """
    def one(name):
        messages = _system(PANEL[name], problem.statement)
        reply = session.call(f"experts:{name}", messages)
        return Run(f"experts:{name}", reply.text, reply.completion_tokens, 1,
                   reply.elapsed, messages)

    if session.display.parallel:
        with ThreadPoolExecutor(max_workers=len(PANEL)) as pool:
            panel = list(pool.map(one, PANEL))
    else:
        panel = [one(name) for name in PANEL]

    transcript = "\n\n".join(
        f"--- {run.method.split(':')[1].upper()} ---\n{run.text}"
        for run in panel
    )
    messages = _system(CHAIR, f"{problem.statement}\n\n{transcript}")
    reply = session.call("experts:chair", messages)

    chair = Run(
        "experts:chair", reply.text,
        sum(run.tokens for run in panel) + reply.completion_tokens,
        len(panel) + 1,
        sum(run.elapsed for run in panel) + reply.elapsed,
        messages,
        note=transcript,
    )
    return panel + [chair]

METHODS = {
    "direct": (direct, "no additional instructions"),
    "steps": (steps, f'+ "{STEP_INSTRUCTION}"'),
    "meta": (meta, "the model writes its own prompt, then answers under it"),
    "experts": (experts, "analyst, engineer and critic, then a chair"),
}

# The order rows appear in every table, whichever methods were selected.
ROW_ORDER = ["direct", "steps", "meta",
             "experts:analyst", "experts:engineer", "experts:critic",
             "experts:chair"]

def rows_for(names):
    """The row labels the chosen methods will produce, in table order."""
    produced = set()
    for name in names:
        produced.update([name] if name != "experts" else
                        [f"experts:{p}" for p in PANEL] + ["experts:chair"])
    return [row for row in ROW_ORDER if row in produced]
