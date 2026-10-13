"""Documents → chunks, cut where the document cuts.

- Markdown: one chunk per section. The heading path ("Task 30 › Run it › On a VPS") is the
  chunk's section. A section longer than MAX_CHARS is packed into several chunks on paragraph
  boundaries (a fenced code block is never split); a section shorter than MIN_CHARS is merged
  into the next, so a heading followed straight by a subheading is never a chunk of its own.
- OpenAPI: rendered as Markdown first, one section per operation and one per schema.
- Text (briefs, pyproject.toml, compose files, ...) and SQL schemas: one chunk when it fits,
  else packed on blank lines.

`embed_text` puts the file path and section in front of the text: thirty READMEs have a
"Setup" section, and the path is what tells them apart.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import yaml

from .corpus import Doc

MAX_CHARS = 1500
MIN_CHARS = 200
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


@dataclass(frozen=True)
class Chunk:
    source: str
    task: str
    section: str
    ordinal: int
    text: str

    @property
    def chunk_id(self) -> str:
        return f"{self.source}#{self.ordinal}"

    @property
    def label(self) -> str:
        return f"{self.source} › {self.section}" if self.section else self.source

    @property
    def embed_text(self) -> str:
        return f"{self.label}\n\n{self.text}"


def chunk(doc: Doc, max_chars: int = MAX_CHARS, min_chars: int = MIN_CHARS) -> list[Chunk]:
    if doc.kind == "markdown":
        sections = markdown_sections(doc.text)
    elif doc.kind == "openapi":
        sections = markdown_sections(openapi_markdown(doc.text))
    else:
        what = "data schema (SQL)" if doc.kind == "schema" else ""
        section = " · ".join(x for x in (doc.title, what) if x)
        sections = [(section, _blocks(doc.text))]
    out: list[Chunk] = []
    for section, text in _pack(sections, max_chars, min_chars):
        out.append(Chunk(doc.source, doc.task, section, len(out), text))
    return out


def markdown_sections(text: str) -> list[tuple[str, list[str]]]:
    """(heading path, paragraphs) per section, in order. Headings inside code fences don't count."""
    sections: list[tuple[str, list[str]]] = [("", [])]
    path: list[tuple[int, str]] = []
    for block in _blocks(text):
        m = HEADING_RE.match(block.split("\n", 1)[0]) if not FENCE_RE.match(block) else None
        if m:
            level, title = len(m.group(1)), _plain(m.group(2))
            path = [(lv, t) for lv, t in path if lv < level] + [(level, title)]
            sections.append((" › ".join(t for _, t in path), [block]))
            rest = block.split("\n", 1)[1:]  # a heading glued to its first paragraph
            if rest and rest[0].strip():
                sections[-1] = (sections[-1][0], [block.split("\n", 1)[0], rest[0]])
        else:
            sections[-1][1].append(block)
    return [(name, paras) for name, paras in sections if paras]


def _blocks(text: str) -> list[str]:
    """Paragraphs split on blank lines, except inside fenced code blocks."""
    blocks, cur, fence = [], [], None
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if m:
            fence = None if fence and m.group(1) == fence else (fence or m.group(1))
        if not line.strip() and fence is None:
            if cur:
                blocks.append("\n".join(cur))
                cur = []
            continue
        cur.append(line.rstrip())
    if cur:
        blocks.append("\n".join(cur))
    return blocks


def _plain(title: str) -> str:
    """A heading without Markdown decoration: links, code, emphasis."""
    title = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", title)
    return re.sub(r"[`*_]", "", title).strip()


