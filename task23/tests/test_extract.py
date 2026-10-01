from pathlib import Path

import pymupdf

from indexer.extract import _join_lines, extract

BODY = "Body text that goes on for a while so the body font size wins the count. " * 3


def _pdf(path: Path, with_outline: bool) -> Path:
    doc = pymupdf.open()
    for n, (head, sub) in enumerate([("1 Introduction", "1.1 Scope"), ("2 Method", "2.1 Data")], start=1):
        page = doc.new_page()
        page.insert_text((72, 72), head, fontsize=16)
        page.insert_textbox((72, 90, 520, 200), BODY, fontsize=10)
        page.insert_text((72, 230), sub, fontsize=13)
        page.insert_textbox((72, 250, 520, 360), BODY, fontsize=10)
        page.insert_text((300, 800), str(n), fontsize=9)  # page number: dropped
    if with_outline:
        doc.set_toc([[1, "1 Introduction", 1], [2, "1.1 Scope", 1], [1, "2 Method", 2], [2, "2.1 Data", 2]])
    doc.save(path)
    return path


def test_pdf_outline(tmp_path):
    doc = extract(_pdf(tmp_path / "a.pdf", True), tmp_path)
    assert doc.heading_source == "outline"
    assert [(h.text, h.level, h.page) for h in doc.headings] == [
        ("1 Introduction", 1, 1), ("1.1 Scope", 2, 1), ("2 Method", 1, 2), ("2.1 Data", 2, 2)]
    assert not any(e.text.strip().isdigit() for e in doc.elements)


def test_pdf_fonts_fallback(tmp_path):
    doc = extract(_pdf(tmp_path / "b.pdf", False), tmp_path)
    assert doc.heading_source == "fonts"
    assert [(h.text, h.level) for h in doc.headings] == [
        ("1 Introduction", 1), ("1.1 Scope", 2), ("2 Method", 1), ("2.1 Data", 2)]


def test_markdown(tmp_path):
    p = tmp_path / "n.md"
    p.write_text("# Title\n\nintro\n\n## Part\n\n```\n# not a heading\n```\n\ntext\n")
    doc = extract(p, tmp_path)
    assert doc.title == "Title"
    assert [(h.text, h.level) for h in doc.headings] == [("Title", 1), ("Part", 2)]


def test_join_lines_dehyphenates():
    assert _join_lines(["atten-", "tion is", "all"]) == "attention is all"
    assert _join_lines(["self-", "Attention"]) == "self- Attention"


def test_join_continued_paragraphs():
    from indexer.extract import Element, _join_continued
    els = [Element("para", "Reading Wikipedia to", 3), Element("para", "answer open questions.", 4),
           Element("para", "New paragraph.", 4), Element("para", "lowercase but previous ended.", 4)]
    out = _join_continued(els)
    assert [(e.text, e.page) for e in out] == [
        ("Reading Wikipedia to answer open questions.", 3), ("New paragraph.", 4),
        ("lowercase but previous ended.", 4)]


def test_ieee_two_column_headings(tmp_path):
    """Body-size headings (roman small caps, italic letters) in two columns, read left column first."""
    doc = pymupdf.open()
    page = doc.new_page()  # 612 wide: columns at 50–290 and 320–560
    text = "Body text that runs on for a while in a narrow column of the page. " * 4
    page.insert_textbox((50, 60, 290, 80), "I. INTRODUCTION", fontsize=10)
    page.insert_textbox((50, 90, 290, 240), text, fontsize=10)
    page.insert_textbox((50, 250, 290, 270), "A. Scope of the Work", fontsize=10, fontname="tiit")
    page.insert_textbox((50, 280, 290, 430), text, fontsize=10)
    page.insert_textbox((320, 60, 560, 80), "II. RELATED WORK", fontsize=10)
    page.insert_textbox((320, 90, 560, 240), text, fontsize=10)
    path = tmp_path / "ieee.pdf"
    doc.save(path)

    d = extract(path, tmp_path)
    assert d.heading_source == "fonts"
    assert [(h.text, h.level) for h in d.headings] == [
        ("I. INTRODUCTION", 1), ("A. Scope of the Work", 2), ("II. RELATED WORK", 1)]
    kinds = [e.kind for e in d.elements]
    assert kinds == ["heading", "para", "heading", "para", "heading", "para"]


def test_reading_order_bands_and_columns():
    from indexer.extract import _reading_order

    def b(name, x0, y0, x1):
        return {"name": name, "bbox": (x0, y0, x1, y0 + 10)}

    blocks = [b("R1", 320, 100, 560), b("L2", 50, 150, 290), b("title", 50, 20, 560),
              b("L1", 50, 100, 290), b("R2", 320, 150, 560), b("wide", 50, 300, 560), b("L3", 50, 400, 290)]
    assert [x["name"] for x in _reading_order(blocks, 612)] == ["title", "L1", "L2", "R1", "R2", "wide", "L3"]
