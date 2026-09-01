#!/usr/bin/env python3
"""Ask DeepSeek a question from the terminal.

    python main.py "Explain recursion"   one-shot
    python main.py                       interactive chat
"""

import argparse
import sys

from dotenv import load_dotenv

from deepseek_client import DEFAULT_MODEL, DeepSeekError, ask, ask_stream

DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"


def style(text, code):
    """Wrap text in an ANSI code, unless output is piped to a file."""
    return f"{code}{text}{RESET}" if sys.stdout.isatty() else text


def respond(messages, model, stream, progress=False):
    """Print the assistant's reply and return it, or None if the call failed.

    `progress` shows a waiting hint, for when nothing else marks the pause.
    """
    try:
        if stream:
            parts = []
            for chunk in ask_stream(messages, model):
                print(chunk, end="", flush=True)
                parts.append(chunk)
            print()
            return "".join(parts)

        if progress:
            print(style(f"[{model}] thinking...", DIM), file=sys.stderr)
        reply = ask(messages, model)
        print(reply)
        return reply
    except DeepSeekError as exc:
        print(style(f"Error: {exc}", BOLD), file=sys.stderr)
        return None


def chat(model, system, stream):
    """Interactive loop that keeps conversation history between turns."""
    base = [{"role": "system", "content": system}] if system else []
    messages = list(base)

    print(style(f"DeepSeek chat ({model}). /exit to quit, /reset to clear.", DIM))
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
            messages = list(base)
            print(style("History cleared.", DIM))
            continue

        messages.append({"role": "user", "content": prompt})
        print(style("AI > ", BOLD), end="", flush=True)
        reply = respond(messages, model, stream)
        if reply is None:
            # Drop the unanswered turn so history stays consistent.
            messages.pop()
        else:
            messages.append({"role": "assistant", "content": reply})


def main():
    parser = argparse.ArgumentParser(
        description="Ask DeepSeek a question. With no prompt, starts a chat loop."
    )
    parser.add_argument("prompt", nargs="*", help="the question to ask")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"model name (default: {DEFAULT_MODEL}; try deepseek-reasoner)",
    )
    parser.add_argument("--system", help="system prompt to steer the answer")
    parser.add_argument(
        "--no-stream", dest="stream", action="store_false",
        help="wait for the full answer instead of printing it as it arrives",
    )
    args = parser.parse_args()

    load_dotenv()

    if not args.prompt:
        return chat(args.model, args.system, args.stream)

    messages = [{"role": "system", "content": args.system}] if args.system else []
    messages.append({"role": "user", "content": " ".join(args.prompt)})
    ok = respond(messages, args.model, args.stream, progress=True) is not None
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
