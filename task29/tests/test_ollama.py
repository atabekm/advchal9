import json

from opt import ollama


class FakeResponse:
    status_code = 200

    def __init__(self, chunks):
        self.chunks = chunks

    def iter_lines(self):
        return (json.dumps(c).encode() for c in self.chunks)


def test_streaming_collects_thinking_content_and_timings(monkeypatch):
    chunks = [
        {"message": {"thinking": "Let me "}},
        {"message": {"thinking": "check."}},
        {"message": {"content": '{"status": '}},
        {"message": {"content": '"unknown"}'}},
        {"message": {}, "done": True, "done_reason": "stop", "prompt_eval_count": 100, "eval_count": 20,
         "load_duration": 1e9, "prompt_eval_duration": 5e8, "eval_duration": 2e9},
    ]
    sent = {}

    def post(url, json, timeout, stream):
        sent.update(json)
        return FakeResponse(chunks)

    monkeypatch.setattr(ollama.requests, "post", post)
    seen = []
    r = ollama.Ollama("localhost:1").chat("m", [], think=True, on_token=lambda k, t: seen.append(k))
    assert sent["stream"] is True and sent["think"] is True
    assert r.thinking == "Let me check." and r.text == '{"status": "unknown"}'
    assert seen == ["thinking", "thinking", "content", "content"]
    assert r.eval_tps == 10 and r.ttft_s == 1.5 and r.done_reason == "stop"
