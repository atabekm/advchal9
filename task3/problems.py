"""The problems, and the code that knows their answers.

Every ground truth here is *computed* -- by breadth-first search, by
enumeration, by brute force over the candidate worlds. None is typed in by
hand, because a hand-typed answer is exactly as fallible as the model being
graded, and silently so. Writing the trap problem, the author's own first
answer was wrong.

Four problems, chosen so the comparison has somewhere to go:

  trap   the answer a model recalls differs from the answer the statement asks
         for -- one word of the classic puzzle has been changed
  count  no trap, just several steps that each have to survive
  logic  no recall value at all; the solution has to be searched for
  easy   a control. Every method should get this. If one does not, the harness
         is broken, not the method.

The control is the load-bearing one. Without it, four methods all scoring 4/4
reads as a null result; with it, "indistinguishable on `easy`, three points
apart on `trap`" is a finding.
"""

from dataclasses import dataclass, field
from itertools import combinations, permutations
from collections import deque

@dataclass
class Problem:
    """A question, its computed answer, and how the answer was arrived at."""

    name: str
    statement: str
    answer: str | None                  # None when nothing can grade it
    source: str = ""                    # how the answer was computed
    note: str = ""                      # what the problem is here to test

    @property
    def graded(self):
        return self.answer is not None

# --- trap: the classic river crossing, with the boat's capacity changed ------

TRAP_STATEMENT = (
    "A farmer needs to move a wolf, a goat and a cabbage across a river.\n"
    "The boat carries the farmer and up to TWO of the three items at a time.\n"
    "If the farmer is not present, the wolf eats the goat, and the goat eats "
    "the cabbage.\n"
    "What is the minimum number of river crossings needed to move all three "
    "across?"
)

def river_crossings(capacity):
    """Minimum crossings, by breadth-first search over (left bank, farmer side).

    Capacity 1 is the famous puzzle and returns 7. Capacity 2 is the problem
    posed above, and the whole point of it is that the two answers differ.
    """
    items = frozenset({"wolf", "goat", "cabbage"})
    forbidden = [{"wolf", "goat"}, {"goat", "cabbage"}]

    def safe(unattended):
        return not any(pair <= unattended for pair in forbidden)

    start, goal = (items, "left"), (frozenset(), "right")
    seen, queue = {start}, deque([(start, 0)])

    while queue:
        (left, side), crossings = queue.popleft()
        if (left, side) == goal:
            return crossings

        aboard_from = left if side == "left" else items - left
        for size in range(capacity + 1):
            for cargo in combinations(sorted(aboard_from), size):
                cargo = frozenset(cargo)
                next_left = left - cargo if side == "left" else left | cargo
                next_side = "right" if side == "left" else "left"
                stranded = items - next_left if next_side == "left" else next_left
                if not safe(set(stranded)):
                    continue
                state = (next_left, next_side)
                if state not in seen:
                    seen.add(state)
                    queue.append((state, crossings + 1))
    return None

# --- count: inclusion-exclusion, with a correction term that gets dropped ----

COUNT_STATEMENT = (
    "How many integers from 1 to 10000 inclusive are divisible by 3 or by 5, "
    "but not by 7?"
)

def divisible_count():
    """Ground truth by enumeration -- the arithmetic is what is being tested."""
    return sum(1 for n in range(1, 10001)
               if (n % 3 == 0 or n % 5 == 0) and n % 7 != 0)

# --- logic: a constraint puzzle with a unique solution -----------------------

LOGIC_STATEMENT = (
    "Ana, Ben, Cleo and Dov sit in a row of four seats, numbered 1 to 4 from "
    "left to right.\n"
    "Each ordered a different drink: tea, coffee, juice or water.\n"
    "1. The person in seat 1 ordered juice.\n"
    "2. Ana sits immediately to the left of the person who ordered coffee.\n"
    "3. Ben does not sit in seat 1 or seat 4.\n"
    "4. Cleo ordered neither tea nor coffee.\n"
    "5. Dov sits somewhere to the right of Ben.\n"
    "6. The person in seat 4 ordered water.\n"
    "7. Ana sits somewhere to the left of Cleo.\n"
    "What did Dov order?"
)

PEOPLE = ("Ana", "Ben", "Cleo", "Dov")
DRINKS = ("tea", "coffee", "juice", "water")

def seating_puzzle():
    """Brute force all 576 worlds; assert the constraints admit exactly one."""
    solutions = []
    for order in permutations(PEOPLE):
        seat = {person: i + 1 for i, person in enumerate(order)}
        for pour in permutations(DRINKS):
            drink = {order[i]: pour[i] for i in range(4)}
            coffee_seat = seat[next(p for p in PEOPLE if drink[p] == "coffee")]
            if (pour[0] == "juice"                       # 1
                    and seat["Ana"] + 1 == coffee_seat   # 2
                    and seat["Ben"] not in (1, 4)        # 3
                    and drink["Cleo"] not in ("tea", "coffee")   # 4
                    and seat["Dov"] > seat["Ben"]        # 5
                    and pour[3] == "water"               # 6
                    and seat["Ana"] < seat["Cleo"]):     # 7
                solutions.append(drink)

    if len(solutions) != 1:
        raise AssertionError(
            f"the puzzle admits {len(solutions)} solutions, not 1 -- "
            "the constraints in LOGIC_STATEMENT and here have drifted apart"
        )
    return solutions[0]["Dov"]

# --- easy: the control -------------------------------------------------------

EASY_STATEMENT = "How many trailing zeros does 25! (25 factorial) end with?"

def trailing_zeros(n=25):
    """Legendre's formula: count the factors of 5, since 2s are never scarce."""
    zeros, power = 0, 5
    while power <= n:
        zeros += n // power
        power *= 5
    return zeros

# -----------------------------------------------------------------------------

def catalog():
    """Build the problem set, computing every answer at call time."""
    return {
        "trap": Problem(
            name="trap",
            statement=TRAP_STATEMENT,
            answer=str(river_crossings(capacity=2)),
            source=f"breadth-first search; the capacity-1 classic needs "
                   f"{river_crossings(capacity=1)}",
            note="one word of a famous puzzle changed -- recall and reading disagree",
        ),
        "count": Problem(
            name="count",
            statement=COUNT_STATEMENT,
            answer=str(divisible_count()),
            source="enumeration over 1..10000",
            note="no trap, several steps; the 'not by 7' correction is what slips",
        ),
        "logic": Problem(
            name="logic",
            statement=LOGIC_STATEMENT,
            answer=seating_puzzle(),
            source="brute force over all 576 seat/drink assignments, unique",
            note="nothing to recall; the solution has to be searched for",
        ),
        "easy": Problem(
            name="easy",
            statement=EASY_STATEMENT,
            answer=str(trailing_zeros(25)),
            source="Legendre's formula, floor(25/5) + floor(25/25)",
            note="control -- every method should get this one",
        ),
    }

def resolve(name=None, prompt=None, expected=None):
    """Return the problems to run: a named one, all of them, or your own."""
    problems = catalog()
    if prompt:
        return [Problem(
            name="custom",
            statement=prompt,
            answer=str(expected) if expected is not None else None,
            source="--expected" if expected is not None else "",
            note="" if expected is not None else "no ground truth: answers "
                 "are reported and compared, not graded",
        )]
    if name == "all":
        return list(problems.values())
    return [problems[name]]
