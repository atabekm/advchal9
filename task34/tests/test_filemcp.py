import asyncio
import subprocess

import pytest

from fileassist import fixture
from fileassist.files_client import FilesClient
from filemcp.server import CLIENT_TOOLS, create_server
from filemcp.workspace import Workspace, WorkspaceError


@pytest.fixture
def repo(tmp_path):
    return fixture.build(tmp_path / "parcel")


@pytest.fixture
def ws(repo):
    return Workspace(repo)


def test_the_root_is_a_jail(ws, repo, tmp_path):
    (tmp_path / "secret.txt").write_text("no")
    (repo / "link").symlink_to(tmp_path / "secret.txt")
    for bad in ("../secret.txt", str(tmp_path / "secret.txt"), "link", ".git/config", "docs/../../secret.txt"):
        with pytest.raises(WorkspaceError):
            ws.read_file(bad)
    assert ws.rel(str(repo / "README.md")) == "README.md"
    assert "link" not in ws.files() and not any(f.startswith(".git/") for f in ws.files())


def test_list_and_read(ws):
    out = ws.list_files("parcel", "*.py")
    assert out.startswith("7 files") and "parcel/batch.py  (20 lines)" in out
    assert ws.list_files(pattern="docs/**/*.md").startswith("6 files")
    page = ws.read_file("parcel/rates.py", 1, 3)
    assert page.splitlines()[0] == "parcel/rates.py · lines 1-3 of 43"
    assert page.splitlines()[1] == '1| """Price quotes: base rate + per-kg rate of the zone, surcharges, rounding to cents."""'
    assert "40 more lines: read_file('parcel/rates.py', start=4)" in page
    with pytest.raises(WorkspaceError, match="did you mean parcel/rates.py"):
        ws.read_file("rates.py")


def test_search(ws):
    out = ws.search(r"quote_price\b", glob="*.py")
    assert "parcel/batch.py:8: from .rates import quote_price as qp" in out
    assert "parcel/api.py:28: price = rates.quote_price(weight, destination, express=express)" in out
    assert ws.search("PARCEL_MAX_WEIGHT_KG", path="docs").startswith("no matches")
    assert ws.search("quote_price(", literal=True).count("\n") > 5
    assert ws.search("quote_price(").startswith("(not a valid regex")
    assert ws.search("todo", path="parcel/zones.py", ignore_case=True) == (
        "1 matches in 1 files\nparcel/zones.py:11: # TODO: load the tables from a CSV so ops can change them "
        "without a release")


def test_outline(ws):
    out = ws.outline("parcel/zones.py")
    assert "L33 def resolve_zone(destination: str) -> str — no docstring" in out
    assert 'L29 class UnknownZoneError(ValueError) — "Raised for a zone code or country that has no rate."' in out
    assert "L12 ZONES = …" in out
    assert "L6 ## Install" in ws.outline("README.md")
    with pytest.raises(WorkspaceError):
        ws.outline(".env.example")


def test_edits_are_staged(ws, repo):
    before = (repo / "README.md").read_text()
    out = ws.edit_file("README.md", "parcel quote 2.5 --zone FR", "parcel quote 2.5 --to FR")
    assert out.startswith("edited README.md (lines 29-29); now:") and "--to FR" in out
    assert (repo / "README.md").read_text() == before            # not on disk
    assert "--to FR" in ws.read_file("README.md")                 # but visible
    assert "README.md  (" in ws.list_files() and "[modified, staged]" in ws.list_files()
    assert "README.md:29: parcel quote 2.5 --to FR" in ws.search("--to FR", literal=True)
    with pytest.raises(WorkspaceError, match="not found.*closest line is"):
        ws.edit_file("README.md", "parcel  quote 9 --zone FR", "x")
    with pytest.raises(WorkspaceError, match=r"occurs 3 times .*lines"):
        ws.edit_file("docs/usage.md", "--zone", "--to")
    assert "3 replacements" in ws.edit_file("docs/usage.md", "--zone", "--to", replace_all=True)
    ws.edit_file("README.md", "parcel quote 2.5 --to FR", "parcel quote 2.5 --zone FR")  # undone
    assert [c[0] for c in ws.changes()] == ["docs/usage.md"]


