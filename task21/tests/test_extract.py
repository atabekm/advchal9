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
