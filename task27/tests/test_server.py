import re
from pathlib import Path

from fastapi.testclient import TestClient

from rag.llm import LLMError
from rag.server import WEB_DIR, create_app
from tests.test_memory import MemoryLLM, _service


def _client(llm, memory=True):
    svc, ret = _service(llm, memory)
    return TestClient(create_app(svc, {"documents": [{"source": "Gutless.pdf", "title": "Gutless"}]})), svc


def _llm():
    return MemoryLLM([("question", "Gutless fat loss rules?"), ("meta", "")],
                     ['{"ops": [{"op": "set_goal", "text": "Lose 8 kg"}, {"op": "add", "field": "constraints", "text": "short"}]}',
                      '{"ops": []}'])


def test_a_conversation_through_the_api():
    client, svc = _client(_llm())
    info = client.get("/api/info").json()
    assert info["memory"] is True and info["mode"] == "base" and info["documents"][0]["source"] == "Gutless.pdf"

    sid = client.post("/api/sessions").json()["id"]
    r = client.post(f"/api/sessions/{sid}/messages", json={"text": "I want to lose 8 kg. Rules?"})
    assert r.status_code == 200
    body = r.json()
    assert body["turn"] == 1 and body["reply"]["data"]["status"] == "answer"
    assert body["reply"]["data"]["sources"][0]["source"] == "Gutless.pdf"
    assert body["memory"]["goal"] == "Lose 8 kg" and body["memory"]["log"][1]["text"] == "short"
    assert body["session"]["title"] == "I want to lose 8 kg. Rules?" and body["session"]["turns"] == 1

    client.post(f"/api/sessions/{sid}/messages", json={"text": "thanks"})
    s = client.get(f"/api/sessions/{sid}").json()
    assert [(m["turn"], m["role"]) for m in s["messages"]] == [(1, "user"), (1, "assistant"), (2, "user"), (2, "assistant")]
    assert s["messages"][3]["data"]["status"] == "meta" and s["memory"]["constraints"][0]["id"] == "k1"
    assert [x["id"] for x in client.get("/api/sessions").json()] == [sid]


def test_errors_map_to_status_codes():
    client, svc = _client(_llm())
    assert client.get("/api/sessions/nope").status_code == 404
    assert client.post("/api/sessions/nope/messages", json={"text": "hi"}).status_code == 404
    sid = client.post("/api/sessions").json()["id"]
    assert client.post(f"/api/sessions/{sid}/messages", json={"text": "  "}).status_code == 400

    def down(*a, **k):
        raise LLMError("ollama unreachable at http://localhost:11434")

    svc.condenser.llm.chat = down
    r = client.post(f"/api/sessions/{sid}/messages", json={"text": "Rules?"})
    # the condenser falls back to the raw message, then the answer call fails: 502, nothing saved
    assert r.status_code == 502 and "ollama unreachable" in r.json()["detail"]
    assert client.get(f"/api/sessions/{sid}").json()["messages"] == []

    assert client.delete(f"/api/sessions/{sid}").status_code == 204
    assert client.delete(f"/api/sessions/{sid}").status_code == 404


def test_memory_off_is_reported():
    client, _ = _client(MemoryLLM([("question", "Rules?")], []), memory=False)
    sid = client.post("/api/sessions").json()["id"]
    body = client.post(f"/api/sessions/{sid}/messages", json={"text": "Rules?"}).json()
    assert body["memory"] == {"on": False} and "memory" not in body["reply"]["data"]
    assert client.get("/api/info").json()["memory"] is False


def test_the_page_is_served_and_its_ids_exist():
    client, _ = _client(_llm())
    html = client.get("/").text
    assert "<title>Task 27" in html and client.get("/static/app.js").status_code == 200
    # every element app.js looks up by id is in the page
    ids = set(re.findall(r'id="([^"]+)"', html))
    used = set(re.findall(r"\$\('([^']+)'\)", (WEB_DIR / "app.js").read_text()))
    assert used and used <= ids, used - ids


def test_every_class_the_stylesheet_styles_is_used():
    css = (WEB_DIR / "styles.css").read_text()
    source = (WEB_DIR / "index.html").read_text() + (WEB_DIR / "app.js").read_text()
    classes = set(re.findall(r"\.([a-z][a-z-]*)\b(?![^{]*;)", re.sub(r"/\*.*?\*/", "", css, flags=re.S)))
    unused = {c for c in classes if not re.search(rf"\b{c}\b", source)}
    assert not unused, unused
