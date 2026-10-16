"""The fixture project: "parcel", a small shipping-cost library with planted problems.

`fixture/history.toml` lists its commits; each one copies a directory of full files over the tree.
`build(dest)` replays them into a fresh git repository with fixed authors, dates and config, so the
commit hashes are the same on every machine and every run.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import tomllib
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixture"


class FixtureError(RuntimeError):
    pass


def history(fixture_dir: Path = FIXTURE_DIR) -> list[dict]:
    with open(fixture_dir / "history.toml", "rb") as f:
        return tomllib.load(f)["commit"]


def _git(dest: Path, *args: str, env: dict | None = None) -> str:
    base = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(dest),  # no user config, hooks or templates
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "LC_ALL": "C",
    }
    r = subprocess.run(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false",
                        "-c", "core.autocrlf=false", "-c", "core.fileMode=true", *args],
                       cwd=dest, env=base | (env or {}), capture_output=True, text=True)
    if r.returncode != 0:
        raise FixtureError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def build(dest: Path | str, fixture_dir: Path = FIXTURE_DIR) -> Path:
    """Build the fixture into `dest`, which must not exist or be empty. Returns its path."""
    dest = Path(dest).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise FixtureError(f"{dest} is not empty")
    dest.mkdir(parents=True, exist_ok=True)
    _git(dest, "init", "-q")
    for c in history(fixture_dir):
        src = fixture_dir / c["dir"]
        for f in sorted(p for p in src.rglob("*") if p.is_file()):
            target = dest / f.relative_to(src)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f.read_bytes())
            target.chmod(0o644)
        name, email = c["author"].rsplit(" <", 1)
        env = {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email.rstrip(">"),
               "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email.rstrip(">"),
               "GIT_AUTHOR_DATE": c["date"], "GIT_COMMITTER_DATE": c["date"]}
        _git(dest, "add", "-A")
        _git(dest, "commit", "-q", "-m", c["message"], env=env)
        if c.get("tag"):
            _git(dest, "tag", c["tag"])
    return dest


def build_temp(prefix: str = "parcel-") -> Path:
    """A fresh build in a new temporary directory (the caller removes it with `remove`)."""
    return build(Path(tempfile.mkdtemp(prefix=prefix)) / "parcel")


def remove(path: Path) -> None:
    shutil.rmtree(path.parent if path.name == "parcel" and path.parent.name.startswith("parcel-") else path,
                  ignore_errors=True)


def head(dest: Path) -> str:
    return _git(dest, "rev-parse", "HEAD").strip()
