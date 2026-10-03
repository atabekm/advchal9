"""The web chat: a JSON API over ChatService, and the static page in web/.

  GET    /api/info                       model, retrieval mode, memory on/off, the documents
  GET    /api/sessions                   saved sessions, most recent first
  POST   /api/sessions                   a new, empty session
  GET    /api/sessions/{id}              its messages (replies with their data), memory and memory log
  DELETE /api/sessions/{id}
  POST   /api/sessions/{id}/messages     {"text": "..."} → one turn: the reply, the memory after it

A turn runs in FastAPI's thread pool. Turns run one at a time (the index store, the reranker and
the session's turn numbering are shared), the rest of the API stays responsive meanwhile.
"""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from indexer.embed import EmbedError

from .chat import ChatService
from .llm import LLMError
from .store import Session, SessionMissing

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class NewMessage(BaseModel):
    text: str


def _session(s: Session) -> dict:
    return {"id": s.id, "title": s.title, "created": s.created, "updated": s.updated, "turns": s.turns}


def create_app(service: ChatService, info: dict | None = None, web_dir: Path = WEB_DIR) -> FastAPI:
    app = FastAPI(title="rag chat")
    store = service.store
    turn_lock = threading.Lock()

    def session_or_404(session_id: str) -> Session:
        try:
            return store.session(session_id)
        except SessionMissing:
            raise HTTPException(404, f"no session {session_id}") from None

    def memory_view(session_id: str) -> dict:
        if not service.memory_on:
            return {"on": False}
        return {"on": True, **service.memory(session_id).to_dict(), "log": store.memory_log(session_id)}

    @app.get("/api/info")
    def get_info():
        c = service.config
        return {"model": service.llm.model, "mode": c.label, "threshold": c.threshold, "floor": c.floor,
                "memory": service.memory_on, "window": service.window, **(info or {})}

    @app.get("/api/sessions")
    def list_sessions():
        return [_session(s) for s in store.sessions()]

    @app.post("/api/sessions", status_code=201)
    def new_session():
        return _session(store.create_session())

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: str):
        s = session_or_404(session_id)
        messages = [{"turn": m.turn, "role": m.role, "text": m.text, "data": m.data, "created": m.created}
                    for m in store.messages(session_id)]
        return {"session": _session(s), "messages": messages, "memory": memory_view(session_id)}

    @app.delete("/api/sessions/{session_id}", status_code=204)
    def delete_session(session_id: str):
        try:
            store.delete_session(session_id)
        except SessionMissing:
            raise HTTPException(404, f"no session {session_id}") from None

    @app.post("/api/sessions/{session_id}/messages")
    def post_message(session_id: str, body: NewMessage):
        session_or_404(session_id)
        if not body.text.strip():
            raise HTTPException(400, "empty message")
        with turn_lock:
            try:
                turn = service.turn(session_id, body.text)
            except (LLMError, EmbedError) as e:
                raise HTTPException(502, str(e)) from None
        return {"session": _session(store.session(session_id)), "turn": turn.turn,
                "user": {"turn": turn.turn, "role": "user", "text": turn.message, "data": {}},
                "reply": {"turn": turn.turn, "role": "assistant", "text": turn.text, "data": turn.data()},
                "memory": memory_view(session_id)}

    if web_dir.is_dir():
        app.mount("/static", StaticFiles(directory=web_dir), name="static")

        @app.get("/", include_in_schema=False)
        def index():
            return FileResponse(web_dir / "index.html")

    return app


def serve(service: ChatService, host: str = "127.0.0.1", port: int = 8025, info: dict | None = None) -> None:
    import uvicorn

    service.agent.pipeline.reranker.encoder  # load the cross-encoder now, not on the first message
    uvicorn.run(create_app(service, info), host=host, port=port, log_level="warning")
