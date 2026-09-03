"""Deciding whether an answer is right, without letting a model decide it.

The split here is deliberate and it is the only thing keeping the score
honest:

    model   reads prose and reports what answer it stated
    python  compares that value to the ground truth

Handing a model both the response and the true answer and asking "is this
correct?" invites it to rationalise a match -- to accept a response that
mentions 3 in passing and concludes 7. So the extractor never sees the ground
truth and is never asked to judge. It is also told not to solve the problem,
because an extractor that solves will happily report the answer the response
*should* have given.

An earlier draft pulled the answer out with a regex. That was worse, and not
for the obvious reason: the heuristics ("last number in the text") misfire more
often on long responses than short ones, and the expert panel writes the long
ones. A grader whose error rate tracks response length manufactures exactly the
method difference this task is trying to measure.
"""

import re

from deepseek_client import DEFAULT_MODEL, ask_full

EXTRACTOR_SYSTEM = (
    "You extract the final answer from someone else's response.\n"
    "You are given a question and a response to that question. Report only the "
    "final answer the response settled on.\n"
    "Output the value alone: digits for a number, a single word or short "
    "phrase otherwise. No units, no punctuation, no explanation.\n"
    "If the response never reaches a final answer, output NONE.\n"
    "Never solve the question yourself. Report only what the response "
    "concluded, even if you believe it is wrong."
)

NO_ANSWER = "NONE"

WORD_NUMBERS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
    "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13",
    "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
    "eighteen": "18", "nineteen": "19", "twenty": "20",
}

def extract(question, response, model=DEFAULT_MODEL):
    """Ask the model what answer a response gave. Returns the raw string."""
    if not response.strip():
        return NO_ANSWER

    reply = ask_full(
        [
            {"role": "system", "content": EXTRACTOR_SYSTEM},
            {"role": "user", "content": f"Question:\n{question}\n\n"
                                        f"Response:\n{response}"},
        ],
        model,
        temperature=0,      # the extraction should not vary between runs
        max_tokens=32,
    )
    return reply.text.strip() or NO_ANSWER

def normalise(value):
    """Canonical form for comparison: lowercase, unpunctuated, digits."""
    if value is None:
        return ""
    text = value.strip().lower().strip("`*\"'")
    text = text.rstrip(".!").strip()
    text = re.sub(r"(?<=\d),(?=\d)", "", text)      # 4,001 -> 4001
    text = re.sub(r"\s+", " ", text)
    return WORD_NUMBERS.get(text, text)

def grade(extracted, expected):
    """True, False, or None when there is no ground truth to grade against."""
    if expected is None:
        return None
    if normalise(extracted) == NO_ANSWER.lower():
        return False
    return normalise(extracted) == normalise(expected)
