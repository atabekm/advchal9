"""The agent: a goal in, a report and a diff out. The model chooses every file operation itself.

    goal ─▶ model ⇄ filemcp tools (list, search, outline, read, git, edit, write) ─▶ finish(report)

The run opens with the project's file list (step 0, list_files, made by the agent like any other call),
so the model starts from real paths instead of guessing them. The loop's guards keep a small local
model on track without choosing for it:
- a budget of tool calls; past it the run stops and keeps the staged changes so far;
- a read-only call repeated with the same arguments gets its earlier result back with a warning, and
  the third identical call of any tool stops the run (small models get stuck in such loops);
- a reply with text but no tool call gets one nudge, then counts as the report;
- old tool results are trimmed when the conversation nears the context window;
- the first finish with staged changes is answered with the diff for a review: the model sees what it
  deleted and moved, fixes what the goal didn't ask for, and finishes again.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .files_client import FilesClient
from .llm import LLMError, LocalLLM, ToolCall, ollama_specs

MAX_STEPS = 40
MAX_RESULT_CHARS = 9000
READ_ONLY = {"list_files", "read_file", "search", "outline", "git_log", "git_show", "git_diff"}
WRITES = {"edit_file", "insert_lines", "write_file"}

SYSTEM = """You are a file assistant working inside a software project. You do the work yourself \
with the tools; never ask the user to open files, run commands or make the edits.

Paths are relative to the project root; the file list below is where to start. Git tools show the \
committed history; your edits are staged on top of it and the user reviews them as a diff.

How to work:
1. Explore first: list_files, search and outline to find every file that matters. Never guess \
a path or a line; take them from tool results.
2. Read the parts you rely on or will change with read_file.
3. Change files only when the goal asks for changes, and only the kind of files the goal is about \
(a documentation goal changes documentation, not code). Keep each file's style. Three tools:
   - insert_lines to ADD lines (a table row, a list item, a setting, a section) after an existing line;
   - edit_file to CHANGE existing text: `old` copied exactly from read_file (without the "12| " prefix, \
indentation included) is replaced by `new`, so whatever you leave out of `new` is deleted;
   - write_file for NEW files.
   Make the edits; don't describe edits you could make.
4. Verify: after editing, search for leftovers of the old text and fix them too.
5. Finish by calling finish(report). The report is for the user: what you found and what you \
changed, with file:line references, in Markdown. Don't call finish before the work is done.

If a tool returns an error, correct the arguments and continue; never repeat a call that failed \
unchanged. Several tool calls in one turn are fine."""

FINISH = {"type": "function", "function": {
    "name": "finish",
    "description": "End the task with the final report for the user (Markdown): findings with file:line "
                   "references and a list of the changes made. Call it once, when the work is done.",
    "parameters": {"type": "object", "properties": {"report": {"type": "string"}}, "required": ["report"]}}}

REVIEW = """Before you finish, review your changes. This is the diff of everything you staged:

{diff}
{deleted}
Check it against the goal:
- Is every '-' line meant to go? A line you replaced instead of adding next to it must come back \
(insert_lines or edit_file).
- Is every '+' line in the right place (inside the table or list it belongs to) and true to the code?
- Is anything the goal asks for still missing?
Fix what is wrong with the tools, then call finish again with the report. If the diff is right, call \
finish again now."""

NUDGE = ("Use the tools, not text. If the goal is reached, call finish with the report (the text above "
         "can be it); if it isn't, continue with the next tool call.")


@dataclass
class Event:
    kind: str            # "call", "text", "think", "review", "finish", "stop"
    step: int
    tool: str = ""
    arguments: dict = field(default_factory=dict)
    result: str = ""
    text: str = ""
    seconds: float = 0.0

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in ("", {}, 0.0) or k in ("kind", "step")}


@dataclass
class Run:
    goal: str
    model: str
    model_version: str = ""
    report: str = ""
    finished: bool = False
    stop_reason: str = ""
    events: list[Event] = field(default_factory=list)
    diff: str = ""
    changed: list[str] = field(default_factory=list)   # "modified path" / "new path"
    steps: int = 0
    model_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0

    @property
    def calls(self) -> list[Event]:
        return [e for e in self.events if e.kind == "call"]

    def to_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k != "events"}
        d["events"] = [e.to_dict() for e in self.events]
        return d


def _key(name: str, args: dict) -> str:
    return name + json.dumps(args, sort_keys=True, ensure_ascii=False)


def _report_in_text(text: str) -> str | None:
    """The report when a reply's text is a finish call written as JSON ({"report": "..."}), else None."""
    t = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    if not t.startswith("{"):
        return None
    try:
        data = json.loads(t)
    except ValueError:
        return None
    return data["report"] if isinstance(data, dict) and isinstance(data.get("report"), str) else None


