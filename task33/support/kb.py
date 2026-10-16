"""The knowledge base: `kb/*.md` → documents → chunks.

Chunking is task 31's, for Markdown only: one chunk per section, cut at headings, with the
heading path ("Single sign-on (SSO) › Require SSO") as the chunk's section. A section longer than
MAX_CHARS is packed on paragraph boundaries (code blocks and tables are not split); one shorter
than MIN_CHARS is merged into the next, so a heading followed straight by a subheading is never
a chunk of its own.

`embed_text` puts the file and section in front of the text: "Codes are rejected" means little
until it says it's in two-factor.md.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent.parent
KB_DIR = TASK_DIR / "kb"
MAX_CHARS = 1500
MIN_CHARS = 200
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


@dataclass(frozen=True)
class Doc:
    source: str  # "kb/sso.md"
    title: str
    text: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode()).hexdigest()


@dataclass(frozen=True)
class Chunk:
    source: str
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


def collect(kb_dir: Path = KB_DIR) -> list[Doc]:
    docs = []
    for path in sorted(kb_dir.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        m = re.search(r"^#\s+(.+)$", text, re.M)
        source = path.relative_to(kb_dir.parent).as_posix()
        docs.append(Doc(source, m.group(1).strip() if m else path.stem, text))
    return docs


def chunk(doc: Doc, max_chars: int = MAX_CHARS, min_chars: int = MIN_CHARS) -> list[Chunk]:
    out: list[Chunk] = []
    for section, text in _pack(markdown_sections(doc.text), max_chars, min_chars):
        out.append(Chunk(doc.source, section, len(out), text))
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
        # A heading whose first paragraph didn't fit next to it stays with that paragraph.
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
    """A paragraph over the limit, cut on line boundaries (tables, lists), else sentences. Every
    piece of a cut table starts with the table's header: a row of the error-code table means
    nothing without its column names."""
    if len(para) <= max_chars:
        return [para]
    units = para.split("\n") if "\n" in para else re.split(r"(?<=[.!?])\s+", para)
    header = ""
    if len(units) > 2 and units[0].startswith("|") and re.match(r"^\|[\s:|-]+\|$", units[1]):
        header, units = f"{units[0]}\n{units[1]}", units[2:]
    out: list[str] = []
    sep = "\n" if "\n" in para else " "
    for u in units:
        if out and len(out[-1]) + len(sep) + len(u) <= max_chars:
            out[-1] += sep + u
        else:
            out.append(f"{header}\n{u[:max_chars * 2]}" if header else u[:max_chars * 2])
    return out
