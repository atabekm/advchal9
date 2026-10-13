"""The assistant's side of MCP: start `devmcp` over stdio, list its tools, call them.

The assistant never runs git itself; everything it knows about the repository's live state
comes through these calls.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from mcp import Client
from mcp.client.stdio import StdioServerParameters

from .corpus import TASK_DIR


class DevTools:
    """`async with DevTools(root) as tools: await tools.call("git_branch")`.

    `server` is for tests: an in-process MCPServer instead of the stdio subprocess."""

    def __init__(self, root: Path | None = None, server: Any = None):
        if server is None:
            env = {"DEVMCP_ROOT": str(root)} if root else {}
            server = StdioServerParameters(command=sys.executable, args=["-m", "devmcp.server"], cwd=str(TASK_DIR),
                                           env=env)
        self._client = Client(server, cache=None)  # git state changes between calls: never reuse a result
        self.tools: list = []
        self.calls: list[tuple[str, dict, str]] = []  # (tool, arguments, result), for /sources and evaluation

    async def __aenter__(self) -> DevTools:
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
            except Exception as e:  # a bad argument type, a dead server: the model sees it and moves on
                result = f"error: {type(e).__name__}: {e}"
        self.calls.append((name, dict(arguments or {}), result))
        return result

    def ollama_specs(self, only: set[str] | None = None) -> list[dict]:
        """The tools in Ollama's /api/chat format (OpenAI-style function definitions)."""
        out = []
        for t in self.tools:
            if only is not None and t.name not in only:
                continue
            schema = dict(getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {})
            schema.pop("title", None)
            props = {k: {kk: vv for kk, vv in v.items() if kk != "title" and not (kk == "default" and vv is None)}
                     for k, v in schema.get("properties", {}).items()}
            for v in props.values():  # `str | None` arrives as anyOf; a small model reads a plain type better
                if "anyOf" in v:
                    types = [a.get("type") for a in v.pop("anyOf") if a.get("type") != "null"]
                    v["type"] = types[0] if types else "string"
            out.append({"type": "function", "function": {
                "name": t.name, "description": t.description or "",
                "parameters": {"type": "object", "properties": props, "required": schema.get("required", [])}}})
        return out
