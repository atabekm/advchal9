import asyncio

import pytest

from fileassist import fixture, runs
from fileassist.agent import Agent
from fileassist.files_client import FilesClient
from fileassist.llm import Reply, ToolCall
from filemcp.server import create_server


class ScriptedLLM:
    """Replays a list of replies; records the messages and tools it was given."""

    model = "scripted"
    num_ctx = 32768

    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []

    def version(self):
        return "test"

    def chat(self, messages, tools=None):
        self.seen.append(([dict(m) for m in messages], tools))
        return self.replies.pop(0) if self.replies else Reply(text="")


def call(name, **args):
    return Reply(text="", tool_calls=[ToolCall(name, args)])


@pytest.fixture
def repo(tmp_path):
    return fixture.build(tmp_path / "parcel")


def go(repo, llm, goal="Fix the README", **kw):
    async def run():
        async with FilesClient(server=create_server(repo)) as fs:
            return await Agent(fs, llm, **kw).run(goal, extra="Checklist: be careful.")
    return asyncio.run(run())


def test_explore_edit_finish(repo):
    llm = ScriptedLLM([
        call("search", pattern="--zone", literal=True),
        Reply(text="Reading it.", tool_calls=[ToolCall("read_file", {"path": "README.md", "start": 25, "end": 32}),
                                              ToolCall("git_show", {})]),
        call("edit_file", path="README.md", old="parcel quote 2.5 --zone FR", new="parcel quote 2.5 --to FR"),
        call("finish", report="first try"),
        call("finish", report="Changed `README.md:29` to `--to`."),
    ])
    run = go(repo, llm)
    assert run.finished and run.stop_reason == "finished" and run.report == "Changed `README.md:29` to `--to`."
    assert [e.tool for e in run.calls] == ["list_files", "search", "read_file", "git_show", "edit_file"]
    assert run.steps == 4 and run.model_calls == 5
    review = next(e for e in run.events if e.kind == "review")
    assert review.text == "first try" and "-    parcel quote 2.5 --zone FR" in review.result
    assert "Lines your changes delete:\n-     parcel quote 2.5 --zone FR" in review.result
    assert run.changed == ["modified README.md"] and "+    parcel quote 2.5 --to FR" in run.diff
    assert "--zone FR" in (repo / "README.md").read_text()          # staged only
    first_messages, tools = llm.seen[0]
    assert first_messages[1]["content"].startswith("Goal: Fix the README\n\nChecklist: be careful.\n\n"
                                               "The project's files (list_files):\n24 files\n.env.example  (3 lines)")
    names = {t["function"]["name"] for t in tools}
    assert "finish" in names and "edit_file" in names and "apply_staged" not in names
    assert [e.kind for e in run.events].count("text") == 1
    tool_msgs = [m for m in llm.seen[-1][0] if m["role"] == "tool"]
    assert tool_msgs[-2]["content"].startswith("edited README.md") and tool_msgs[-1]["content"].startswith("Before you finish")


def test_repeated_reads_are_not_rerun(repo):
    llm = ScriptedLLM([call("read_file", path="RULES.md"), call("read_file", path="RULES.md"),
                       call("finish", report="done")])
    run = go(repo, llm)
    assert run.calls[2].result.startswith("(You made this exact call at step 1;") and "Project rules" in run.calls[2].result


def test_a_read_after_an_edit_runs_again(repo):
    llm = ScriptedLLM([call("read_file", path=".env.example"),
                       call("edit_file", path=".env.example", old="PARCEL_CURRENCY=EUR\n",
                            new="PARCEL_CURRENCY=EUR\nPARCEL_MAX_WEIGHT_KG=30\n"),
                       call("read_file", path=".env.example"), call("finish", report="ok")])
    run = go(repo, llm)
    assert "PARCEL_MAX_WEIGHT_KG=30" in run.calls[3].result


def test_the_third_identical_call_stops_the_run(repo):
    bad = dict(path="README.md", old="+# parcel", new="+# parcel")
    llm = ScriptedLLM([call("edit_file", **bad)] * 5)
    run = go(repo, llm)
    assert run.stop_reason == "stuck: the same edit_file call three times" and run.steps == 3
    assert "new must be the text as it should read after the change" in run.calls[1].result


