"""Where a run goes: results/runs/<time>-<slug>/ with the transcript, the report and the diff."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from .agent import Run

TASK_DIR = Path(__file__).resolve().parent.parent
RUNS_DIR = TASK_DIR / "results" / "runs"
WORKSPACES = TASK_DIR / "workspace"


def slug(text: str, n: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n].rstrip("-") or "run"


def stamp() -> str:
    return datetime.now().strftime("%Y%m%dT%H%M%S")


def save(run: Run, root: Path, scenario: str = "", runs_dir: Path = RUNS_DIR) -> Path:
    out = runs_dir / f"{stamp()}-{slug(scenario or run.goal)}"
    out.mkdir(parents=True, exist_ok=True)
    data = run.to_dict() | {"root": str(root), "scenario": scenario}
    (out / "transcript.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    (out / "report.md").write_text(run.report.rstrip() + "\n")
    (out / "changes.diff").write_text(run.diff)
    return out
