import asyncio

import pytest

from support.crm_client import CRMClient, parse_rows
from supportmcp.crm import CRM, CRMError, normalize_ticket_id
from supportmcp.server import DEFAULT_DATA, create_server


@pytest.fixture(scope="module")
def crm():
    return CRM.load(DEFAULT_DATA)


def test_ticket_ids_are_normalized():
    for raw in ("T-1001", "t-1001", "t1001", "#1001", "1001", " T 1001 "):
        assert normalize_ticket_id(raw) == "T-1001"


def test_ticket_text(crm):
    out = crm.ticket_text("t1001")
    assert out.startswith("ticket T-1001 · status open · priority high · area sign-in")
    assert "customer: Tom Becker <tom@brightpath.studio> (u_102), member of Brightpath Studio" in out
    assert "error code attached by the app: AUTH_423_LOCKED" in out
    assert "created: 2026-10-15 11:55 UTC (5 min ago)" in out
    assert "[2026-10-15 11:55 customer] Authorization isn't working." in out
    with pytest.raises(CRMError):
        crm.ticket_text("T-9")


def test_locked_user(crm):
    out = crm.user_text("u_102")
    assert "account status: LOCKED since 2026-10-15 11:40 UTC (20 min ago)" in out
    assert "the lock ends 2026-10-15 12:10 UTC (in 10 min)" in out
    assert "AUTH_401_BAD_PASSWORD ×5" in out and "AUTH_423_LOCKED ×2" in out


def test_user_by_email_and_org_settings(crm):
    out = crm.user_text("Maria.Lopez@acme-logistics.com")
    assert out.startswith("user u_101 · Maria Lopez")
    assert "single sign-on: REQUIRED via Okta (SAML 2.0) for acme-logistics.com" in out
    assert "Owen Grant (u_110, owner, billing admin)" in out


def test_invited_and_suspended(crm):
    assert "INVITED, has not accepted yet: invitation sent 2026-10-06 09:00 UTC (9 days ago) by Owen Grant" \
        in crm.user_text("u_109")
    out = crm.user_text("u_105")
    assert "PAST DUE since 2026-09-28 (17 days ago); workspace SUSPENDED since 2026-10-12 (3 days ago)" in out
    assert "Priya Raman (u_106, owner, billing admin)" in out


def test_api_keys_and_clients(crm):
    out = crm.user_text("u_107")
    assert ('API key fd_live_3f9a "warehouse-sync" created 2026-04-02 by Leo Martin (u_108) (deactivated '
            "2026-10-10): REVOKED 2026-10-10 (creator deactivated)") in out
    assert "HTTP 401 API_KEY_INVALID ×412" in out
    assert "desktop app (3.4.0, macOS 26.0)" in crm.user_text("u_103")


def test_user_tickets_and_search(crm):
    out = crm.user_tickets_text("u_102", exclude="T-1001")
    assert "T-0987 · solved" in out and "  T-1001" not in out
    assert "last agent reply: It was in your spam folder" in out
    assert "has no other tickets" in crm.user_tickets_text("u_101", exclude="T-1002")
    assert crm.search_tickets_text("AUTH_423_LOCKED").startswith("T-1001 ·")
    assert crm.search_tickets_text("slack").startswith("T-1009 ·")
    assert all(" · open · " in line for line in crm.search_tickets_text(status="open").splitlines())
    assert crm.search_tickets_text("nothing like this") == "no tickets match"


def test_over_mcp_in_process(crm):
    """The same tools through a real MCP client: names, results, errors as text."""
    async def run():
        async with CRMClient(server=create_server(crm)) as client:
            assert set(client.names) == {"get_ticket", "get_user", "list_user_tickets", "search_tickets", "list_users"}
            assert "AUTH_403_SSO_REQUIRED" in await client.call("get_ticket", {"ticket_id": "T-1002"})
            assert (await client.call("get_user", {"user": "nobody"})).startswith("error: no user")
            rows = parse_rows(await client.call("search_tickets", {}))
            assert len(rows) == 12 and rows[0][0] == "T-1001"
            users = parse_rows(await client.call("list_users", {"org": "org_acme"}))
            assert [u[0] for u in users] == ["u_101", "u_109", "u_110"]
            assert (await client.call("drop_table")).startswith("error: no tool named")
            assert [c[0] for c in client.calls] == ["get_ticket", "get_user", "search_tickets", "list_users",
                                                   "drop_table"]
    asyncio.run(run())


def test_stdio_subprocess():
    """The real thing: `python -m supportmcp.server` over stdio."""
    async def run():
        async with CRMClient() as client:
            assert "Raj Patel" in await client.call("get_user", {"user": "u_112"})
    asyncio.run(run())
