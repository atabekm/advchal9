import subprocess
import sys

import pytest

from fileassist import fixture


@pytest.fixture(scope="module")
def repo(tmp_path_factory):
    return fixture.build(tmp_path_factory.mktemp("fx") / "parcel")


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout


def test_same_hashes_every_build(repo, tmp_path):
    assert fixture.head(fixture.build(tmp_path / "again")) == fixture.head(repo)


def test_history(repo):
    subjects = git(repo, "log", "--format=%s", "v0.3.0..HEAD").splitlines()
    assert len(subjects) == 4 and subjects[0].startswith("Add express delivery")
    assert git(repo, "tag").split() == ["v0.1.0", "v0.2.0", "v0.3.0"]
    assert git(repo, "status", "--porcelain") == ""


def test_last_commit_leaves_the_docs_behind(repo):
    changed = git(repo, "show", "--name-only", "--format=", "HEAD").split()
    assert all(p.startswith(("parcel/", "tests/")) for p in changed)
    assert "--zone" in (repo / "README.md").read_text()
    assert "PARCEL_MAX_WEIGHT_KG" not in (repo / "docs/configuration.md").read_text()


def test_fixture_tests_pass(repo):
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"], cwd=repo,
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout[-2000:]


def test_refuses_a_non_empty_dir(repo):
    with pytest.raises(fixture.FixtureError):
        fixture.build(repo)