def _pack(sections: list[tuple[str, list[str]]], max_chars: int, min_chars: int) -> list[tuple[str, str]]:
    pieces: list[tuple[str, str]] = []
    carry: tuple[str, str] | None = None  # a section too short to stand alone, waiting for the next
    for name, paras in sections:
        parts = []
        for para in paras:
            parts.extend(_split_long(para, max_chars))
        packed: list[str] = []
        for part in parts:
            if packed and len(packed[-1]) + 2 + len(part) <= max_chars:
                packed[-1] += "\n\n" + part
            else:
                packed.append(part)
        # A heading (or a one-line lead-in) whose first paragraph didn't fit next to it stays
        # with that paragraph, even if the chunk runs over the limit.
        if len(packed) > 1 and len(packed[0]) < min_chars:
            packed[:2] = [f"{packed[0]}\n\n{packed[1]}"]
        if len(packed) > 1 and len(packed[-1]) < min_chars:  # nor does a short tail stand alone
            packed[-2:] = [f"{packed[-2]}\n\n{packed[-1]}"]
        if carry:
            packed[0] = f"{carry[1]}\n\n{packed[0]}"
            name = name or carry[0]
            carry = None
        if len(packed) == 1 and len(packed[0]) < min_chars:
            carry = (name, packed[0])
            continue
        pieces.extend((name, p) for p in packed)
    if carry:
        if pieces:
            name, text = pieces[-1]
            pieces[-1] = (name, f"{text}\n\n{carry[1]}")
        else:
            pieces.append(carry)
    return pieces


def _split_long(para: str, max_chars: int) -> list[str]:
    """A paragraph over the limit, cut on line boundaries (tables, code, lists), else sentences."""
    if len(para) <= max_chars:
        return [para]
    units = para.split("\n") if "\n" in para else re.split(r"(?<=[.!?])\s+", para)
    out: list[str] = []
    sep = "\n" if "\n" in para else " "
    for u in units:
        if out and len(out[-1]) + len(sep) + len(u) <= max_chars:
            out[-1] += sep + u
        else:
            out.append(u[:max_chars * 2])  # a single line that long is cut, not dropped
    return out


def openapi_markdown(text: str) -> str:
    """An OpenAPI document as Markdown: one section per operation, one per schema."""
    spec = yaml.safe_load(text)
    info = spec.get("info", {})
    lines = [f"# {info.get('title', 'API')}", "", (info.get("description") or "").strip()]
    for server in spec.get("servers", []):
        lines.append(f"Server: {server.get('url')}")
    for path, ops in spec.get("paths", {}).items():
        for method, op in ops.items():
            lines += ["", f"## {method.upper()} {path}", "", op.get("summary", "")]
            if op.get("description"):
                lines += ["", op["description"].strip()]
            if op.get("security"):
                lines += ["", "Auth: " + ", ".join(k for s in op["security"] for k in s)]
            body = op.get("requestBody", {}).get("content", {})
            for ctype, media in body.items():
                lines += ["", f"Request body ({ctype}): {_schema_ref(media.get('schema', {}))}"]
            responses = op.get("responses", {})
            if responses:
                lines.append("")
                for code, resp in responses.items():
                    desc = resp.get("description") or _resolve(spec, resp).get("description", "")
                    lines.append(f"- {code}: {' '.join(str(desc).split())}")
    for name, schema in spec.get("components", {}).get("schemas", {}).items():
        lines += ["", f"## Schema {name}", ""]
        required = set(schema.get("required", []))
        for field, prop in schema.get("properties", {}).items():
            bits = [_schema_ref(prop)]
            for key in ("enum", "default", "minimum", "maximum", "minItems"):
                if key in prop:
                    bits.append(f"{key} {prop[key]}")
            if prop.get("description"):
                bits.append(prop["description"])
            mark = " (required)" if field in required else ""
            lines.append(f"- `{field}`{mark}: {'; '.join(map(str, bits))}")
    return "\n".join(lines)


def _schema_ref(schema: dict) -> str:
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if schema.get("type") == "array":
        return f"array of {_schema_ref(schema.get('items', {}))}"
    return str(schema.get("type", "object"))


def _resolve(spec: dict, obj: dict) -> dict:
    ref = obj.get("$ref", "")
    node = spec
    for part in ref.lstrip("#/").split("/") if ref else []:
        node = node.get(part, {})
    return node if ref else obj
