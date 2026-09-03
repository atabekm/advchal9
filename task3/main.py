"""Solve one problem four ways, and see which way was right.

    python main.py                          the problems, and how to run them
    python main.py --problem trap           four methods, one problem, streamed
    python main.py --problem all            all four problems, in parallel
    python main.py "Why is the sky blue?"   your own problem, ungraded
    python main.py "..." --expected 42      your own problem, graded

Four methods -- direct, step by step, a self-written prompt, and a panel of
experts -- produce seven graded rows, because each expert is graded on its own
as well as through the chair that reads them all.
"""

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

import grading
import methods as mt
import problems as pb
from deepseek_client import DEFAULT_MODEL, DeepSeekError

DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"

RUNS_DIR = Path(__file__).parent / "runs"

SUBHEADINGS = {
    "meta:prompt": "the prompt it wrote",
    "meta:solve": "answering under that prompt",
    "experts:analyst": "analyst",
    "experts:engineer": "engineer",
    "experts:critic": "critic",
    "experts:chair": "chair",
}

def style(text, code):
    """Wrap text in an ANSI code, unless output is piped to a file."""
    return f"{code}{text}{RESET}" if sys.stdout.isatty() else text

def rule(label, width=70):
    """A labelled horizontal rule, so every section lines up."""
    return f"{'─' * 6} {label} {'─' * max(1, width - len(label) - 8)}"

def show_messages(messages):
    """Print the exact messages a call sent, for --show-prompts."""
    for message in messages:
        print(style(f"  │ [{message['role']}]", DIM))
        for line in message["content"].splitlines():
            print(style(f"  │ {line}", DIM))

class Verbose:
    """Streams every call as it arrives. One problem at a time."""

    parallel = False

    def __init__(self, show_prompts=False):
        self.show_prompts = show_prompts

    def call_start(self, label, messages):
        if label in SUBHEADINGS:
            print(style(f"\n  ── {SUBHEADINGS[label]} ──", DIM))
        if self.show_prompts:
            show_messages(messages)
            print()

    def chunk(self, text):
        print(text, end="", flush=True)

    def call_end(self, label, reply):
        print(flush=True)
        print(style(f"  {reply.completion_tokens} tokens | {reply.elapsed:.1f}s",
                    DIM), file=sys.stderr)

class Quiet:
    """Buffers every call and prints a progress line when it lands."""

    parallel = True
    chunk = None            # None makes complete() buffer instead of stream
    lock = threading.Lock()

    def __init__(self, prefix="", show_prompts=False):
        self.prefix = prefix
        self.show_prompts = show_prompts

    def call_start(self, label, messages):
        if self.show_prompts:
            with Quiet.lock:
                print(style(f"  {self.prefix}{label}", DIM), file=sys.stderr)
                show_messages(messages)

    def call_end(self, label, reply):
        with Quiet.lock:
            print(style(f"  ✓ {self.prefix}{label:<18} "
                        f"{reply.completion_tokens:>5} tokens  "
                        f"{reply.elapsed:>5.1f}s", DIM), file=sys.stderr)

def solve(problem, method_names, model, display):
    """Run the chosen methods against one problem. Returns a list of Runs."""
    session = mt.Session(model, display)
    runs = []
    for index, name in enumerate(method_names, start=1):
        function, description = mt.METHODS[name]
        if not display.parallel:
            print(style("\n" + rule(f"{index}. {name}"), BOLD))
            print(style(f"  {description}", DIM))
        runs.extend(function(problem, session))
    return runs

def grade_all(runs, problem, model):
    """Extract every answer, then compare it in Python. Mutates the runs."""
    def one(run):
        run.extracted = grading.extract(problem.statement, run.text, model)
        run.correct = grading.grade(run.extracted, problem.answer)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(one, runs))

PANEL_NOTE = (
    "experts:chair bills the whole method -- the panel's three calls\n"
    "  plus its own. The other expert rows show only their own call."
)

def panel_note(rows):
    """The experts rows bill asymmetrically; say so rather than hide it."""
    if "experts:chair" in rows:
        print(style(f"\n  {PANEL_NOTE}", DIM))

