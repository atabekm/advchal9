"""The interactive session: slash commands over the assistant and the MCP tools.

    /help QUESTION         ask about the project (docs + git state + tools); plain text does the same
    /help                  this list
    /branch                the current branch (MCP git_branch)
    /status                uncommitted changes (MCP git_status)
    /files [PATH] [DEPTH]  the files under PATH (MCP list_files)
    /diff [PATH] [--base B] [--stat]   uncommitted changes, or the branch since B (MCP git_diff)
    /log [N] [PATH]        recent commits (MCP git_log)
    /sources               the passages and tool calls behind the last answer
    /reindex               re-embed documentation that changed
    /quit                  leave (also Ctrl-D)
"""

from __future__ import annotations

import asyncio
import shlex
from collections.abc import Callable

from .assistant import Answer, Assistant
from .index import build
from .llm import LLMError
from .retrieve import Retriever

DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
RESET = "\033[0m"

COMMANDS = __doc__.split("\n\n", 1)[1].strip()


def render(a: Answer, color: bool = True) -> str:
    d, b, c, r = (DIM, BOLD, CYAN, RESET) if color else ("", "", "", "")
    out = [a.text, ""]
    if a.sources:
        out.append(f"{b}sources{r}")
        out += [f"  [{h.rank}] {h.label}" for h in a.sources]
    if a.listed or a.tool_calls:
        out.append(f"{b}looked at{r}")
        out += [f"  {c}list_files{r}({path!r})  {d}(path in the question){r}" for path in a.listed]
        for name, args, result in a.tool_calls:
            arg_text = ", ".join(f"{k}={v!r}" for k, v in args.items())
            first = result.splitlines()[0] if result else ""
            out.append(f"  {c}{name}{r}({arg_text})  {d}→ {first[:80]}{r}")
    branch = a.branch.splitlines()[0].removeprefix("branch: ") if a.branch else "?"
    scope = f" · scope {', '.join(sorted(a.scope))}" if a.scope else ""
    out.append(f"{d}branch {branch}{scope} · {a.rounds} model call{'s' if a.rounds != 1 else ''} · "
               f"{a.prompt_tokens}+{a.completion_tokens} tokens · {a.seconds:.1f}s{r}")
    return "\n".join(out)


def render_sources(a: Answer | None, color: bool = True) -> str:
    if a is None:
        return "no answer yet: ask something with /help"
    d, b, r = (DIM, BOLD, RESET) if color else ("", "", "")
    out = [f"{b}passages given to the model{r} (* = cited)"]
    for h in a.hits:
        mark = "*" if h.rank in a.cited else " "
        rr = f"rerank {h.rerank:.2f}" if h.rerank is not None else ""
        out.append(f" {mark}[{h.rank}] {h.label}  {d}{rr} cos {h.score:.2f}{r}")
    out.append(f"{b}git state{r}")
    out += ["  " + ln for ln in (a.branch + "\n" + a.status).splitlines()[:12]]
    if a.tool_calls:
        out.append(f"{b}tool calls{r}")
        for name, args, result in a.tool_calls:
            out.append(f"  {name}({args})")
            out += [f"    {d}{ln}{r}" for ln in result.splitlines()[:8]]
    return "\n".join(out)


class Session:
    """Turns one input line into output text. Separate from the terminal so it can be tested."""

    def __init__(self, assistant: Assistant, reindex: Callable[[], str] | None = None, color: bool = True):
        self.assistant = assistant
        self.tools = assistant.tools
        self.reindex = reindex
        self.color = color
        self.last: Answer | None = None

    async def handle(self, line: str) -> str | None:
        """The text to print, or None to quit."""
        line = line.strip()
        if not line:
            return ""
        if not line.startswith("/"):
            return await self._help(line)
        cmd, _, rest = line.partition(" ")
        rest = rest.strip()
        try:
            args = shlex.split(rest)
        except ValueError:
            args = rest.split()
        match cmd.lower():
            case "/help" | "/h" | "/?":
                return await self._help(rest) if rest else COMMANDS
            case "/quit" | "/exit" | "/q":
                return None
            case "/branch":
                return await self.tools.call("git_branch")
            case "/status":
                return await self.tools.call("git_status")
            case "/files" | "/ls":
                params: dict = {"path": args[0] if args else "."}
                if len(args) > 1 and args[1].isdigit():
                    params["depth"] = int(args[1])
                return await self.tools.call("list_files", params)
            case "/diff":
                params = {}
                it = iter(args)
                for a in it:
                    if a == "--base":
                        params["base"] = next(it, "main")
                    elif a == "--stat":
                        params["stat"] = True
                    else:
                        params["path"] = a
                return await self.tools.call("git_diff", params)
            case "/log":
                params = {}
                for a in args:
                    if a.isdigit():
                        params["n"] = int(a)
                    else:
                        params["path"] = a
                return await self.tools.call("git_log", params)
            case "/sources":
                return render_sources(self.last, self.color)
            case "/reindex":
                if self.reindex is None:
                    return "reindexing isn't available here"
                return await asyncio.to_thread(self.reindex)
            case _:
                return f"unknown command {cmd}; /help lists them"

    async def _help(self, question: str) -> str:
        try:
            self.last = await self.assistant.help(question)
        except LLMError as e:
            return f"error: {e}"
        return render(self.last, self.color)


async def run(assistant: Assistant, color: bool = True) -> None:
    def reindex() -> str:
        report = build(assistant.retriever.store)
        assistant.retriever.store._matrix = None
        return str(report)

    session = Session(assistant, reindex, color)
    branch = (await assistant.tools.call("git_branch")).splitlines()[0]
    docs = len(assistant.retriever.store.files())
    print(f"{BOLD}devassist{RESET} · {branch} · {docs} documents indexed · model {assistant.llm.model}")
    print(f"{DIM}/help QUESTION (or just type it) · /help for commands · /quit{RESET}")
    while True:
        try:
            line = await asyncio.to_thread(input, f"{CYAN}›{RESET} " if color else "> ")
        except (EOFError, KeyboardInterrupt):
            print()
            return
        asks = line.strip() and (not line.startswith("/") or line.startswith("/help ") or line.startswith("/h "))
        if asks and color:
            print(f"{DIM}searching the docs, asking {assistant.llm.model}…{RESET}", end="\r", flush=True)
        out = await session.handle(line)
        if asks and color:
            print("\r\033[K", end="")
        if out is None:
            return
        if out:
            print(out + "\n")


def make_assistant(tools, db=None, model: str | None = None) -> Assistant:
    from .llm import LocalLLM
    retriever = Retriever(db) if db else Retriever()
    return Assistant(retriever, tools, LocalLLM(model) if model else LocalLLM())
