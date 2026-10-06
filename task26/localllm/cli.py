"""`llm` — talk to a local model served by Ollama.

    llm status                      server, pulled and loaded models
    llm ask "question" [--think]    one request, streamed to the terminal
    llm chat                        interactive multi-turn chat
    llm run [prompts.json]          the graded prompts, saved to results/
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

from localllm import ollama

DEFAULT_MODEL = "qwen3:8b"
ROOT = Path(__file__).resolve().parent.parent

DIM, GREY, BOLD, RESET = "\033[2m", "\033[90m", "\033[1m", "\033[0m"


def main() -> None:
    p = argparse.ArgumentParser(prog="llm", description="Talk to a local LLM served by Ollama.")
    p.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"model name (default {DEFAULT_MODEL})")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="show the server, pulled and loaded models")

    a = sub.add_parser("ask", help="send one prompt")
    a.add_argument("prompt", nargs="+")
    a.add_argument("--think", action="store_true", help="let the model reason before answering")
    a.add_argument("-s", "--system", help="system prompt")

    c = sub.add_parser("chat", help="interactive chat (empty line or Ctrl-D to quit)")
    c.add_argument("--think", action="store_true")
    c.add_argument("-s", "--system", help="system prompt")

    r = sub.add_parser("run", help="run the graded prompts and save the results")
    r.add_argument("file", nargs="?", default=str(ROOT / "prompts.json"))
    r.add_argument("-o", "--out", default=str(ROOT / "results"))

    args = p.parse_args()
    try:
        {"status": status, "ask": ask, "chat": chat, "run": run}[args.cmd](args)
    except requests.ConnectionError:
        sys.exit(f"Cannot reach Ollama at {ollama.HOST}. Start it with `ollama serve` (or open the app).")
    except RuntimeError as e:
        sys.exit(str(e))
    except KeyboardInterrupt:
        print()


def status(args) -> None:
    print(f"Ollama {ollama.version()} at {ollama.HOST}")
    print(f"\n{BOLD}Pulled models{RESET}")
    for m in ollama.models():
        d = m.get("details", {})
        print(f"  {m['name']:<28} {m['size'] / 1e9:5.1f} GB  {d.get('parameter_size', ''):>6}  {d.get('quantization_level', '')}")
    loaded = ollama.running()
    print(f"\n{BOLD}Loaded in memory{RESET}")
    if not loaded:
        print("  (none — a model loads on its first request)")
    for m in loaded:
        vram = m.get("size_vram", 0)
        where = "GPU" if vram >= m["size"] else f"{vram / m['size']:.0%} GPU"
        print(f"  {m['name']:<28} {m['size'] / 1e9:5.1f} GB  {where}  until {m['expires_at'][11:19]}")


def ask(args) -> None:
    messages = _system(args.system) + [{"role": "user", "content": " ".join(args.prompt)}]
    reply = ollama.chat(args.model, messages, think=args.think, on_token=_printer())
    print()
    _stats(reply)


def chat(args) -> None:
    messages = _system(args.system)
    print(f"{GREY}{args.model} — empty line or Ctrl-D to quit{RESET}")
    while True:
        try:
            text = input(f"\n{BOLD}you>{RESET} ").strip()
        except EOFError:
            print()
            return
        if not text:
            return
        messages.append({"role": "user", "content": text})
        print(f"{BOLD}llm>{RESET} ", end="")
        reply = ollama.chat(args.model, messages, think=args.think, on_token=_printer())
        print()
        _stats(reply)
        messages.append({"role": "assistant", "content": reply.content})


def run(args) -> None:
    prompts = json.loads(Path(args.file).read_text())
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for i, item in enumerate(prompts, 1):
        print(f"\n{GREY}── [{i}/{len(prompts)}] {item['level']} · think={item.get('think', False)} ──{RESET}")
        print(f"{BOLD}Q: {item['prompt']}{RESET}\n")
        started = time.perf_counter()
        reply = ollama.chat(
            args.model,
            [{"role": "user", "content": item["prompt"]}],
            think=item.get("think", False),
            on_token=_printer(labels=True),
        )
        wall = time.perf_counter() - started
        print()
        _stats(reply)
        results.append({
            **item,
            "model": reply.model,
            "answer": reply.content,
            "thinking": reply.thinking,
            "wall_s": round(wall, 2),
            "load_s": round(reply.load_s, 2),
            "prompt_tokens": reply.prompt_tokens,
            "output_tokens": reply.output_tokens,
            "tokens_per_s": round(reply.tokens_per_s, 1),
        })

    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    path = out_dir / f"run-{stamp}.json"
    path.write_text(json.dumps({"model": args.model, "host": ollama.HOST, "results": results}, indent=2, ensure_ascii=False))
    print(f"\n{BOLD}{'level':<9} {'question':<52} {'in':>5} {'out':>6} {'tok/s':>6} {'wall':>7}{RESET}")
    for r in results:
        print(f"{r['level']:<9} {_short(r['prompt'], 50):<52} {r['prompt_tokens']:>5} {r['output_tokens']:>6} {r['tokens_per_s']:>6} {r['wall_s']:>6}s")
    print(f"\nSaved {path.relative_to(Path.cwd()) if path.is_relative_to(Path.cwd()) else path}")


def _short(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def _system(text: str | None) -> list[dict]:
    return [{"role": "system", "content": text}] if text else []


def _printer(labels: bool = False):
    """Print streamed tokens: thinking dimmed, then the answer, optionally under "Thinking:" / "A:" labels."""
    state = {"kind": None}

    def on_token(kind: str, text: str) -> None:
        if kind != state["kind"]:
            if state["kind"] == "thinking":
                print(f"{RESET}\n")
            if labels:
                print(f"{BOLD}{'Thinking:' if kind == 'thinking' else 'A:'}{RESET} ", end="")
            if kind == "thinking":
                print(f"{DIM}", end="")
            state["kind"] = kind
        print(text, end="", flush=True)

    return on_token


def _stats(r: ollama.Reply) -> None:
    load = f" · load {r.load_s:.1f}s" if r.load_s > 0.5 else ""
    print(
        f"{RESET}{GREY}[{r.model} · {r.prompt_tokens} in / {r.output_tokens} out · "
        f"{r.tokens_per_s:.1f} tok/s · {r.total_s:.1f}s{load}]{RESET}"
    )


if __name__ == "__main__":
    main()
