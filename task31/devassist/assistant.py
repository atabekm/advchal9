"""`/help QUESTION`: answer a question about the project from its docs and its live git state.

1. **Git state, always.** `git_branch` and `git_status` are called through MCP before the model
   sees anything, so the branch is in every prompt whether or not the model thinks to ask.
2. **Documentation.** The retriever's top passages (scoped to the tasks the question names),
   numbered [1]..[n] with their file and section.
   A directory the question names by path ("task30/gateway") is listed through MCP too: an
   8B model asked "what's in X" answers from whatever the docs mention instead of looking.
3. **Tools, if needed.** The model may call `list_files`, `read_file`, `git_log` and `git_diff`
   for what the docs can't say ("what's in task30/gateway?", "what changed on this branch?").
   Each result goes back as a tool message; after MAX_ROUNDS rounds it must answer without tools.
4. **Citations are checked.** A [n] that doesn't point at a passage is removed; the sources
   listed under the answer are the passages it actually cites.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

from .llm import LocalLLM, Reply
from .retrieve import Hit, Retriever, mentioned_tasks
from .tools import DevTools

MAX_ROUNDS = 3
MODEL_TOOLS = {"list_files", "read_file", "git_log", "git_diff"}
STATUS_LINES = 15
PASSAGE_CHARS = 1800

SYSTEM = """\
You are the developer assistant of the git repository `ai-advent-challenge9`: a monorepo with one
folder per day of an AI engineering course (task1 … task31), plus a root README.md and docs/.
You answer a developer's questions about this project: its structure, what each task built and how,
how to run and test things, conventions, APIs, data schemas, and the current git state.

Each question comes with:
- GIT STATE: the current branch and uncommitted changes, fetched live just now.
- DOCUMENTATION: passages from the project's documentation, numbered [1], [2], ... with file and section.
- FILES (sometimes): the listing of a directory the question names, fetched live.

Some questions are about the repository as it is now, not as documented. For those, call a
tool BEFORE answering; the git state above only lists uncommitted files:
- what changed on this branch / compared to main / since main → git_diff with base "main" (stat true)
- uncommitted changes in detail → git_diff without base
- recent commits, history, who/when changed something → git_log
- what files, modules or folders a directory contains, when no passage lists them → list_files
- what a specific file says, its code or config, when no passage quotes it → read_file
When the passages already answer the question, answer without tools.
If a tool returns an error, correct the arguments and call it again; never ask the developer to run it.

Rules:
- Use only what the passages, the git state and tool results say. Never invent file names,
  commands, numbers or tasks.
- Cite the passages you use, like [2], at the end of the sentence. Facts from the git state, FILES
  or a tool need no citation. Write file paths from the repository root in backticks, not as links.
