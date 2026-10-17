"""The eval checks against hand-made answers: a right one passes every check, a wrong one doesn't."""

import pytest

from fileassist import evaluate, fixture
from fileassist.agent import Run
from filemcp.workspace import Workspace

CASES = {c["id"]: c for c in evaluate.load_cases()}


@pytest.fixture
def ws(tmp_path):
    return Workspace(fixture.build(tmp_path / "parcel"))


def finish(ws: Workspace, report: str = "") -> Run:
    run = Run(goal="", model="hand", report=report, diff=ws.diff())
    ws.apply()
    return run


def failed(case: str, run: Run, ws: Workspace) -> list[str]:
    return [c.name for c in evaluate.check(CASES[case], run, ws.root) if not c.ok]


def test_every_case_has_a_goal_and_checks():
    for case in CASES.values():
        goal, _, _ = evaluate.goal_of(case)
        assert goal and case["checks"], case["id"]


def test_document_env_var(ws):
    ws.read_file("docs/configuration.md")
    ws.insert_lines("docs/configuration.md", "8", "| `PARCEL_MAX_WEIGHT_KG` | `30` | heaviest parcel, in kg |")
    ws.insert_lines(".env.example", "3", "PARCEL_MAX_WEIGHT_KG=30")
    assert failed("document-env-var", finish(ws), ws) == []


def test_document_env_var_catches_a_replaced_line_and_a_row_outside_the_table(ws):
    ws.edit_file(".env.example", "PARCEL_FUEL_SURCHARGE=0.00", "PARCEL_MAX_WEIGHT_KG=30")
    ws.insert_lines("docs/configuration.md", "9", "| `PARCEL_MAX_WEIGHT_KG` | `30` | heaviest parcel |")
    bad = failed("document-env-var", finish(ws), ws)
    assert "deletes no line of .env.example" in bad
    assert any(b.startswith("docs/configuration.md matches") for b in bad)


def test_usages(ws):
    report = ("parcel/rates.py:21 definition; parcel/__init__.py:4 re-export; parcel/api.py:28 call; "
              "parcel/batch.py:8 import as qp; parcel/cli.py:28 call; tests/test_cli.py:20 mock string")
    assert failed("usages-quote_price", finish(ws, report), ws) == []
    assert "report mentions qp" in failed("usages-quote_price", finish(ws, report.replace(" as qp", "")), ws)


def test_changelog(ws):
    ws.edit_file("CHANGELOG.md", "## [Unreleased]\n", """## [Unreleased]

### Added
- Express delivery: `quote_price(..., express=True)` and `parcel quote --express`, at 1.5 times the price.
- `PARCEL_MAX_WEIGHT_KG`: heavier parcels raise `WeightLimitError`.
- `quote_many()` for batch quotes.

### Changed
- **Breaking:** `parcel quote --zone` is now `--to`.

### Fixed
- The remote surcharge is rounded to cents before the fuel surcharge.
""")
    assert failed("changelog", finish(ws), ws) == []


def test_changelog_catches_a_touched_release(ws):
    ws.edit_file("CHANGELOG.md", "- The `parcel quote` command.", "- The `parcel quote` command (now `--to`).")
    bad = failed("changelog", finish(ws), ws)
    assert "deletes no line of CHANGELOG.md" in bad and "[Unreleased] has express" in bad


def test_check_fix_runs_the_projects_tests(ws):
    ws.read_file("parcel/batch.py")
    ws.write_file("parcel/batch.py", "this is not python\n")
    names = {c.name: c.ok for c in evaluate.check(CASES["check-fix"], finish(ws), ws.root)}
    assert names["the project's tests pass"] is False
    assert names["parcel/batch.py has no print("] is True


def test_summary_table():
    r = evaluate.Result("a", "m", 1, True, [evaluate.Check("x", True), evaluate.Check("y", False)], 5, 30.0)
    table = evaluate.summary([r], ["m"], ["a"])
    assert "| a | 1/1 · 50 % checks · 5 calls · 30 s |" in table
