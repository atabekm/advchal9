"""`fileassist`: give the assistant a goal about a project; it works on the files through filemcp.

    fileassist usages [SYMBOL]     where and how a function is used (default quote_price)
    fileassist update-docs         bring the docs in line with the last code change
    fileassist check [--fix]       check the project against RULES.md (and fix what it can)
    fileassist changelog           fill [Unreleased] in CHANGELOG.md from the commits since the last tag
    fileassist adr ["DECISION"]    write an ADR for a decision and add it to the index
    fileassist run "GOAL"          any goal, in words
    fileassist fixture DIR         build the fixture project ("parcel") into DIR to look at it
    fileassist eval                run the cases in cases.json and check the results by code
    fileassist serve               the web UI on http://127.0.0.1:8034

Without --root every run gets a fresh build of the fixture in workspace/<time>/parcel. Changes are
staged: the run prints the diff, and --apply writes it to the files.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from . import fixture, runs, scenarios
from .agent import MAX_STEPS, Agent, Event, Run
from .files_client import FilesClient
from .llm import DEFAULT_MODEL, LLMError, LocalLLM

COLOR = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if COLOR else text


def _args_short(args: dict) -> str:
    parts = []
    for k, v in args.items():
        s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else repr(v)
        parts.append(f"{k}={s if len(s) <= 60 else s[:57] + '…'}")
    return ", ".join(parts)


def print_event(e: Event) -> None:
    if e.kind == "call":
        first = e.result.splitlines()[0] if e.result else ""
        mark = _c("31", "✗") if e.result.startswith("error") else _c("32", "→")
        print(f"{e.step:>3} {_c('1', e.tool)}({_args_short(e.arguments)}) {mark} {first[:110]}", flush=True)
    elif e.kind == "text":
        print(_c("2", f"    · {e.text.strip()[:200]}"), flush=True)
    elif e.kind == "review":
        print(_c("35", "    ↺ finish → the diff goes back to the model for a review"), flush=True)
    elif e.kind == "stop":
        print(_c("33", f"    ! {e.text}"), flush=True)


def colored_diff(diff: str) -> str:
    if not COLOR:
        return diff
    out = []
    for line in diff.splitlines():
        if line.startswith(("+++", "---", "diff --git", "new file")):
            out.append(_c("1", line))
        elif line.startswith("@@"):
            out.append(_c("36", line))
        elif line.startswith("+"):
            out.append(_c("32", line))
        elif line.startswith("-"):
            out.append(_c("31", line))
        else:
            out.append(line)
    return "\n".join(out)


def resolve_root(root: str | None) -> Path:
    if root:
        path = Path(root).expanduser().resolve()
        if not path.is_dir():
            raise SystemExit(f"fileassist: no directory {root}")
        return path
    return fixture.build(runs.WORKSPACES / runs.stamp() / "parcel")


async def execute(goal: str, root: Path, model: str | None, steps: int, think: bool, apply: bool,
                  extra: str = "", scenario: str = "", quiet: bool = False,
                  read_only: bool = False) -> tuple[Run, Path]:
    llm = LocalLLM(model, think=think)
    async with FilesClient(root) as fs:
        agent = Agent(fs, llm, max_steps=steps, on_event=None if quiet else print_event, read_only=read_only)
        run = await agent.run(goal, extra)
        if apply and run.diff:
            await fs.apply()
    return run, runs.save(run, root, scenario)


def report(run: Run, out: Path, root: Path, apply: bool) -> None:
    print()
    print(_c("1", "Report"))
    print(run.report.strip() or "(no report)")
    print()
    if run.diff:
        print(_c("1", f"Changes ({len(run.changed)} files)"))
        print(colored_diff(run.diff.rstrip()))
        print()
    else:
        print(_c("2", "No file changes."))
    state = "applied to the files" if apply and run.diff else ("staged only; --apply writes them" if run.diff else "")
    print(_c("2", f"{run.model} · {run.steps} tool calls, {run.model_calls} model calls · {run.seconds:.0f}s · "
                  f"{run.stop_reason}" + (f" · changes {state}" if state else "")))
    print(_c("2", f"project: {root}"))
    print(_c("2", f"saved:   {out.relative_to(runs.TASK_DIR) if out.is_relative_to(runs.TASK_DIR) else out}"))


def add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--root", help="the project directory (default: a fresh build of the fixture)")
    p.add_argument("--model", default=None, help=f"Ollama model (default {DEFAULT_MODEL}, or FILEASSIST_MODEL)")
    p.add_argument("--steps", type=int, default=MAX_STEPS, help=f"tool-call budget (default {MAX_STEPS})")
    p.add_argument("--think", nargs="?", const=True, default=False, choices=[True, "low", "medium", "high"],
                   help="let the model reason before each step (slower); for gpt-oss a level, default low")
    p.add_argument("--apply", action="store_true", help="write the changes to the files")
    p.add_argument("--quiet", action="store_true", help="don't print the tool calls as they happen")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fileassist", description="A project file assistant.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="work on a goal described in words")
    p.add_argument("goal", nargs="+")
    add_common(p)
    p = sub.add_parser("usages", help="find where and how a function is used")
    p.add_argument("symbol", nargs="?", default=scenarios.DEFAULT_SYMBOL)
    add_common(p)
    p = sub.add_parser("update-docs", help="bring the docs in line with the last code change")
    add_common(p)
    p = sub.add_parser("check", help="check the project against RULES.md")
    p.add_argument("--fix", action="store_true", help="also fix what can be fixed")
    add_common(p)
    p = sub.add_parser("changelog", help="update CHANGELOG.md since the last release")
    add_common(p)
    p = sub.add_parser("adr", help="write an architecture decision record")
    p.add_argument("decision", nargs="*")
    add_common(p)
    p = sub.add_parser("fixture", help="build the fixture project into a directory")
    p.add_argument("dir")
    p = sub.add_parser("eval", help="run the eval cases and check the results")
    p.add_argument("--models", default=DEFAULT_MODEL, help="comma-separated Ollama models")
    p.add_argument("--cases", default="", help="comma-separated case ids (default all)")
    p.add_argument("--repeat", type=int, default=3, help="runs per case and model (default 3)")
    p.add_argument("--think", nargs="?", const=True, default=False, choices=[True, "low", "medium", "high"])
    p.add_argument("--steps", type=int, default=MAX_STEPS)
    p = sub.add_parser("serve", help="the web UI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8034)
    p.add_argument("--model", default=None, help=f"Ollama model (default {DEFAULT_MODEL})")
    p.add_argument("--think", nargs="?", const=True, default=False, choices=[True, "low", "medium", "high"])
    args = parser.parse_args(argv)

    if args.command == "serve":
        import uvicorn

        from .web import create_app
        app = create_app(lambda model: LocalLLM(model or args.model, think=args.think))
        print(f"fileassist on http://{args.host}:{args.port}  (model {args.model or DEFAULT_MODEL})")
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
        return 0

    if args.command == "eval":
        from . import evaluate
        out = evaluate.main([m.strip() for m in args.models.split(",") if m.strip()],
                            [c.strip() for c in args.cases.split(",") if c.strip()] or None,
                            args.repeat, args.think, args.steps)
        print(f"\nsaved {out.relative_to(runs.TASK_DIR)}")
        return 0

    if args.command == "fixture":
        try:
            path = fixture.build(args.dir)
        except fixture.FixtureError as e:
            print(f"fileassist: {e}", file=sys.stderr)
            return 1
        print(f"built {path} at {fixture.head(path)[:7]}")
        return 0

    if args.command == "run":
        goal, extra, name, read_only = " ".join(args.goal), "", "", False
    else:
        arg = {"usages": getattr(args, "symbol", None), "adr": " ".join(getattr(args, "decision", []) or [])}
        name = "check-fix" if args.command == "check" and args.fix else args.command
        sc = scenarios.by_name(name, arg.get(args.command) or None)
        goal, extra, name, read_only = sc.goal, sc.checklist, sc.name, not sc.changes_files
    root = resolve_root(args.root)
    print(_c("2", f"project {root}\ngoal    {goal}\n"))
    try:
        run, out = asyncio.run(execute(goal, root, args.model, args.steps, args.think, args.apply,
                                       extra=extra, scenario=name, quiet=args.quiet, read_only=read_only))
    except LLMError as e:
        print(f"fileassist: {e}", file=sys.stderr)
        return 1
    report(run, out, root, args.apply)
    return 0 if run.finished else 3


if __name__ == "__main__":
    sys.exit(main())
