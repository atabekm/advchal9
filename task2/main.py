"""Ask DeepSeek a question, with as much control over the answer as you ask for.

    python main.py "Explain recursion"                   no controls (task1)
    python main.py --max-words 60 "Explain recursion"    only that one limit
    python main.py --compare --max-tokens 150 "Expl..."  with and without, tabulated
    python main.py                                       interactive chat

Pass no control flags and the request is exactly task1's. Every flag you do
pass is sent, and nothing else is.
"""

import argparse
import sys

from dotenv import load_dotenv

import controls as ctl
from deepseek_client import DEFAULT_MODEL, DeepSeekError, ask_stream

DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def style(text, code):
    """Wrap text in an ANSI code, unless output is piped to a file."""
    return f"{code}{text}{RESET}" if sys.stdout.isatty() else text


def build_messages(prompt, system, controls, history=()):
    """Prepend the control block to the system message, then the conversation."""
    system_prompt = controls.system_prompt(system)
    messages = [{"role": "system", "content": system_prompt}] if system_prompt else []
    messages.extend(history)
    if prompt:
        messages.append({"role": "user", "content": prompt})
    return messages


def rule(label, width=66):
    """A labelled horizontal rule, so every section lines up."""
    return f"{'─' * 6} {label} {'─' * max(1, width - len(label) - 8)}"


def report(reply):
    """One dim line summarising how the response was bounded."""
    return " | ".join([
        f"{reply.completion_tokens} tokens",
        f"{len(reply.text.split())} words",
        f"{len(reply.text)} chars",
        f"finish={reply.finish_reason}",
        f"{reply.elapsed:.1f}s",
    ])


def run(prompt, model, system, controls, history=()):
    """Stream one request, then print its metrics. Returns (text, printed_ok)."""
    messages = build_messages(prompt, system, controls, history)

    try:
        stream = ask_stream(messages, model, **controls.request_params())
        for chunk in stream:
            print(chunk, end="", flush=True)
        print(flush=True)   # flush so the stderr line lands after the answer
        print(style(report(stream.reply), DIM), file=sys.stderr)
        return stream.reply.text, True
    except DeepSeekError as exc:
        print(style(f"Error: {exc}", BOLD), file=sys.stderr)
        return None, False


def compare(prompt, model, system, controls):
    """Send the same prompt twice -- without limits, then with -- and tabulate."""
    runs = [("without", ctl.Controls()), ("with", controls)]
    rows = []

    for name, controls in runs:
        print(style("\n" + rule(name), BOLD))
        for line in controls.describe():
            print(style(f"  {line}", DIM))
        print()

        try:
            stream = ask_stream(
                build_messages(prompt, system, controls), model,
                **controls.request_params(),
            )
            for chunk in stream:
                print(chunk, end="", flush=True)
            print(flush=True)
        except DeepSeekError as exc:
            print(style(f"Error: {exc}", BOLD), file=sys.stderr)
            return 1

        rows.append((name, stream.reply))

    print(style("\n" + rule("comparison"), BOLD))
    header = f"  {'run':<8}{'tokens':>8}{'words':>8}{'chars':>8}{'finish':>10}"
    print(style(header, DIM))
    for name, reply in rows:
        print(f"  {name:<8}{reply.completion_tokens:>8}"
              f"{len(reply.text.split()):>8}{len(reply.text):>8}"
              f"{reply.finish_reason:>10}")

    if any(reply.truncated for _, reply in rows):
        print(style("\n  finish=length means max_tokens cut the answer off "
                    "mid-sentence: the API enforced what the instruction alone "
                    "could not.", DIM))
    return 0


def chat(model, system, controls):
    """Interactive loop that keeps conversation history between turns."""
    history = []

    print(style(f"DeepSeek chat ({model}). "
                "/exit quits, /reset clears, /controls shows the limits.", DIM))
    while True:
        try:
            prompt = input(style("You> ", BOLD)).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if not prompt:
            continue
        if prompt in ("/exit", "/quit"):
            return 0
        if prompt == "/reset":
            history = []
            print(style("History cleared.", DIM))
            continue
        if prompt == "/controls":
            for line in controls.describe():
                print(style(f"  {line}", DIM))
            continue

        print(style("AI > ", BOLD), end="", flush=True)
        text, ok = run(prompt, model, system, controls, history)
        if ok:
            history.append({"role": "user", "content": prompt})
            history.append({"role": "assistant", "content": text})


def main():
    parser = argparse.ArgumentParser(
        description="Ask DeepSeek a question, controlling the response format, "
                    "length and stop condition. With no prompt, starts a chat loop.",
    )
    parser.add_argument("prompt", nargs="*", help="the question to ask")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"model name (default: {DEFAULT_MODEL}; try deepseek-reasoner)",
    )
    parser.add_argument("--system", help="system prompt to steer the answer")

    group = parser.add_argument_group(
        "response controls",
        "Each flag is independent and only what you pass is sent. Pass none of "
        "them and the request is unconstrained.",
    )
    group.add_argument(
        "--compare", action="store_true",
        help="run the same prompt twice, without the controls and with them, "
             "then tabulate the difference (needs at least one control)",
    )
    group.add_argument(
        "--format", dest="fmt", choices=sorted(ctl.FORMATS),
        help="response format described to the model",
    )
    group.add_argument("--max-words", type=int, help="length limit, as an instruction")
    group.add_argument("--max-tokens", type=int, help="length limit, enforced by the API")
    group.add_argument(
        # A value is required rather than optional: with nargs="?" argparse
        # swallows the following positional, so `--stop "my question"` would
        # silently make the prompt the stop marker.
        "--stop", metavar="MARKER",
        help=f"stop condition, used as both an instruction and the API stop "
             f"sequence (e.g. --stop '{ctl.STOP_MARKER}')",
    )

    args = parser.parse_args()
    load_dotenv()

    controls = ctl.build(
        fmt=args.fmt, max_words=args.max_words,
        max_tokens=args.max_tokens, stop=args.stop,
    )

    if args.compare and not controls.active:
        # Inventing a default set here would just be a preset in disguise.
        parser.error(
            "--compare needs at least one control to compare against, e.g.\n"
            "  --compare --format bullets --max-words 60 --max-tokens 150 "
            f"--stop '{ctl.STOP_MARKER}'"
        )

    if not args.prompt:
        if args.compare:
            parser.error("--compare needs a prompt")
        return chat(args.model, args.system, controls)

    prompt = " ".join(args.prompt)
    if args.compare:
        return compare(prompt, args.model, args.system, controls)

    if controls.active:
        for line in controls.describe():
            print(style(f"  {line}", DIM), file=sys.stderr)
    _, ok = run(prompt, args.model, args.system, controls)
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