- If nothing you have answers the question, say so plainly and say where the developer could look.
- Answer in the language of the question. Be concise: a few sentences or a short list."""


@dataclass
class Answer:
    question: str
    text: str
    hits: list[Hit]
    branch: str
    status: str
    tool_calls: list[tuple[str, dict, str]] = field(default_factory=list)  # (name, arguments, result)
    cited: list[int] = field(default_factory=list)
    scope: set[str] = field(default_factory=set)
    listed: list[str] = field(default_factory=list)  # directories listed up front
    rounds: int = 0
    seconds: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def sources(self) -> list[Hit]:
        return [h for h in self.hits if h.rank in self.cited]


class Assistant:
    def __init__(self, retriever: Retriever, tools: DevTools, llm: LocalLLM | None = None, k: int = 6):
        self.retriever = retriever
        self.tools = tools
        self.llm = llm or LocalLLM()
        self.k = k

    async def help(self, question: str) -> Answer:
        started = time.monotonic()
        branch = await self.tools.call("git_branch")
        status = await self.tools.call("git_status")
        listings, listed = [], []
        for path in mentioned_paths(question)[:2]:
            out = await self.tools.call("list_files", {"path": path, "depth": 2})
            if not out.startswith("error:") and "\n" in out:  # a directory, not a file
                listings.append(out)
                listed.append(path)
        hits = self.retriever.search(question, k=self.k)
        messages = [{"role": "system", "content": SYSTEM},
                    {"role": "user", "content": user_prompt(question, branch, status, hits, listings)}]
        specs = self.tools.ollama_specs(MODEL_TOOLS)
        before = len(self.tools.calls)
        answer = Answer(question, "", hits, branch, status, scope=mentioned_tasks(question))
        reply: Reply | None = None
        for round_ in range(MAX_ROUNDS + 1):
            last = round_ == MAX_ROUNDS
            reply = self.llm.chat(messages, tools=None if last else specs)
            answer.rounds += 1
            answer.prompt_tokens += reply.prompt_tokens
            answer.completion_tokens += reply.completion_tokens
            if not reply.tool_calls or last:
                break
            messages.append({"role": "assistant", "content": reply.text,
                             "tool_calls": [{"function": {"name": c.name, "arguments": c.arguments}}
                                            for c in reply.tool_calls]})
            for call in reply.tool_calls:
                if call.name not in MODEL_TOOLS:
                    result = f"error: {call.name!r} is not available here; use one of {', '.join(sorted(MODEL_TOOLS))}"
                    self.tools.calls.append((call.name, call.arguments, result))
                else:
                    result = await self.tools.call(call.name, call.arguments)
                messages.append({"role": "tool", "tool_name": call.name, "content": result})
        text = reply.text if reply else ""
        if not text:
            text = "I couldn't produce an answer (the model returned nothing)."
        answer.text, answer.cited = check_citations(text, len(hits))
        answer.tool_calls = self.tools.calls[before:]
        answer.listed = listed
        answer.seconds = time.monotonic() - started
        return answer


PATH_RE = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)+[\w.-]*|`[\w./-]+`)")


def mentioned_paths(question: str) -> list[str]:
    """Path-like words of the question: "task30/gateway", "docs/", "`devmcp`"."""
    out = []
    for m in PATH_RE.findall(question):
        path = m.strip("`").rstrip(".,;:?!)").rstrip("/")
        if path and not path.startswith(("http", "www.")) and path not in out:
            out.append(path)
    return out


def user_prompt(question: str, branch: str, status: str, hits: list[Hit], listings: list[str] = ()) -> str:
    status_lines = status.splitlines()
    if len(status_lines) > STATUS_LINES + 1:
        status = "\n".join(status_lines[:STATUS_LINES + 1]) + f"\n… {len(status_lines) - STATUS_LINES - 1} more"
    passages = "\n\n".join(f"[{h.rank}] {h.label}\n{_clip(h.text)}" for h in hits) or "(no passages found)"
    files = "".join(f"FILES\n{listing}\n\n" for listing in listings)
    return (f"GIT STATE (live)\n{branch}\nuncommitted changes only (not the branch's commits): {status}\n\n"
            f"DOCUMENTATION\n{passages}\n\n"
            f"{files}QUESTION\n{question}\n\n"
            f"(If the answer depends on the repository's current files, commits or diffs and nothing above "
            f"shows them, call a tool first.)")


def _clip(text: str) -> str:
    return text if len(text) <= PASSAGE_CHARS else text[:PASSAGE_CHARS] + " …"


CITE_RE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")


def check_citations(text: str, n_hits: int) -> tuple[str, list[int]]:
    """Drop [n] markers that point at no passage; return the text and the passages cited."""
    cited: list[int] = []

    def fix(m: re.Match) -> str:
        nums = [int(x) for x in re.findall(r"\d+", m.group(1))]
        good = [n for n in nums if 1 <= n <= n_hits]
        cited.extend(n for n in good if n not in cited)
        return f"[{', '.join(map(str, good))}]" if good else ""

    fixed = CITE_RE.sub(fix, text)
    fixed = re.sub(r"[ \t]+([.,;:])", r"\1", fixed)
    return fixed, sorted(cited)


def answer_json(a: Answer) -> dict:
    return {"question": a.question, "answer": a.text, "branch": a.branch.splitlines()[0] if a.branch else "",
            "scope": sorted(a.scope), "listed": a.listed,
            "passages": [{"rank": h.rank, "label": h.label, "rerank": h.rerank, "cited": h.rank in a.cited}
                         for h in a.hits],
            "tool_calls": [{"tool": n, "arguments": args, "result": r[:300]} for n, args, r in a.tool_calls],
            "rounds": a.rounds, "seconds": round(a.seconds, 1),
            "tokens": {"prompt": a.prompt_tokens, "completion": a.completion_tokens}}


def dumps(a: Answer) -> str:
    return json.dumps(answer_json(a), ensure_ascii=False, indent=2)
