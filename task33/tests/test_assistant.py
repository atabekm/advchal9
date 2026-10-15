import asyncio

import pytest
from fastapi.testclient import TestClient

from support.assistant import Assistant, ContextError, check_citations, search_query, split_agent_note
from support.crm_client import CRMClient
from support.llm import Reply
from support.retrieve import Hit
from support.service import AssistantContext, create_app
from supportmcp.crm import CRM
from supportmcp.server import DEFAULT_DATA, create_server


class FakeRetriever:
    def __init__(self):
        self.queries = []
        self.store = type("S", (), {"matrix": lambda self: ([1, 2, 3], None)})()

    def search(self, query, k=5):
        self.queries.append(query)
        return [Hit(1, "kb/sign-in.md#3", "kb/sign-in.md", "Signing in › Account lockout", "Locked for 30 min.", 0.8),
                Hit(2, "kb/faq.md#0", "kb/faq.md", "FAQ", "Check the error code.", 0.7)]


class FakeLLM:
    model = "fake"

    def __init__(self, text="Your account is locked [1]. See [7].\n\nAgent note: locked (evidence: LOCKED)"):
        self.text = text
        self.messages = []

    def chat(self, messages):
        self.messages.append(messages)
        return Reply(self.text, prompt_tokens=100, completion_tokens=20, seconds=0.1)


def crm_client():
    return CRMClient(server=create_server(CRM.load(DEFAULT_DATA)))


def run(coro):
    return asyncio.run(coro)


def test_ticket_brings_its_user_history_and_steers_the_search():
    async def go():
        async with crm_client() as crm:
            retriever, llm = FakeRetriever(), FakeLLM()
            a = await Assistant(retriever, crm, llm).ask("Why isn't authorization working?", ticket_id="t1001")
            return a, retriever, llm
    a, retriever, llm = run(go())
    assert [n for n, _, _ in a.crm_calls] == ["get_ticket", "get_user", "list_user_tickets"]
    assert a.crm_calls[2][1] == {"user": "u_102", "exclude_ticket": "T-1001"}
    assert (a.context.ticket_id, a.context.user_id) == ("T-1001", "u_102")
    query = retriever.queries[0]
    assert query.startswith("Why isn't authorization working?. Can't log in. sign-in. error AUTH_423_LOCKED")
    assert "AUTH_401_BAD_PASSWORD" in query and "account locked" in query
    assert "integration disconnected" not in query  # Brightpath's Slack is not Tom's problem
    prompt = llm.messages[0][1]["content"]
    assert "TICKET\nticket T-1001" in prompt and "account status: LOCKED" in prompt
    assert "EARLIER TICKETS" in prompt and "T-0987" in prompt
    assert "[1] kb/sign-in.md › Signing in › Account lockout" in prompt
    assert a.text == "Your account is locked [1]. See."  # [7] points at nothing
    assert a.agent_note == "locked (evidence: LOCKED)"
    assert [h.rank for h in a.sources] == [1]


def test_user_only_and_no_context():
    async def go():
        async with crm_client() as crm:
            assistant = Assistant(FakeRetriever(), crm, FakeLLM("General answer [2]."))
            by_email = await assistant.ask("What should I do?", user_id="alex@kitelabs.dev")
            anonymous = await assistant.ask("What should I do?")
            return by_email, anonymous, assistant.llm.messages
    by_email, anonymous, messages = run(go())
    assert by_email.context.user_id == "u_107" and by_email.context.ticket == ""
    assert "API_KEY_INVALID" in by_email.query and "API key revoked" in by_email.query
    assert [n for n, _, _ in anonymous.crm_calls] == []
    assert anonymous.query == "What should I do?"
    assert "CUSTOMER CONTEXT (from the CRM, live)\nnone:" in messages[1][1]["content"]
    assert anonymous.agent_note == "" and anonymous.cited == [2]


def test_unknown_ticket_is_a_context_error():
    async def go():
        async with crm_client() as crm:
            with pytest.raises(ContextError, match="no ticket"):
                await Assistant(FakeRetriever(), crm, FakeLLM()).ask("hi", ticket_id="T-9999")
    run(go())


def test_cli_reports_an_unknown_ticket(capsys):
    from support.cli import main
    assert main(["context", "--ticket", "T-9999"]) == 1
    assert "error: no ticket 'T-9999'" in capsys.readouterr().err


def test_search_query_without_error_code():
    from support.assistant import Context
    ctx = Context(ticket="ticket T-1003 · status open · priority normal · area desktop app\n"
                         "subject: Desktop app keeps logging me out\nerror code attached by the app: none\n"
                         "environment: desktop, version 3.4.0, macOS 26.0")
    assert search_query("Why?", ctx) == ("Why?. Desktop app keeps logging me out. desktop app. "
                                         "desktop, version 3.4.0, macOS 26.0")


@pytest.mark.parametrize("raw, body, note", [
    ("Fix it.\n\nAgent note: cause (evidence: x)", "Fix it.", "cause (evidence: x)"),
    ("Fix it.\n\n---\n**Agent note:** cause", "Fix it.", "cause"),
    ("Fix it.", "Fix it.", ""),
])
def test_split_agent_note(raw, body, note):
    assert split_agent_note(raw) == (body, note)


def test_check_citations():
    assert check_citations("A [1, 9]. B [3] .", 2) == ("A [1]. B.", [1])


# --- the HTTP service ---

@pytest.fixture
def client():
    llm = FakeLLM()
    app = create_app(lambda: AssistantContext(lambda crm: Assistant(FakeRetriever(), crm, llm), crm=crm_client()))
    with TestClient(app) as c:
        yield c


def test_ask_endpoint(client):
    r = client.post("/ask", json={"question": "Why isn't authorization working?", "ticket_id": "T-1001"})
    assert r.status_code == 200
    body = r.json()
    assert body["ticket_id"] == "T-1001" and body["user_id"] == "u_102"
    assert body["answer"].startswith("Your account is locked [1]")
    assert body["agent_note"].startswith("locked")
    assert [c["name"] for c in body["context"]] == ["TICKET", "CUSTOMER AND ORGANIZATION", "EARLIER TICKETS"]
    assert [p["cited"] for p in body["passages"]] == [True, False]
    assert [c["tool"] for c in body["crm_calls"]] == ["get_ticket", "get_user", "list_user_tickets"]
    assert client.post("/ask", json={"question": "x", "ticket_id": "T-1"}).status_code == 404
    assert client.post("/ask", json={"question": ""}).status_code == 422


def test_pickers_context_page_and_health(client):
    tickets = client.get("/tickets").json()
    assert len(tickets) == 12
    assert tickets[0] == {"id": "T-1001", "status": "open", "priority": "high", "created": "2026-10-15",
                          "area": "sign-in", "subject": "Can't log in", "user_id": "u_102", "user_name": "Tom Becker"}
    users = client.get("/users").json()
    assert users[0] == {"id": "u_101", "name": "Maria Lopez", "organization": "Acme Logistics", "role": "member",
                        "status": "active"}
    ctx = client.get("/context", params={"user_id": "u_109"}).json()
    assert ctx["user_id"] == "u_109" and "INVITED" in ctx["context"][0]["text"]
    assert client.get("/context", params={"user_id": "nobody"}).status_code == 404
    assert "Flowdesk Support Assistant" in client.get("/").text
    assert client.get("/health").json() == {"model": "fake", "chunks": 3, "mcp_tools": [
        "get_ticket", "get_user", "list_user_tickets", "search_tickets", "list_users"]}
