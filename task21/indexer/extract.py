"""Turn a source file into a Document: an ordered list of headings and paragraphs.

PDFs go through PyMuPDF. Headings come from the PDF outline when it has one and
from font size / weight when it doesn't; both strategies see the same Document,
so the only difference between them is where they cut.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

SUPPORTED = {".pdf", ".md", ".markdown", ".txt"}


@dataclass
class Element:
    kind: str  # "heading" | "para"
    text: str
    page: int  # 1-based; 1 for text files
    level: int = 0  # headings only, 1 = top


@dataclass
class Document:
    source: str  # path relative to the corpus root
    title: str
    pages: int
    sha256: str
    heading_source: str  # "outline" | "fonts" | "markdown" | "none"
    elements: list[Element] = field(default_factory=list)

    @property
    def headings(self) -> list[Element]:
        return [e for e in self.elements if e.kind == "heading"]

    @property
    def chars(self) -> int:
        return sum(len(e.text) for e in self.elements)


def find_sources(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in SUPPORTED)


def extract(path: Path, root: Path) -> Document:
    source = path.relative_to(root).as_posix()
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if path.suffix.lower() == ".pdf":
        return _extract_pdf(path, source, sha)
    return _extract_text(path, source, sha)


# --- PDF -------------------------------------------------------------------

@dataclass
class _Line:
    text: str
    size: float
    bold: bool


@dataclass
class _Block:
    page: int
    lines: list[_Line]

    @property
    def text(self) -> str:
        return _join_lines([l.text for l in self.lines])


_NUMBERED = re.compile(r"^(?:[A-Z]|\d+)(?:\.\d+)*\.?\s+\S")
# Default dict flags minus ligature preservation: "ﬁ" becomes "fi", so
# "Veriﬁcation" matches the outline's "Verification" and embeds normally.
_TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_LIGATURES
_PAGE_NUMBER = re.compile(r"^\s*(?:page\s+)?\d+(?:\s*(?:/|of)\s*\d+)?\s*$", re.I)


def _extract_pdf(path: Path, source: str, sha: str) -> Document:
    with pymupdf.open(path) as pdf:
        blocks = _read_blocks(pdf)
        body = _body_size(blocks)
        toc = pdf.get_toc(simple=True)
        title = _pdf_title(pdf, blocks, path)

        elements: list[Element] = []
        heading_source = "none"
        if toc:
            elements, matched = _apply_outline(blocks, toc, _FontRules(blocks, body))
            # An outline that matches almost nothing (e.g. bookmarks for figures
            # only) is worse than guessing from fonts.
            if matched >= max(2, len(toc) // 3):
                heading_source = "outline"
            else:
                elements = []
        if not elements:
            elements = _apply_fonts(blocks, body)
            if any(e.kind == "heading" for e in elements):
                heading_source = "fonts"

        return Document(source, title, pdf.page_count, sha, heading_source, elements)


def _read_blocks(pdf: pymupdf.Document) -> list[_Block]:
    blocks: list[_Block] = []
    for page in pdf:
        for b in page.get_text("dict", sort=True, flags=_TEXT_FLAGS)["blocks"]:
            if b["type"] != 0:
                continue
            lines = []
            for l in b["lines"]:
                # Rotated text is margin stamps (arXiv ids, line numbers).
                if abs(l["dir"][1]) > 0.01:
                    continue
                spans = [s for s in l["spans"] if s["text"].strip()]
                if not spans:
                    continue
                text = "".join(s["text"] for s in l["spans"]).strip()
                chars = Counter()
                for s in spans:
                    chars[round(s["size"], 1)] += len(s["text"])
                size = chars.most_common(1)[0][0]
                bold = all(s["flags"] & 16 or "bold" in s["font"].lower() or "medi" in s["font"].lower()
                           for s in spans)
                lines.append(_Line(text, size, bold))
            if not lines:
                continue
            block = _Block(page.number + 1, lines)
            if _PAGE_NUMBER.match(block.text):
                continue
            blocks.append(block)
    return _drop_running_lines(blocks, pdf.page_count)


def _drop_running_lines(blocks: list[_Block], pages: int) -> list[_Block]:
    """Headers and footers repeat on most pages; they are noise in every chunk."""
    if pages < 4:
        return blocks
    seen = Counter()
    for b in blocks:
        seen[(_norm(re.sub(r"\d+", "#", b.text)))] += 1
    running = {t for t, n in seen.items() if n >= pages * 0.5 and len(t) < 120}
    return [b for b in blocks if _norm(re.sub(r"\d+", "#", b.text)) not in running]


def _body_size(blocks: list[_Block]) -> float:
    chars = Counter()
    for b in blocks:
        for l in b.lines:
            chars[l.size] += len(l.text)
    return chars.most_common(1)[0][0] if chars else 10.0


def _pdf_title(pdf: pymupdf.Document, blocks: list[_Block], path: Path) -> str:
    meta = (pdf.metadata or {}).get("title", "").strip()
    if meta and not re.search(r"untitled|microsoft|\.docx?$|\.pdf$", meta, re.I) and len(meta) > 3:
        return meta
    first = [b for b in blocks if b.page == 1]
    if first:
        top = max(l.size for b in first for l in b.lines)
        lines = [l.text for b in first for l in b.lines if l.size == top]
        if lines and top > _body_size(blocks) * 1.2:
            return _join_lines(lines)[:200]
    return path.stem.replace("_", " ").replace("-", " ")


def _apply_outline(blocks: list[_Block], toc: list, fonts: _FontRules) -> tuple[list[Element], int]:
    """Find each outline entry in the text and cut there.

    Entries are searched in order, from the block after the previous match, on
    the page the outline points to (or the next one: outlines often point at the
    top of a page while the heading sits a page later).

    Outlines often leave out unnumbered sections (References, Broader Impact);
    a block set in a heading font size after the first outline heading becomes
    a top-level heading too, so references don't pile onto the last section.
    """
    heads: dict[int, tuple[int, int, str]] = {}  # block index -> (lines in heading, level, title)
    cursor = 0
    matched = 0
    for level, title, page in toc:
        want = _norm(title)
        if not want:
            continue
        # Figure labels inside diagrams repeat heading words ("Scaled Dot-Product
        # Attention" is also a box in Figure 2), so take the best-looking
        # candidate in the window, not the first one.
        best = None  # (score, index, lines)
        for i in range(cursor, len(blocks)):
            b = blocks[i]
            if page > 0 and b.page < page:
                continue
            if page > 0 and b.page > page + 1:
                break
            n = _heading_prefix(b, want)
            if n:
                head = b.lines[:n]
                score = 2 * bool(_NUMBERED.match(_join_lines([l.text for l in head]))) + all(l.bold for l in head)
                if best is None or score > best[0]:
                    best = (score, i, n)
        if best:
            _, i, n = best
            heads[i] = (n, level, _join_lines([l.text for l in blocks[i].lines[:n]]))
            cursor = i + 1
            matched += 1

    first = min(heads, default=len(blocks))
    elements: list[Element] = []
    for i, b in enumerate(blocks):
        if i > first and i not in heads and fonts.is_unnumbered_big(b):
            elements.append(Element("heading", b.text, b.page, 1))
        elif i in heads:
            n, level, text = heads[i]
            elements.append(Element("heading", text, b.page, level))
            rest = b.lines[n:]
            if rest:
                elements.append(Element("para", _join_lines([l.text for l in rest]), b.page))
        else:
            elements.append(Element("para", b.text, b.page))
    return elements, matched


def _heading_prefix(block: _Block, want: str) -> int:
    """How many leading lines of the block spell the heading, 0 if they don't.

    "3.2" / "Attention" on two lines matches the outline entry "Attention";
    "3.2 Attention" matches "3.2 Attention".
    """
    for n in range(1, min(4, len(block.lines)) + 1):
        got = _norm(_join_lines([l.text for l in block.lines[:n]]))
        if got == want or (got.endswith(want) and _NUMBERED.match(got[: len(got) - len(want)] + "x")):
            return n
        if len(got) > len(want) + 12:
            break
    return 0


class _FontRules:
    """Heading by typography: a short block set larger than body text, or bold and numbered."""

    def __init__(self, blocks: list[_Block], body: float):
        # Larger sizes rank as higher levels. The largest size is the document
        # title, not a heading, when it only ever appears on page 1.
        self.sizes = sorted({round(l.size) for b in blocks for l in b.lines if l.size >= body * 1.15}, reverse=True)
        self.title_size = None
        if self.sizes:
            pages = {b.page for b in blocks for l in b.lines if round(l.size) == self.sizes[0]}
            if pages == {1}:
                self.title_size = self.sizes[0]

    def level(self, b: _Block) -> int | None:
        text = b.text
        size = round(max(l.size for l in b.lines))
        short = len(text) <= 100 and len(b.lines) <= 3 and not text.endswith((".", ",", ";"))
        big = size in self.sizes and not (size == self.title_size and b.page == 1)
        bold_numbered = all(l.bold for l in b.lines) and bool(_NUMBERED.match(text))
        if not short or not (big or bold_numbered):
            return None
        if m := re.match(r"^(\d+(?:\.\d+)*)\.?\s", text):
            return m.group(1).count(".") + 1
        if big:
            return max(1, min(self.sizes.index(size), 3))
        return 1

    def is_unnumbered_big(self, b: _Block) -> bool:
        return self.level(b) is not None and not _NUMBERED.match(b.text) and \
            round(max(l.size for l in b.lines)) in self.sizes


def _apply_fonts(blocks: list[_Block], body: float) -> list[Element]:
    rules = _FontRules(blocks, body)
    elements: list[Element] = []
    for b in blocks:
        level = rules.level(b)
        if level is None:
            elements.append(Element("para", b.text, b.page))
        else:
            elements.append(Element("heading", b.text, b.page, level))
    return elements


# --- Markdown / text -------------------------------------------------------

_MD_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def _extract_text(path: Path, source: str, sha: str) -> Document:
    raw = path.read_text(encoding="utf-8", errors="replace")
    is_md = path.suffix.lower() in {".md", ".markdown"}
    elements: list[Element] = []
    title = ""
    para: list[str] = []
    in_fence = False

    def flush():
        if para:
            elements.append(Element("para", "\n".join(para).strip(), 1))
            para.clear()

    for line in raw.splitlines():
        if is_md and line.lstrip().startswith("```"):
            in_fence = not in_fence
        m = _MD_HEADING.match(line) if is_md and not in_fence else None
        if m:
            flush()
            level = len(m.group(1))
            elements.append(Element("heading", m.group(2), 1, level))
            if level == 1 and not title:
                title = m.group(2)
        elif not line.strip() and not in_fence:
            flush()
        else:
            para.append(line)
    flush()

    has_headings = any(e.kind == "heading" for e in elements)
    return Document(source, title or path.stem, 1, sha, "markdown" if has_headings else "none", elements)


# --- helpers ---------------------------------------------------------------

def _join_lines(lines: list[str]) -> str:
    """Join wrapped lines back into one paragraph, undoing end-of-line hyphenation."""
    out = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if not out:
            out = line
        elif out.endswith("-") and line[:1].islower():
            out = out[:-1] + line
        else:
            out += " " + line
    return out


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s.]", "", s.lower())).strip()
