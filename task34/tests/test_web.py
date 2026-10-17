"""The web service with a scripted model and filemcp in process: start a run, stream it, apply or discard."""

import json

import pytest
from fastapi.testclient import TestClient

from fileassist.files_client import FilesClient
from fileassist.web import create_app
from filemcp.server import create_server
from test_agent import ScriptedLLM, call

EDIT = [call("read_file", path=".env.example"),
        call("insert_lines", path=".env.example", after="3", text="PARCEL_MAX_WEIGHT_KG=30"),
        call("finish", report="Added the setting."), call("finish", report="Added `PARCEL_MAX_WEIGHT_KG`.")]


@pytest.fixture
def make(tmp_path):
    def make(replies):
        app = create_app(llm_factory=lambda model: ScriptedLLM(list(replies)),
                         files_factory=lambda root: FilesClient(server=create_server(root)),
                         workspaces=tmp_path / "ws", runs_dir=tmp_path / "runs")
        return TestClient(app)
    return make


def events(client, run_id):
    out = []
    with client.stream("GET", f"/runs/{run_id}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                out.append(json.loads(line[6:]))
    return out


def test_a_run_streams_its_calls_and_applies_the_diff(make):
    with make(EDIT) as client:
        assert {s["name"] for s in client.get("/scenarios").json()} >= {"usages", "update-docs", "adr"}
        run = client.post("/runs", json={"goal": "Document the max weight."}).json()
        got = events(client, run["id"])
        kinds = [e["kind"] for e in got]
        assert kinds[0] == "start" and kinds[-1] == "done" and kinds.count("call") == 3   # list_files + 2
        assert "review" in kinds
        done = got[-1]
        assert done["report"] == "Added `PARCEL_MAX_WEIGHT_KG`." and "+PARCEL_MAX_WEIGHT_KG=30" in done["diff"]
        assert client.post("/runs", json={"goal": "again"}).status_code != 409   # finished: a new run may start
        # the second run closed the first one's staged changes
        assert "discarded" in client.post(f"/runs/{run['id']}/apply").json()


def test_apply_writes_the_files(make, tmp_path):
    with make(EDIT) as client:
        run = client.post("/runs", json={"goal": "Document the max weight."}).json()
        events(client, run["id"])
        out = client.post(f"/runs/{run['id']}/apply").json()
        assert out["applied"] == [".env.example"]
        assert "PARCEL_MAX_WEIGHT_KG=30" in (tmp_path / run["root"] / ".env.example").read_text()
        assert client.post(f"/runs/{run['id']}/apply").json()["again"] is True


def test_discard_leaves_the_files(make, tmp_path):
    with make(EDIT) as client:
        run = client.post("/runs", json={"goal": "Document the max weight."}).json()
        events(client, run["id"])
        assert client.post(f"/runs/{run['id']}/discard").json()["discarded"] == ["modified .env.example"]
        assert "MAX_WEIGHT" not in (tmp_path / run["root"] / ".env.example").read_text()


def test_a_read_only_scenario_and_bad_requests(make):
    with make([call("edit_file", path="README.md", old="# parcel", new="# x"), call("finish", report="r")]) as client:
        run = client.post("/runs", json={"scenario": "usages", "arg": "resolve_zone"}).json()
        assert "resolve_zone" in run["goal"]
        got = events(client, run["id"])
        assert got[0]["read_only"] is True and got[-1]["diff"] == ""
        assert client.post("/runs", json={}).status_code == 422
        assert client.post("/runs", json={"scenario": "nope"}).status_code == 404
        assert client.get("/runs/nope/events").status_code == 404
