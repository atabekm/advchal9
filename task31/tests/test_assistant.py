import asyncio
import subprocess
from pathlib import Path

import pytest

from devassist.assistant import MAX_ROUNDS, Assistant, check_citations, mentioned_paths, user_prompt
from devassist.llm import Reply, ToolCall
from devassist.repl import Session, render
from devassist.retrieve import Hit
from devassist.tools import DevTools
from devmcp.server import Repo, create_server


class ScriptedLLM:
    """Replies in order; records the messages and tools of every call."""
    model = "scripted"

    def __init__(self, *replies: Reply):
        self.replies = list(replies)
        self.calls: list[tuple[list[dict], list | None]] = []

    def chat(self, messages, tools=None):
        self.calls.append(([dict(m) for m in messages], tools))
        return self.replies.pop(0) if self.replies else Reply("no more replies")


class StaticRetriever:
    def __init__(self, hits):
        self.hits = hits

    def search(self, question, k=6):
        return self.hits[:k]


HITS = [Hit(1, "task30/README.md#0", "task30/README.md", "task30", "Task 30 › Settings", "MAX_QUEUE is 6.", 0.7),
        Hit(2, "docs/conventions.md#3", "docs/conventions.md", "", "Conventions › Git workflow",
            "Branches are named taskN/<short-name>.", 0.6)]


@pytest.fixture
def repo(tmp_path):
    def git(*a):
        subprocess.run(["git", *a], cwd=tmp_path, check=True, capture_output=True)
    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    (tmp_path / "task30" / "gateway").mkdir(parents=True)
    (tmp_path / "task30" / "gateway" / "app.py").write_text("app = 1\n")
    (tmp_path / "task30" / "gateway" / "limits.py").write_text("x = 1\n")
    git("add", ".")
    git("commit", "-q", "-m", "Task 30: gateway")
    git("checkout", "-q", "-b", "task31/dev-assistant")
    return tmp_path


def run(coro):
    return asyncio.run(coro)


def ask(repo, llm, question, hits=HITS):
    async def go():
        async with DevTools(server=create_server(Repo(repo))) as tools:
            return await Assistant(StaticRetriever(hits), tools, llm).help(question)
    return run(go())


def test_git_state_is_always_in_the_prompt(repo):
    llm = ScriptedLLM(Reply("You are on task31/dev-assistant."))
    a = ask(repo, llm, "which branch is this?")
    prompt = llm.calls[0][0][1]["content"]
    assert "GIT STATE\nbranch: task31/dev-assistant" in prompt
    assert "clean: no changes" in prompt
    assert "[1] task30/README.md › Task 30 › Settings\nMAX_QUEUE is 6." in prompt
    assert prompt.endswith("QUESTION\nwhich branch is this?")
    assert a.branch.startswith("branch: task31/dev-assistant")
    assert a.tool_calls == [] and a.rounds == 1


def test_tool_call_result_goes_back_to_the_model(repo):
    llm = ScriptedLLM(Reply("", [ToolCall("git_log", {"n": 1})]),
                      Reply("The last commit is 'Task 30: gateway'."))
    a = ask(repo, llm, "what was the last commit?")
    assert a.rounds == 2
    assert [(n, args) for n, args, _ in a.tool_calls] == [("git_log", {"n": 1})]
    second = llm.calls[1][0]
    assert second[-2]["role"] == "assistant" and second[-2]["tool_calls"][0]["function"]["name"] == "git_log"
    assert second[-1]["role"] == "tool" and "Task 30: gateway" in second[-1]["content"]
    assert a.text == "The last commit is 'Task 30: gateway'."


def test_offered_tools_exclude_git_state_and_unknown_calls_are_refused(repo):
    llm = ScriptedLLM(Reply("", [ToolCall("git_branch", {})]), Reply("done"))
    a = ask(repo, llm, "q")
    offered = {t["function"]["name"] for t in llm.calls[0][1]}
    assert offered == {"list_files", "read_file", "git_log", "git_diff"}
    assert a.tool_calls[0][2].startswith("error: 'git_branch' is not available here")


