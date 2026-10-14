import json

import pytest

from devreview import evaluate as ev
from devreview.review import Reviewer

from .fakes import commit, init_repo
from .test_review import ScriptedLLM, finding


@pytest.fixture
def repo(tmp_path):
    init_repo(tmp_path)
    (tmp_path / "task1").mkdir()
    filler = "".join(f"\n\ndef f{i}():\n    return {i}\n" for i in range(5))
    (tmp_path / "task1" / "store.py").write_text(
        f"def first(rows, k):\n    return rows[:k]\n{filler}\n\ndef last(rows):\n    return rows[-1]\n")
    commit(tmp_path, "base")
    return tmp_path


CASE = {"id": "obo", "title": "first k", "defect": "k - 1",
        "edits": [{"file": "task1/store.py", "find": "rows[:k]", "replace": "rows[:k - 1]"}],
        "expect": {"file": "task1/store.py", "kinds": ["bug"], "keywords": ["k - 1"]}}
CLEAN = {"id": "clean", "title": "doc", "defect": None, "expect": None,
         "edits": [{"file": "task1/store.py", "find": "def last(rows):\n", "replace": "def last(rows):\n    # the newest row\n"}]}


def test_make_patch_refuses_an_ambiguous_edit(repo):
    patch = ev.make_patch(repo, CASE)
    assert patch.startswith("diff --git a/task1/store.py b/task1/store.py\n--- a/task1/store.py\n")
    assert "-    return rows[:k]\n+    return rows[:k - 1]\n" in patch
    bad = CASE | {"edits": [{"file": "task1/store.py", "find": "rows", "replace": "xs"}]}
    with pytest.raises(ValueError, match="occurs 4 times"):
        ev.make_patch(repo, bad)


def test_found_needs_the_reason_located_needs_the_line(repo):
    llm = ScriptedLLM(
        [finding(line=2, title="Returns k - 1 rows"), finding(line=26, code="return rows[-1]", title="Crashes on empty"),
         finding(kind="recommendation", line=0, title="Add a test")],
        [finding(line=0, title="It is k - 1 now")],  # the reason, no line
        [finding(line=2, title="Something is off here")],  # the line, another reason
        [finding(line=2, title="k - 1 rows", kind="recommendation")],  # the reason, a kind that doesn't count
        [finding(kind="recommendation", line=26, title="Fine, maybe a test")],
    )
    r = ev.run(repo, Reviewer(llm), [CASE, CASE, CASE, CASE, CLEAN])
    assert (r[0].found, r[0].match["title"], [n["title"] for n in r[0].noise], r[0].recommendations) == (
        True, "Returns k - 1 rows", ["Crashes on empty"], 1)
    assert r[1].found and r[1].match["line"] is None
    assert (r[2].found, r[2].located, r[2].match["title"], r[2].noise) == (False, True, "Something is off here", [])
    assert (r[3].found, r[3].located, r[3].noise, r[3].recommendations) == (False, False, [], 1)
    assert r[4].found is None and not r[4].noise and r[4].recommendations == 1
    text = ev.summary(r)
    assert "defects found     2/4" in text and "defects located   3/4" in text and "clean PRs quiet   1/1" in text
    table = ev.table(r)
    assert "| obo | k - 1 | located |" in table and "| obo | k - 1 | **missed** |" in table


def test_cases_file_is_well_formed():
    cases = ev.load()
    assert len({c["id"] for c in cases}) == len(cases)
    for c in cases:
        assert c["edits"] and all({"file", "find", "replace"} <= set(e) for e in c["edits"])
        if c["expect"]:
            assert c["expect"]["file"] in {e["file"] for e in c["edits"]} and c["expect"]["kinds"]
    json.dumps(cases)


def test_rescore_a_saved_run(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(ev, "RESULTS", tmp_path / "results")
    llm = ScriptedLLM([finding(line=2, title="Returns `k - 1` rows")], [finding(line=2, title="Wrong")])
    results = ev.run(repo, Reviewer(llm), [CASE, CASE])
    assert [r.found for r in results] == [True, False] and results[0].anchors == [2]
    path = ev.save(results, {})
    again = ev.rescore(path, [CASE])
    assert [(r.found, r.located) for r in again] == [(True, True), (False, True)]
    assert "defects found     1/2" in json.loads(path.read_text())["summary"]
