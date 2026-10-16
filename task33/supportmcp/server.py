"""`supportmcp`: an MCP server (stdio) over the support CRM, a JSON file of organizations, users
and tickets.

Tools, all read-only:

    get_ticket          a ticket: status, customer, error code, environment, the conversation
    get_user            a user (id or email): account state, sign-in methods and failures, clients,
                        and their organization: plan, subscription, SSO, admins, integrations, API keys
    list_user_tickets   a user's tickets, newest first, with the last agent reply of each
    search_tickets      tickets matching words, optionally by status
    list_users          users, optionally of one organization

The file is SUPPORT_DATA, else data/crm.json next to this package.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer

from .crm import CRM, CRMError

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data" / "crm.json"


def create_server(crm: CRM | None = None) -> MCPServer:
    crm = crm or CRM.load(os.environ.get("SUPPORT_DATA") or DEFAULT_DATA)
    mcp = MCPServer("supportmcp", instructions="Read-only customer data of the Flowdesk support desk: "
                    "tickets, users and their organizations.", log_level="WARNING")

    def run(fn, *args):
        try:
            return fn(*args)
        except CRMError as e:
            return f"error: {e}"

    @mcp.tool()
    def get_ticket(ticket_id: str) -> str:
        """A support ticket by id (e.g. "T-1001"): status, priority, the customer and their organization,
        the error code the app attached, the environment (app, version, OS, browser), and the conversation."""
        return run(crm.ticket_text, ticket_id)

    @mcp.tool()
    def get_user(user: str) -> str:
        """A user by id (e.g. "u_102") or email: account status (locked, invited, deactivated), sign-in methods,
        two-factor, recent sign-in failures with error codes, apps they use, and their organization's plan,
        subscription, single sign-on, admins, integrations and API keys."""
        return run(crm.user_text, user)

    @mcp.tool()
    def list_user_tickets(user: str, exclude_ticket: str | None = None) -> str:
        """A user's tickets (id or email), newest first, with the last agent reply of each.
        `exclude_ticket` leaves one out (the ticket being worked on)."""
        return run(crm.user_tickets_text, user, exclude_ticket)

    @mcp.tool()
    def search_tickets(query: str = "", status: str | None = None, limit: int = 20) -> str:
        """Tickets whose id, subject, area, error code, customer or messages contain all words of `query`
        (empty: all), newest first. `status`: open, pending or solved. One line per ticket:
        id · status · priority · user id and name · created · area · subject."""
        return run(crm.search_tickets_text, query, status, limit)

    @mcp.tool()
    def list_users(org: str | None = None) -> str:
        """Users, one per line: id · name · organization · role · status. `org` (e.g. "org_acme") limits it
        to one organization."""
        return run(crm.users_text, org)

    return mcp


def main() -> None:
    try:
        server = create_server()
    except (OSError, ValueError, KeyError) as e:
        print(f"supportmcp: cannot load the CRM data: {e}", file=sys.stderr)
        sys.exit(1)
    server.run("stdio")


if __name__ == "__main__":
    main()