def test_write_needs_a_read(ws):
    with pytest.raises(WorkspaceError, match="haven't read it"):
        ws.write_file("CHANGELOG.md", "# gone\n")
    ws.read_file("CHANGELOG.md")
    assert ws.write_file("CHANGELOG.md", "# Changelog\n").startswith("replaced CHANGELOG.md")
    assert ws.write_file("docs/adr/0003-weight-limit.md", "# 0003. Weight limit").startswith("created")
    assert ws.staged["docs/adr/0003-weight-limit.md"] == "# 0003. Weight limit\n"
    assert "[new, staged]" in ws.list_files("docs/adr")


def test_diff_applies_with_git(ws, repo):
    ws.edit_file("docs/configuration.md", "| `PARCEL_FUEL_SURCHARGE` |", "| `PARCEL_MAX_WEIGHT_KG` | `30` | max |\n| `PARCEL_FUEL_SURCHARGE` |")
    ws.write_file("docs/adr/0003-weight-limit.md", "# 0003. Weight limit\n")
    diff = ws.diff()
    assert "diff --git a/docs/adr/0003-weight-limit.md b/docs/adr/0003-weight-limit.md\nnew file mode 100644\n--- /dev/null" in diff
    assert "+| `PARCEL_MAX_WEIGHT_KG` | `30` | max |" in diff
    check = subprocess.run(["git", "apply", "--check", "-"], cwd=repo, input=diff, text=True, capture_output=True)
    assert check.returncode == 0, check.stderr
    assert ws.apply() == ["docs/adr/0003-weight-limit.md", "docs/configuration.md"]
    assert ws.staged == {} and (repo / "docs/adr/0003-weight-limit.md").exists()
    status = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout
    assert status.split() == ["M", "docs/configuration.md", "??", "docs/adr/0003-weight-limit.md"]


def test_over_mcp_in_process(repo):
    """The same tools through a real MCP client, plus git, and the client-only tools kept from the model."""
    async def run():
        async with FilesClient(server=create_server(repo)) as fs:
            assert set(fs.names) == {"list_files", "read_file", "search", "outline", "edit_file", "write_file",
                                     "git_log", "git_show", "git_diff", *CLIENT_TOOLS}
            assert not {t.name for t in fs.model_tools} & set(CLIENT_TOOLS)
            log = await fs.call("git_log", {"revision_range": "v0.3.0..HEAD"})
            assert log.count("Mira Kovač") == 2 and log.splitlines()[0].endswith("2026-10-12 Mira Kovač (HEAD -> main)")
            assert "(tag: v0.3.0)" in await fs.call("git_log", {"max_count": 5})
            show = await fs.call("git_show", {})
            assert "Add express delivery" in show and "parcel/cli.py" in show and "+    quote.add_argument(\"--to\"" in show
            stat = await fs.call("git_diff", {"base": "v0.3.0", "stat_only": True})
            assert "parcel/batch.py" in stat and "docs/" not in stat
            assert (await fs.call("git_diff", {"base": "--output=/tmp/x"})).startswith("error: bad base")
            assert (await fs.call("git_show", {"ref": "nope"})).startswith("error:")
            assert (await fs.call("read_file", {"path": "../x"})).startswith("error: '../x' is outside")
            assert (await fs.call("rm_rf")).startswith("error: no tool named")
            await fs.call("edit_file", {"path": "README.md", "old": "--zone FR", "new": "--to FR"})
            assert (await fs.call("staged_files")) == "modified README.md"
            assert "+    parcel quote 2.5 --to FR" in await fs.diff()
            assert await fs.apply() == ["README.md"] and await fs.diff() == ""
    asyncio.run(run())
    assert "--to FR" in (repo / "README.md").read_text()


def test_stdio_subprocess(repo):
    async def run():
        async with FilesClient(repo) as fs:
            assert "parcel/rates.py" in await fs.call("list_files", {"pattern": "rates.py"})
    asyncio.run(run())