def _clip(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n… cut at {limit} characters; narrow the call"


class Agent:
    def __init__(self, files: FilesClient, llm: LocalLLM | None = None, max_steps: int = MAX_STEPS,
                 on_event: Callable[[Event], None] | None = None, system: str = SYSTEM, review: bool = True,
                 read_only: bool = False):
        self.files = files
        self.llm = llm or LocalLLM()
        self.max_steps = max_steps
        self.on_event = on_event or (lambda e: None)
        self.system = system
        self.review = review
        self.read_only = read_only   # a goal that only reads: the write tools aren't offered at all

    async def run(self, goal: str, extra: str = "") -> Run:
        """Work on `goal` until finish or the budget. `extra` is a scenario checklist after the goal."""
        run = Run(goal=goal, model=self.llm.model)
        run.model_version = await asyncio.to_thread(self.llm.version)
        started = time.monotonic()
        tools = [t for t in self.files.model_tools if not (self.read_only and t.name in WRITES)]
        specs = ollama_specs(tools) + [FINISH]
        user = f"Goal: {goal}" + (f"\n\n{extra}" if extra else "")
        messages: list[dict] = [{"role": "system", "content": self.system}, {"role": "user", "content": user}]
        seen: dict[str, int] = {}
        counts: dict[str, int] = {}
        nudged = False
        reviewed = not self.review

        def emit(e: Event) -> None:
            run.events.append(e)
            self.on_event(e)

        tree = await self.files.call("list_files", {"path": "."})
        emit(Event("call", 0, tool="list_files", arguments={"path": "."}, result=tree))
        messages[1]["content"] += f"\n\nThe project's files (list_files):\n{_clip(tree)}"
        seen[_key("list_files", {"path": "."})] = 0

        while not run.finished:
            if run.steps >= self.max_steps:
                run.stop_reason = f"budget of {self.max_steps} tool calls used up"
                emit(Event("stop", run.steps, text=run.stop_reason))
                break
            self._trim(messages)
            try:
                reply = await asyncio.to_thread(self.llm.chat, messages, specs)
            except LLMError as e:
                run.stop_reason = f"model error: {e}"
                emit(Event("stop", run.steps, text=run.stop_reason))
                break
            run.model_calls += 1
            run.prompt_tokens += reply.prompt_tokens
            run.completion_tokens += reply.completion_tokens
            if reply.thinking:
                emit(Event("think", run.steps, text=reply.thinking, seconds=reply.seconds))
            if reply.text and reply.tool_calls:
                emit(Event("text", run.steps, text=reply.text, seconds=reply.seconds))
            if not reply.tool_calls and (report := _report_in_text(reply.text)) is not None:
                reply.tool_calls = [ToolCall("finish", {"report": report})]   # finish written as JSON text
                reply.text = ""
            if not reply.tool_calls:
                if reply.text and nudged and not reviewed and (review := await self._review()):
                    reviewed = True
                    emit(Event("review", run.steps, text=reply.text, result=review, seconds=reply.seconds))
                    messages.append({"role": "assistant", "content": reply.text})
                    messages.append({"role": "user", "content": review})
                    continue
                if reply.text and nudged:
                    run.report, run.finished, run.stop_reason = reply.text, True, "answered without finish"
                    emit(Event("finish", run.steps, text=reply.text, seconds=reply.seconds))
                    break
                if run.model_calls >= self.max_steps + 5:
                    run.stop_reason = "the model stopped calling tools"
                    emit(Event("stop", run.steps, text=run.stop_reason))
                    break
                emit(Event("text", run.steps, text=reply.text or "(empty reply)", seconds=reply.seconds))
                messages.append({"role": "assistant", "content": reply.text})
                messages.append({"role": "user", "content": NUDGE})
                nudged = True
                continue
            turn = {"role": "assistant", "content": reply.text,
                    "tool_calls": [{"function": {"name": c.name, "arguments": c.arguments}} for c in reply.tool_calls]}
            if reply.thinking and self.llm.model.startswith("gpt-oss"):
                turn["thinking"] = reply.thinking  # gpt-oss continues its reasoning across tool calls
            messages.append(turn)
            for call in reply.tool_calls:
                if call.name == "finish" and not reviewed:
                    reviewed = True
                    if review := await self._review():
                        emit(Event("review", run.steps, text=str(call.arguments.get("report") or ""),
                                   result=review, seconds=reply.seconds))
                        messages.append({"role": "tool", "tool_name": "finish", "content": review})
                        break
                if call.name == "finish":
                    report = str(call.arguments.get("report") or reply.text or "").strip()
                    run.report, run.finished = report, True
                    run.stop_reason = "finished"
                    emit(Event("finish", run.steps, text=report, seconds=reply.seconds))
                    break
                run.steps += 1
                t0 = time.monotonic()
                key = _key(call.name, call.arguments)
                counts[key] = counts.get(key, 0) + 1
                if counts[key] >= 3:
                    run.stop_reason = f"stuck: the same {call.name} call three times"
                    emit(Event("stop", run.steps, tool=call.name, arguments=call.arguments, text=run.stop_reason))
                    break
                if self.read_only and call.name in WRITES:
                    result = f"error: this goal only reads; there is no {call.name}. Report your findings with finish."
                elif call.name in READ_ONLY and key in seen:
                    earlier = await self.files.call(call.name, call.arguments)
                    result = (f"(You made this exact call at step {seen[key]}; the result is the same. Don't "
                              f"repeat it: use the result, or take the next step.)\n{earlier}")
                else:
                    result = await self.files.call(call.name, call.arguments)
                    seen[key] = run.steps
                if call.name in WRITES and not result.startswith("error"):
                    # the files changed: reading them again is no longer a repeat
                    seen = {k: v for k, v in seen.items() if not k.startswith(tuple(READ_ONLY))}
                    counts = {k: v for k, v in counts.items() if not k.startswith(tuple(READ_ONLY))}
                emit(Event("call", run.steps, tool=call.name, arguments=call.arguments, result=result,
                           seconds=time.monotonic() - t0 + (reply.seconds if call is reply.tool_calls[0] else 0)))
                messages.append({"role": "tool", "tool_name": call.name, "content": _clip(result)})
            if run.stop_reason.startswith("stuck"):
                break
            nudged = False

        run.diff = await self.files.diff()
        changed = await self.files.call("staged_files")
        run.changed = changed.splitlines() if changed and not changed.startswith("error") else []
        if not run.finished and not run.report:
            run.report = (f"(The run stopped: {run.stop_reason}. The staged changes so far are in the diff.)")
        run.seconds = time.monotonic() - started
        return run

    async def _review(self) -> str:
        """The review request for the staged diff, or "" when nothing is staged."""
        diff = await self.files.diff()
        if not diff:
            return ""
        deleted = [x[1:] for x in diff.splitlines() if x.startswith("-") and not x.startswith("---")]
        listed = ("\nLines your changes delete:\n" + "\n".join(f"- {x}" for x in deleted) + "\n"
                  if deleted else "\nYour changes delete no lines.\n")
        return REVIEW.format(diff=_clip(diff, 6000), deleted=listed)

    def _trim(self, messages: list[dict]) -> None:
        """Shorten the oldest tool results once the conversation nears the context window (~3.5 chars/token)."""
        budget = int(self.llm.num_ctx * 0.75 * 3.5)
        total = sum(len(m.get("content") or "") for m in messages)
        for m in messages[2:-6]:
            if total <= budget:
                return
            if m["role"] == "tool" and len(m["content"]) > 400:
                total -= len(m["content"]) - 120
                m["content"] = m["content"][:120] + "\n… [older result trimmed to save context; call again if needed]"