def test_rounds_are_capped_and_the_last_has_no_tools(repo):
    loop = [Reply("", [ToolCall("git_log", {})]) for _ in range(MAX_ROUNDS)]
    llm = ScriptedLLM(*loop, Reply("final"))
    a = ask(repo, llm, "q")
    assert a.rounds == MAX_ROUNDS + 1 and a.text == "final"
    assert all(tools for _, tools in llm.calls[:-1]) and llm.calls[-1][1] is None


def test_a_named_directory_is_listed_up_front(repo):
    llm = ScriptedLLM(Reply("app.py and limits.py"))
    a = ask(repo, llm, "What is in task30/gateway?")
    prompt = llm.calls[0][0][1]["content"]
    assert "FILES\ntask30/gateway/ — 2 files" in prompt and "  limits.py" in prompt
    assert a.listed == ["task30/gateway"] and a.tool_calls == []


def test_a_named_file_or_missing_path_is_not_listed(repo):
    llm = ScriptedLLM(Reply("ok"))
    a = ask(repo, llm, "what does task30/gateway/app.py and and/or no/such/dir do?")
    assert "FILES" not in llm.calls[0][0][1]["content"]
    assert a.listed == []


def test_empty_reply_is_reported():
    assert check_citations("", 3) == ("", [])


@pytest.mark.parametrize("text, n, fixed, cited", [
    ("Six [1]. Branches [2].", 2, "Six [1]. Branches [2].", [1, 2]),
    ("Made up [7].", 2, "Made up.", []),
    ("Both [2, 9, 1].", 2, "Both [2, 1].", [1, 2]),
    ("No citations.", 2, "No citations.", []),
])
def test_check_citations(text, n, fixed, cited):
    assert check_citations(text, n) == (fixed, cited)


def test_mentioned_paths():
    assert mentioned_paths("what's in task30/gateway/ and `docs`?") == ["task30/gateway", "docs"]
    assert mentioned_paths("see https://example.com/x") == []
    assert mentioned_paths("which tasks use Ollama?") == []


def test_user_prompt_caps_a_long_status():
    status = "30 changed paths:\n" + "\n".join(f"?? f{i}" for i in range(30))
    prompt = user_prompt("q", "branch: b", status, [])
    assert "… 15 more" in prompt and "(no passages found)" in prompt


def test_session_commands(repo):
    async def go():
        async with DevTools(server=create_server(Repo(repo))) as tools:
            llm = ScriptedLLM(Reply("MAX_QUEUE is 6 [1]."))
            s = Session(Assistant(StaticRetriever(HITS), tools, llm), color=False)
            assert "/branch" in await s.handle("/help")
            assert (await s.handle("/branch")).startswith("branch: task31/dev-assistant")
            assert "gateway/  (2 files)" in await s.handle("/files task30 1")
            assert "Task 30: gateway" in await s.handle("/log 5")
            assert "no differences" in await s.handle("/diff --base main")
            assert (await s.handle("/sources")).startswith("no answer yet")
            answer = await s.handle("How big is the queue?")  # plain text is a /help
            assert answer.startswith("MAX_QUEUE is 6 [1].")
            assert "  [1] task30/README.md › Task 30 › Settings" in answer
            assert "*[1] task30/README.md" in await s.handle("/sources")
            assert (await s.handle("/frobnicate")).startswith("unknown command")
            assert await s.handle("/quit") is None
    run(go())


def test_render_lists_lookups():
    from devassist.assistant import Answer
    a = Answer("q", "text [1]", HITS, "branch: main", "clean", cited=[1], listed=["task30"],
               tool_calls=[("git_log", {"n": 2}, "abc 2026-10-13 T  Task 1")], rounds=2)
    out = render(a, color=False)
    assert "sources\n  [1] task30/README.md › Task 30 › Settings" in out
    assert "list_files('task30')" in out and "git_log(n=2)  → abc 2026-10-13 T  Task 1" in out
    assert "branch main · 2 model calls" in out