def mark(correct):
    return {True: "✓", False: "✗", None: "–"}[correct]

def truncate(text, width):
    text = " ".join(text.split())
    return text if len(text) <= width else text[:width - 1] + "…"

def problem_table(problem, runs, rows, runs_per_method, note=True):
    """One problem's results, a row per method."""
    print(style("\n" + rule(f"comparison: {problem.name}"), BOLD))
    if problem.graded:
        print(style(f"  ground truth: {problem.answer}   ({problem.source})", DIM))
    else:
        print(style("  no ground truth -- answers are compared, not graded", DIM))

    print(style(f"  {'method':<18}{'answer':>12}{'ok':>6}"
                f"{'tokens':>9}{'calls':>7}{'time':>8}", DIM))

    for row in rows:
        group = [run for run in runs if run.method == row]
        answers = sorted({grading.normalise(run.extracted) for run in group})
        correct = sum(1 for run in group if run.correct)

        if runs_per_method == 1:
            verdict = mark(group[0].correct)
        elif problem.graded:
            verdict = f"{correct}/{runs_per_method}"
        else:
            verdict = "–"

        print(f"  {row:<18}{truncate('/'.join(answers), 12):>12}{verdict:>6}"
              f"{sum(r.tokens for r in group):>9}"
              f"{sum(r.calls for r in group):>7}"
              f"{sum(r.elapsed for r in group):>7.1f}s")

    if note:
        panel_note(rows)

    if not problem.graded:
        agreed = {grading.normalise(run.extracted) for run in runs}
        print(style(f"\n  {len(agreed)} distinct answer"
                    f"{'s' if len(agreed) != 1 else ''} across {len(runs)} row"
                    f"{'s' if len(runs) != 1 else ''}: "
                    f"{', '.join(sorted(agreed))}", DIM))

def summary_table(results, rows, runs_per_method):
    """The matrix: methods down the side, problems across the top."""
    names = [problem.name for problem, _ in results]
    graded = [problem for problem, _ in results if problem.graded]

    print(style("\n" + rule(f"summary: {len(results)} problems"), BOLD))
    header = f"  {'method':<18}" + "".join(f"{name:>8}" for name in names)
    print(style(header + f"{'score':>9}{'tokens':>9}", DIM))

    for row in rows:
        cells, correct, tokens = "", 0, 0
        for problem, runs in results:
            group = [run for run in runs if run.method == row]
            hits = sum(1 for run in group if run.correct)
            correct += hits
            tokens += sum(run.tokens for run in group)
            if not problem.graded:
                cells += f"{'–':>8}"
            elif runs_per_method == 1:
                cells += f"{mark(group[0].correct):>8}"
            else:
                cells += f"{f'{hits}/{runs_per_method}':>8}"

        total = len(graded) * runs_per_method
        score = f"{correct}/{total}" if total else "–"
        print(f"  {row:<18}{cells}{score:>9}{tokens:>9}")

    panel_note(rows)

def save(results, model, runs_per_method):
    """Write every response and extraction, so any score can be audited."""
    RUNS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RUNS_DIR / f"{stamp}.json"

    path.write_text(json.dumps({
        "model": model,
        "runs_per_method": runs_per_method,
        "problems": [
            {
                "name": problem.name,
                "statement": problem.statement,
                "ground_truth": problem.answer,
                "source": problem.source,
                "runs": [
                    {
                        "method": run.method,
                        "extracted": run.extracted,
                        "correct": run.correct,
                        "tokens": run.tokens,
                        "calls": run.calls,
                        "elapsed": round(run.elapsed, 2),
                        "messages": run.messages,
                        "response": run.text,
                        "note": run.note,
                    }
                    for run in runs
                ],
            }
            for problem, runs in results
        ],
    }, indent=2), encoding="utf-8")
    return path

