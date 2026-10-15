"""The HTTP service: `POST /ask` and a one-page web UI.

    GET  /            the page (support/static/index.html)
    POST /ask         {"question", "ticket_id"?, "user_id"?} → the answer, its sources and the context used
    GET  /context     ?ticket_id=&user_id= → the CRM context the answer would use, without the model
    GET  /tickets     the CRM's tickets, for the page's picker
    GET  /users       the CRM's users, for the page's picker
    GET  /health      the model, the index, the MCP tools

One MCP session (`supportmcp` over stdio) lives as long as the app. Answers are made one at a
time: there is one local model, and a second request would only wait for it inside Ollama.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .assistant import Assistant, ContextError, answer_json
from .crm_client import CRMClient, parse_rows
from .embed import EmbedError
from .llm import LLMError

STATIC = Path(__file__).resolve().parent / "static"

# Builds the assistant inside the app's lifespan; the default starts supportmcp and opens the index.
Factory = Callable[[], "AssistantContext"]


class AssistantContext:
    """`async with` → an Assistant whose MCP session stays open until the app stops."""

    def __init__(self, make: Callable[[CRMClient], Assistant], crm: CRMClient | None = None):
        self.make = make
        self.crm = crm or CRMClient()

    async def __aenter__(self) -> Assistant:
        await self.crm.__aenter__()
        return self.make(self.crm)

    async def __aexit__(self, *exc) -> None:
        await self.crm.__aexit__(*exc)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    ticket_id: str | None = None
    user_id: str | None = None


def create_app(factory: Factory) -> FastAPI:
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with factory() as assistant:
            state["assistant"] = assistant
            state["lock"] = asyncio.Lock()
            yield

    app = FastAPI(title="Flowdesk support assistant", lifespan=lifespan)

    async def locked(fn: Callable[[Assistant], Awaitable]):
        async with state["lock"]:  # the MCP session and the model, one request at a time
            return await fn(state["assistant"])

    @app.get("/", include_in_schema=False)
    async def page() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.post("/ask")
    async def ask(req: AskRequest) -> dict:
        try:
            answer = await locked(lambda a: a.ask(req.question.strip(), req.ticket_id or None, req.user_id or None))
        except ContextError as e:
            raise HTTPException(404, str(e)) from e
        except (LLMError, EmbedError) as e:
            raise HTTPException(503, str(e)) from e
        return answer_json(answer)

    @app.get("/context")
    async def context(ticket_id: str | None = None, user_id: str | None = None) -> dict:
        try:
            ctx = await locked(lambda a: a.context(ticket_id or None, user_id or None))
        except ContextError as e:
            raise HTTPException(404, str(e)) from e
        return {"ticket_id": ctx.ticket_id, "user_id": ctx.user_id,
                "context": [{"name": n, "text": t} for n, t in ctx.blocks()]}

    @app.get("/tickets")
    async def tickets() -> list[dict]:
        rows = parse_rows(await locked(lambda a: a.crm.call("search_tickets", {"limit": 100})))
        keys = ["id", "status", "priority", "user", "created", "area", "subject"]
        out = []
        for r in rows:
            item = dict(zip(keys, r[:6] + [" · ".join(r[6:])], strict=True))
            item["user_id"], _, item["user_name"] = item.pop("user").partition(" ")
            out.append(item)
        return out

    @app.get("/users")
    async def users() -> list[dict]:
        rows = parse_rows(await locked(lambda a: a.crm.call("list_users", {})))
        return [dict(zip(["id", "name", "organization", "role", "status"], r, strict=False)) for r in rows]

    @app.get("/health")
    async def health() -> dict:
        a: Assistant = state["assistant"]
        return {"model": a.llm.model, "chunks": len(a.retriever.store.matrix()[0]), "mcp_tools": a.crm.names}

    return app


def default_factory(db: Path, model: str | None = None) -> Factory:
    from .llm import LocalLLM
    from .retrieve import Retriever

    retriever = Retriever(db)  # fails now, not on the first request, if there's no index
    retriever.search("sign in", k=1)  # loads the reranker (~7 s) before the first customer waits for it
    return lambda: AssistantContext(lambda crm: Assistant(retriever, crm, LocalLLM(model)))
