import asyncio
import subprocess
from pathlib import Path

import pytest

from devassist.tools import DevTools
from devmcp.server import Repo, ToolError, create_server


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "t@example.com")
    git(tmp_path, "config", "user.name", "T")
    (tmp_path / "task1" / "gateway").mkdir(parents=True)
    (tmp_path / "README.md").write_text("# Repo\n")
    (tmp_path / "task1" / "README.md").write_text("# Task 1\n")
    (tmp_path / "task1" / "gateway" / "app.py").write_text("\n".join(f"line {i}" for i in range(1, 501)))
    (tmp_path / ".gitignore").write_text("*.db\n")
    (tmp_path / "task1" / "index.db").write_text("ignored")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-q", "-m", "Task 1: first")
    git(tmp_path, "checkout", "-q", "-b", "task2/feature")
    (tmp_path / "task2").mkdir()
    (tmp_path / "task2" / "README.md").write_text("# Task 2\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-q", "-m", "Task 2: second")
    return tmp_path


def test_branch(repo):
    out = Repo(repo).branch()
    assert "branch: task2/feature" in out
    assert "upstream: none" in out
    assert "commits since main: 1" in out


def test_branch_detached(repo):
    git(repo, "checkout", "-q", "--detach", "HEAD~1")
    assert Repo(repo).branch().startswith("detached HEAD at ")


def test_status(repo):
    r = Repo(repo)
    assert r.status() == "clean: no changes"
    (repo / "README.md").write_text("# Repo, edited\n")
    (repo / "new.txt").write_text("x")
    out = r.status()
    assert "2 changed paths" in out and " M README.md" in out and "?? new.txt" in out


def test_log_and_path_filter(repo):
    r = Repo(repo)
    assert r.log().splitlines()[0].endswith("Task 2: second")
    assert "Task 2" not in r.log(path="task1")
    assert len(r.log(n=1).splitlines()) == 1


def test_diff_working_tree_and_against_base(repo):
    r = Repo(repo)
    assert r.diff() == "no differences in the working tree (vs HEAD)"
    branch = r.diff(base="main", stat=True)
    assert "task2/README.md" in branch and "task1" not in branch
    (repo / "README.md").write_text("# Repo\nmore\n")
    assert "+more" in r.diff(path="README.md")
    with pytest.raises(ToolError):
        r.diff(base="--output=/tmp/x")


def test_list_files_tree(repo):
    r = Repo(repo)
    top = r.files(depth=1)
    assert "  task1/  (2 files)" in top and "  README.md" in top
    assert "index.db" not in r.files("task1", depth=3)  # ignored
    assert "  gateway/app.py" in r.files("task1", depth=3)  # relative to the listed directory


def test_paths_stay_inside_the_repository(repo):
    r = Repo(repo)
    for bad in ("../outside", "/../../etc/passwd", "task1/../../x"):
        with pytest.raises(ToolError):
            r.rel(bad)
    assert r.rel("/task1/") == "task1"


def test_read_file_caps_lines(repo):
    out = Repo(repo).read("task1/gateway/app.py", start=10, lines=3)
    assert "(lines 10-12 of 500)" in out and "   10  line 10" in out and "… 488 more lines" in out
    with pytest.raises(ToolError):
        Repo(repo).read("task1")


def test_over_mcp_in_process(repo):
    """The same tools through a real MCP client: names, schemas, results and errors as text."""
    async def run():
        async with DevTools(server=create_server(Repo(repo))) as tools:
            assert set(tools.names) == {"git_branch", "git_status", "git_log", "git_diff", "list_files", "read_file"}
            spec = {s["function"]["name"]: s for s in tools.ollama_specs()}
            diff_params = spec["git_diff"]["function"]["parameters"]["properties"]
            assert diff_params["base"]["type"] == "string" and "anyOf" not in diff_params["base"]
            assert spec["read_file"]["function"]["parameters"]["required"] == ["path"]
            assert "branch: task2/feature" in await tools.call("git_branch")
            assert (await tools.call("read_file", {"path": "../x"})).startswith("error:")
            assert (await tools.call("rm_rf")).startswith("error: no tool named")
            assert [c[0] for c in tools.calls] == ["git_branch", "read_file", "rm_rf"]
    asyncio.run(run())
