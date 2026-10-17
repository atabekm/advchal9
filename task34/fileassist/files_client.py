"""The assistant's side of MCP: start `filemcp` over stdio for a project root and call its tools.

The assistant never touches the project's files itself; every read and edit goes through these calls.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from mcp import Client
from mcp.client.stdio import StdioServerParameters

from filemcp.server import CLIENT_TOOLS

TASK_DIR = Path(__file__).resolve().parent.parent


class FilesClient:
    """`async with FilesClient(root) as fs: await fs.call("read_file", {"path": "README.md"})`.

    `server` is for tests: an in-process MCPServer instead of the stdio subprocess."""

    def __init__(self, root: Path | str | None = None, server: Any = None):
        if server is None:
            server = StdioServerParameters(command=sys.executable, args=["-m", "filemcp.server", "--root", str(root)],
                                           cwd=str(TASK_DIR))
        self._client = Client(server, cache=None)
        self.tools: list = []

    async def __aenter__(self) -> FilesClient:
        await self._client.__aenter__()
        self.tools = (await self._client.list_tools()).tools
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.__aexit__(*exc)

    @property
    def names(self) -> list[str]:
        return [t.name for t in self.tools]

    @property
    def model_tools(self) -> list:
        """The tools the model may call: everything but staging control."""
        return [t for t in self.tools if t.name not in CLIENT_TOOLS]

    async def call(self, name: str, arguments: dict | None = None) -> str:
        if name not in self.names:
            return f"error: no tool named {name!r}; available: {', '.join(t.name for t in self.model_tools)}"
        try:
            res = await self._client.call_tool(name, arguments or {})
        except Exception as e:  # a dead server or a bad argument: reported, not raised
            return f"error: {type(e).__name__}: {e}"
        text = "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text").strip()
        if getattr(res, "is_error", False) or getattr(res, "isError", False):
            text = text if text.startswith("error:") else f"error: {text}"
        return text

    async def diff(self) -> str:
        return await self.call("staged_diff")

    async def apply(self) -> list[str]:
        out = await self.call("apply_staged")
        return out.splitlines() if out else []
