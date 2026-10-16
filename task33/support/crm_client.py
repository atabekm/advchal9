"""The assistant's side of MCP: start `supportmcp` over stdio and call its tools.

The assistant never opens the CRM file itself; everything it knows about a customer comes
through these calls.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from mcp import Client
from mcp.client.stdio import StdioServerParameters

TASK_DIR = Path(__file__).resolve().parent.parent


class CRMClient:
    """`async with CRMClient() as crm: await crm.call("get_ticket", {"ticket_id": "T-1001"})`.

    `server` is for tests: an in-process MCPServer instead of the stdio subprocess."""

    def __init__(self, data: Path | None = None, server: Any = None):
        if server is None:
            env = {"SUPPORT_DATA": str(data)} if data else {}
            server = StdioServerParameters(command=sys.executable, args=["-m", "supportmcp.server"],
                                           cwd=str(TASK_DIR), env=env)
        self._client = Client(server, cache=None)
        self.tools: list = []
        self.calls: list[tuple[str, dict, str]] = []  # (tool, arguments, result), shown with each answer

    async def __aenter__(self) -> CRMClient:
        await self._client.__aenter__()
        self.tools = (await self._client.list_tools()).tools
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.__aexit__(*exc)

    @property
    def names(self) -> list[str]:
        return [t.name for t in self.tools]

    async def call(self, name: str, arguments: dict | None = None) -> str:
        if name not in self.names:
            result = f"error: no tool named {name!r}; available: {', '.join(self.names)}"
        else:
            try:
                res = await self._client.call_tool(name, arguments or {})
                result = "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text").strip()
                if getattr(res, "is_error", False) or getattr(res, "isError", False):
                    result = f"error: {result}"
            except Exception as e:  # a dead server or a bad argument: reported, not raised
                result = f"error: {type(e).__name__}: {e}"
        self.calls.append((name, dict(arguments or {}), result))
        return result


def parse_rows(text: str) -> list[list[str]]:
    """The one-line-per-item results of `search_tickets` and `list_users`, split on " · "."""
    if text.startswith("error:") or text.startswith("no "):
        return []
    return [line.split(" · ") for line in text.splitlines() if " · " in line and not line.startswith(" ")]
