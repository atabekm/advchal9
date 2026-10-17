"""`fileassist serve`: the assistant behind a one-page web UI.

    GET  /                     the page (fileassist/static/index.html)
    GET  /scenarios            the preset goals, for the page's picker
    POST /runs                 {"scenario"?, "arg"?, "goal"?, "model"?} → {"id"}; starts a run on a fresh fixture
    GET  /runs/{id}/events     the run as server-sent events: each tool call as it happens, then "done"
    POST /runs/{id}/apply      write the staged changes to the run's project
    POST /runs/{id}/discard    drop them
    GET  /health               the default model and whether Ollama answers

A run lives in one task that keeps its filemcp session open until the user applies or discards the
changes (or the next run starts), so the staged diff stays where the model left it. Runs go one at
a time: there is one local model.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import fixture, runs, scenarios
from .agent import MAX_STEPS, Agent, Event, Run
from .files_client import FilesClient
from .llm import DEFAULT_MODEL, LocalLLM

STATIC = Path(__file__).resolve().parent / "static"
SHOWN = 4000   # characters of a tool result sent to the page
ARG_LABELS = {"usages": ("symbol", scenarios.DEFAULT_SYMBOL), "adr": ("decision", scenarios.DEFAULT_DECISION)}


class RunRequest(BaseModel):
    scenario: str | None = None
    arg: str | None = Field(default=None, max_length=500)
    goal: str | None = Field(default=None, max_length=2000)
    model: str | None = Field(default=None, max_length=100)


@dataclass
class Session:
    id: str
    goal: str
    root: Path
    events: list[dict] = field(default_factory=list)
    tick: asyncio.Event = field(default_factory=asyncio.Event)   # set when events grow, then replaced
    decision: asyncio.Future | None = None   # "apply" / "discard", set by the page
    outcome: asyncio.Future | None = None    # what applying or discarding did
    task: asyncio.Task | None = None
    done: bool = False

    def push(self, kind: str, **data) -> None:
        self.events.append({"kind": kind, **data})
        self.tick.set()
        self.tick = asyncio.Event()

    async def wait_beyond(self, n: int) -> None:
        while len(self.events) <= n:
            await self.tick.wait()


def event_json(e: Event) -> dict:
    d = {"step": e.step, "seconds": round(e.seconds, 1)}
    if e.kind == "call":
        d |= {"tool": e.tool, "arguments": e.arguments, "result": e.result[:SHOWN],
              "cut": len(e.result) > SHOWN, "error": e.result.startswith("error")}
    elif e.kind == "think":
        d["text"] = e.text[-1500:]
    elif e.kind == "review":
        d["text"] = "finish → the staged diff goes back to the model for a review"
    else:
        d["text"] = e.text
    return d


def run_json(run: Run, saved: Path) -> dict:
    return {"report": run.report, "diff": run.diff, "changed": run.changed, "finished": run.finished,
            "stop_reason": run.stop_reason, "model": run.model, "model_version": run.model_version,
            "steps": run.steps, "model_calls": run.model_calls, "seconds": round(run.seconds),
            "saved": str(saved.relative_to(runs.TASK_DIR)) if saved.is_relative_to(runs.TASK_DIR) else str(saved)}


def create_app(llm_factory: Callable[[str | None], LocalLLM] = LocalLLM,
               files_factory: Callable[[Path], FilesClient] = FilesClient,
               workspaces: Path = runs.WORKSPACES, runs_dir: Path = runs.RUNS_DIR,
               max_steps: int = MAX_STEPS) -> FastAPI:
    state: dict[str, Session] = {}
    current: list[Session] = []

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        for s in state.values():
            if s.task and not s.task.done():
                s.task.cancel()

    app = FastAPI(title="fileassist", lifespan=lifespan)

    async def work(s: Session, req: RunRequest, extra: str, read_only: bool, scenario: str) -> None:
        loop = asyncio.get_running_loop()
        try:
            async with files_factory(s.root) as fs:
                agent = Agent(fs, llm_factory(req.model or None), max_steps=max_steps, read_only=read_only,
                              on_event=lambda e: s.push(e.kind, **event_json(e)))
                run = await agent.run(s.goal, extra)
                saved = runs.save(run, s.root, scenario, runs_dir=runs_dir)
                s.decision, s.outcome = loop.create_future(), loop.create_future()
                s.push("done", **run_json(run, saved), root=str(s.root))
                s.done = True
                if not run.diff:
                    return
                try:
                    choice = await asyncio.wait_for(s.decision, timeout=3600)
                except TimeoutError:
                    choice = "discard"
                if choice == "apply":
                    written = await fs.apply()
                    s.outcome.set_result({"applied": written, "root": str(s.root)})
                else:
                    await fs.call("discard_staged")
                    s.outcome.set_result({"discarded": run.changed})
        except asyncio.CancelledError:
            raise
        except Exception as e:   # the page shows it instead of waiting forever
            s.push("error", text=f"{type(e).__name__}: {e}")
            s.done = True
        finally:
            if s.outcome and not s.outcome.done():
                s.outcome.set_result({"discarded": [], "note": "the run is closed"})

    @app.get("/", include_in_schema=False)
    async def page() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/scenarios")
    async def list_scenarios() -> list[dict]:
        out = []
        for name in scenarios.NAMES:
            sc = scenarios.by_name(name)
            label, default = ARG_LABELS.get(name, (None, None))
            out.append({"name": name, "title": sc.title, "goal": sc.goal, "changes_files": sc.changes_files,
                        "arg": label, "arg_default": default})
        return out

    @app.post("/runs")
    async def start(req: RunRequest) -> dict:
        if current and not current[0].done:
            raise HTTPException(409, "a run is in progress; wait for it to finish")
        if req.scenario:
            try:
                sc = scenarios.by_name(req.scenario, (req.arg or "").strip() or None)
            except KeyError:
                raise HTTPException(404, f"no scenario {req.scenario}") from None
            goal, extra, read_only, name = sc.goal, sc.checklist, not sc.changes_files, sc.name
        elif req.goal and req.goal.strip():
            goal, extra, read_only, name = req.goal.strip(), "", False, ""
        else:
            raise HTTPException(422, "give a scenario or a goal")
        if current and current[0].decision and not current[0].decision.done():
            current[0].decision.set_result("discard")   # a new run closes the last one's staged changes
        stamp = runs.stamp()
        root = await asyncio.to_thread(fixture.build, workspaces / f"{stamp}-{uuid.uuid4().hex[:4]}" / "parcel")
        s = Session(uuid.uuid4().hex[:12], goal, root)
        state[s.id] = s
        current[:] = [s]
        s.push("start", goal=goal, checklist=extra, root=str(root), read_only=read_only,
                     model=req.model or DEFAULT_MODEL, head=fixture.head(root)[:7])
        s.task = asyncio.create_task(work(s, req, extra, read_only, name))
        return {"id": s.id, "goal": goal, "root": str(root)}

    def session(run_id: str) -> Session:
        if run_id not in state:
            raise HTTPException(404, "no such run")
        return state[run_id]

    @app.get("/runs/{run_id}/events")
    async def events(run_id: str) -> StreamingResponse:
        s = session(run_id)

        async def stream() -> AsyncIterator[str]:
            i = 0
            while True:
                await s.wait_beyond(i)
                new = s.events[i:]
                i += len(new)
                for e in new:
                    yield f"event: {e['kind']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
                    if e["kind"] in ("done", "error"):
                        return

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    async def decide(run_id: str, choice: str) -> dict:
        s = session(run_id)
        if not s.done or s.decision is None:
            raise HTTPException(409, "the run hasn't finished")
        if s.decision.done():
            if s.outcome and s.outcome.done():
                return s.outcome.result() | {"again": True}
            raise HTTPException(409, "already decided")
        s.decision.set_result(choice)
        return await asyncio.wait_for(asyncio.shield(s.outcome), timeout=60)

    @app.post("/runs/{run_id}/apply")
    async def apply(run_id: str) -> dict:
        return await decide(run_id, "apply")

    @app.post("/runs/{run_id}/discard")
    async def discard(run_id: str) -> dict:
        return await decide(run_id, "discard")

    @app.get("/health")
    async def health() -> dict:
        llm = llm_factory(None)
        version = await asyncio.to_thread(llm.version)
        return {"model": llm.model, "version": version, "ollama": version != "?",
                "busy": bool(current and not current[0].done)}

    return app