def list_problems():
    """What bare `python main.py` prints."""
    print(style(rule("problems"), BOLD))
    for problem in pb.catalog().values():
        print(f"  {style(problem.name, BOLD):<14} answer {problem.answer:<6} "
              f"{style(problem.note, DIM)}")
    print(style("\n" + rule("usage"), BOLD))
    for line in [
        "python main.py --problem trap          four methods on one problem",
        "python main.py --problem all           every problem, in parallel",
        'python main.py "your question"         your own, ungraded',
        'python main.py "your question" --expected 42',
        "python main.py --problem trap --show-prompts",
        "python main.py --problem trap --method direct --method experts",
    ]:
        print(f"  {line}")
    print(style("\n  Answers are computed in problems.py, not typed in. "
                "Every run is saved to runs/.", DIM))
    return 0

def main():
    parser = argparse.ArgumentParser(
        description="Solve one problem four ways and compare the answers.",
    )
    parser.add_argument("prompt", nargs="*", help="your own problem to solve")
    parser.add_argument(
        "--problem", choices=sorted(pb.catalog()) + ["all"],
        help="a built-in problem with a computed answer, or 'all'",
    )
    parser.add_argument(
        "--expected", help="ground truth for your own problem, so it can be graded",
    )
    parser.add_argument(
        "--method", action="append", choices=sorted(mt.METHODS), dest="method_names",
        help="run only this method (repeatable; default: all four)",
    )
    parser.add_argument("--runs", type=int, default=1,
                        help="repeat every method N times (default: 1)")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"model name (default: {DEFAULT_MODEL}; note that "
                             "deepseek-reasoner reasons before answering "
                             "whatever it is asked, which collapses direct "
                             "into steps)")
    parser.add_argument("--show-prompts", action="store_true",
                        help="print the exact messages each method sends")
    parser.add_argument("--quiet", action="store_true",
                        help="skip the transcripts, print only the tables")

    args = parser.parse_args()
    load_dotenv()

    if args.expected and not args.prompt:
        parser.error("--expected is for your own problem; the built-in ones "
                     "compute their answers")
    if not args.prompt and not args.problem:
        return list_problems()
    if args.prompt and args.problem:
        parser.error("pass either a problem of your own or --problem, not both")
    if args.runs < 1:
        parser.error("--runs must be at least 1")

    prompt = " ".join(args.prompt)
    targets = pb.resolve(args.problem, prompt, args.expected)
    method_names = [name for name in mt.METHODS
                    if name in (args.method_names or mt.METHODS)]
    rows = mt.rows_for(method_names)

    # Streaming is readable for one problem and unreadable for four at once.
    streamed = len(targets) == 1 and args.runs == 1 and not args.quiet
    started = time.monotonic()

    try:
        if streamed:
            problem = targets[0]
            print(style(rule(f"problem: {problem.name}"), BOLD))
            for line in problem.statement.splitlines():
                print(f"  {line}")
            runs = solve(problem, method_names, args.model,
                         Verbose(args.show_prompts))
            grade_all(runs, problem, args.model)
            results = [(problem, runs)]
        else:
            units = [(problem, index)
                     for problem in targets for index in range(args.runs)]
            total_rows = len(units) * len(rows)
            print(style(rule(f"running {total_rows} row"
                             f"{'s' if total_rows != 1 else ''} across "
                             f"{len(targets)} problem"
                             f"{'s' if len(targets) != 1 else ''}"), BOLD),
                  file=sys.stderr)

            def unit(job):
                problem, index = job
                prefix = f"{problem.name} " if len(targets) > 1 else ""
                runs = solve(problem, method_names, args.model,
                             Quiet(prefix, args.show_prompts))
                grade_all(runs, problem, args.model)
                return problem, runs

            with ThreadPoolExecutor(max_workers=4) as pool:
                done = list(pool.map(unit, units))

            results = [(problem, [run for other, runs in done
                                  for run in runs if other is problem])
                       for problem in targets]
    except DeepSeekError as exc:
        print(style(f"Error: {exc}", BOLD), file=sys.stderr)
        return 1

    for problem, runs in results:
        # In a sweep the note belongs under the summary, printed once.
        problem_table(problem, runs, rows, args.runs, note=len(results) == 1)
    if len(results) > 1:
        summary_table(results, rows, args.runs)

    path = save(results, args.model, args.runs)
    print(style(f"\n  {time.monotonic() - started:.0f}s total | "
                f"saved to {path.parent.name}/{path.name}", DIM))
    return 0

if __name__ == "__main__":
    sys.exit(main())