def test_a_model_error_ends_the_run_with_the_changes_so_far(repo):
    from fileassist.llm import LLMError

    class Failing(ScriptedLLM):
        def chat(self, messages, tools=None):
            if self.replies:
                return super().chat(messages, tools)
            raise LLMError("ollama unreachable")

    run = go(repo, Failing([call("edit_file", path="README.md", old="# parcel\n", new="# parcel!\n")]))
    assert run.stop_reason == "model error: ollama unreachable" and "+# parcel!" in run.diff


def test_budget_stops_the_run_and_keeps_the_changes(repo):
    llm = ScriptedLLM([call("edit_file", path="README.md", old="# parcel\n", new="# parcel!\n")]
                      + [call("list_files", path="docs", pattern=f"*{i}*") for i in range(10)])
    run = go(repo, llm, max_steps=3)
    assert not run.finished and run.stop_reason == "budget of 3 tool calls used up"
    assert run.steps == 3 and "+# parcel!" in run.diff
    assert run.report.startswith("(The run stopped: budget of 3 tool calls used up.")


def test_text_without_tools_gets_one_nudge(repo):
    llm = ScriptedLLM([Reply(text="I would change the README."), Reply(text="The README needs --to.")])
    run = go(repo, llm)
    assert run.finished and run.stop_reason == "answered without finish"
    assert run.report == "The README needs --to." and run.steps == 0
    assert llm.seen[1][0][-1]["content"].startswith("Use the tools, not text.")


def test_unknown_tool_and_errors_go_back_to_the_model(repo):
    llm = ScriptedLLM([call("delete_file", path="README.md"), call("read_file", path="nope.md"),
                       call("finish", report="x")])
    run = go(repo, llm)
    assert run.calls[1].result.startswith("error: no tool named 'delete_file'")
    assert run.calls[2].result.startswith("error: no file 'nope.md'")


def test_old_results_are_trimmed(repo):
    llm = ScriptedLLM([call("read_file", path=p) for p in ("docs/usage.md", "README.md", "CHANGELOG.md",
                                                           "RULES.md", "docs/adr/0001-zone-based-flat-rates.md",
                                                           "docs/adr/0002-money-as-decimal.md", "parcel/rates.py")]
                      + [call("finish", report="x")])
    llm.num_ctx = 2000
    go(repo, llm)
    last = llm.seen[-1][0]
    assert "[older result trimmed" in last[3]["content"] and "[older result trimmed" not in last[-1]["content"]


def test_save(repo, tmp_path):
    llm = ScriptedLLM([call("edit_file", path="README.md", old="# parcel\n", new="# parcel!\n"),
                       call("finish", report="Renamed."), call("finish", report="Renamed.")])
    run = go(repo, llm)
    out = runs.save(run, repo, "smoke", runs_dir=tmp_path)
    assert out.name.endswith("-smoke")
    assert (out / "report.md").read_text() == "Renamed.\n" and "+# parcel!" in (out / "changes.diff").read_text()
    assert '"tool": "edit_file"' in (out / "transcript.json").read_text()


def test_no_review_without_changes(repo):
    run = go(repo, ScriptedLLM([call("search", pattern="TODO"), call("finish", report="One TODO.")]))
    assert run.finished and run.report == "One TODO." and not any(e.kind == "review" for e in run.events)


def test_a_text_answer_with_changes_gets_the_review_too(repo):
    llm = ScriptedLLM([call("edit_file", path="README.md", old="# parcel\n", new="# parcel!\n"),
                       Reply(text="Done."), Reply(text="Done, really."), Reply(text="Reviewed, all good.")])
    run = go(repo, llm)
    kinds = [e.kind for e in run.events]
    assert kinds.count("review") == 1 and run.report == "Reviewed, all good."
    assert llm.seen[3][0][-1]["content"].startswith("Before you finish")


def test_a_read_only_run_has_no_write_tools(repo):
    llm = ScriptedLLM([call("edit_file", path="README.md", old="# parcel\n", new="# parcel!\n"),
                       call("finish", report="done")])
    run = go(repo, llm, read_only=True)
    offered = {t["function"]["name"] for t in llm.seen[0][1]}
    assert not offered & {"edit_file", "insert_lines", "write_file"} and "read_file" in offered
    assert run.calls[-1].result.startswith("error: this goal only reads") and run.diff == ""


def test_a_finish_written_as_json_text_finishes(repo):
    llm = ScriptedLLM([Reply(text='{"report": "Nothing to change."}')])
    run = go(repo, llm, review=False)
    assert run.finished and run.report == "Nothing to change." and llm.seen[-1][0][-1]["role"] == "user"
