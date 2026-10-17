import pytest

from fileassist import scenarios


def test_every_scenario_builds():
    for name in scenarios.NAMES:
        sc = scenarios.by_name(name)
        assert sc.name == name and sc.goal and sc.checklist.startswith("How to do it well:")
    with pytest.raises(KeyError):
        scenarios.by_name("deploy")


def test_arguments_and_file_policy():
    assert "`resolve_zone`" in scenarios.by_name("usages", "resolve_zone").goal
    assert scenarios.by_name("adr", "We use SQLite.").goal.endswith("this decision: We use SQLite.")
    assert not scenarios.by_name("check").changes_files and scenarios.by_name("check-fix").changes_files
    assert "Don't change any files" in scenarios.by_name("check").checklist
    assert "Don't change any files" not in scenarios.by_name("check-fix").checklist


def test_goals_name_no_source_files():
    """The goals say what to achieve, not which code to open."""
    for name in scenarios.NAMES:
        goal = scenarios.by_name(name).goal
        assert "parcel/" not in goal and ".py" not in goal and "docs/" not in goal
