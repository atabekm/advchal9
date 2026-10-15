"""The PR comment, through `gh api`: created once, then edited in place on every run.

In the Actions job `gh` authenticates with the job's GITHUB_TOKEN (GH_TOKEN in the environment);
from a terminal, with your own login.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .diff import GhError
from .report import MARKER


def gh(root: Path, *args: str, body: dict | None = None) -> str:
    r = subprocess.run(["gh", *args] + (["--input", "-"] if body is not None else []), cwd=root,
                       input=json.dumps(body) if body is not None else None, capture_output=True, text=True)
    if r.returncode != 0:
        raise GhError(f"gh {' '.join(args[:3])}: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def repo_url(root: Path) -> str:
    """https://github.com/owner/name for the `origin` remote, or "" when it isn't GitHub."""
    r = subprocess.run(["git", "remote", "get-url", "origin"], cwd=root, capture_output=True, text=True)
    m = re.search(r"github\.com[:/]([\w.-]+/[\w.-]+?)(?:\.git)?$", r.stdout.strip())
    return f"https://github.com/{m.group(1)}" if m else ""


def find_comment(root: Path, number: int) -> int | None:
    out = gh(root, "api", "--paginate", f"repos/{{owner}}/{{repo}}/issues/{number}/comments",
             "--jq", ".[] | {id, body} | @json")
    for line in out.splitlines():
        c = json.loads(line)
        if c.get("body", "").startswith(MARKER):
            return c["id"]
    return None


def post(root: Path, number: int, markdown: str) -> str:
    """Create or update the review comment; returns its URL."""
    existing = find_comment(root, number)
    if existing:
        out = gh(root, "api", "-X", "PATCH", f"repos/{{owner}}/{{repo}}/issues/comments/{existing}",
                 body={"body": markdown})
    else:
        out = gh(root, "api", "-X", "POST", f"repos/{{owner}}/{{repo}}/issues/{number}/comments",
                 body={"body": markdown})
    return json.loads(out).get("html_url", "")
