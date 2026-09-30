from indexer.chunk import Flat, split_long
from indexer.chunk_fixed import chunk_fixed
from indexer.chunk_struct import chunk_struct
from indexer.extract import Document, Element

SENT = "The quick brown fox jumps over the lazy dog again and again. "


def _doc(*elements: Element) -> Document:
    return Document("papers/My Paper.pdf", "My Paper", 3, "x", "outline", list(elements))


def H(text, level=1, page=1):
    return Element("heading", text, page, level)


def P(text, page=1):
    return Element("para", text.strip(), page)


def test_flat_tracks_section_path():
    flat = Flat(_doc(P("front"), H("1 Intro"), P("a"), H("1.1 Sub", 2), P("b"), H("2 Next"), P("c")))
    assert [s.section for s in flat.spans] == [
        "(front matter)", "1 Intro", "1 Intro", "1 Intro > 1.1 Sub", "1 Intro > 1.1 Sub", "2 Next", "2 Next"]
    assert flat.text.startswith("front\n\n1 Intro\n\na")


def test_fixed_window_overlap_and_word_boundaries():
    doc = _doc(H("1 Intro"), P(SENT * 20, page=1), H("2 Next"), P(SENT * 20, page=2))
    chunks = chunk_fixed(doc, size=300, overlap=50)
    text = Flat(doc).text
    for c in chunks:
        assert len(c.text) <= 300
        assert c.text in text  # a contiguous slice, nothing rewritten
        assert not c.text[0].isspace() and not c.text[-1].isspace()
    words = set(text.split())
    for c in chunks:  # no word cut in half
        assert set(c.text.split()) <= words
    # consecutive chunks share text
    for a, b in zip(chunks, chunks[1:]):
        assert a.text[-20:].split()[-1] in b.text[:80]
    assert chunks[0].chunk_id == "my-paper:fixed:0000"
    assert any(c.sections_spanned == 2 for c in chunks)
    assert any(c.page_start == 1 and c.page_end == 2 for c in chunks)


def test_struct_one_section_per_chunk():
    doc = _doc(H("1 Intro"), P(SENT * 5), H("2 Method", page=2), P(SENT * 5, page=2))
    chunks = chunk_struct(doc)
    assert [(c.section, c.sections_spanned) for c in chunks] == [("1 Intro", 1), ("2 Method", 1)]
    assert chunks[0].text.startswith("1 Intro\n\n")
    assert chunks[1].page_start == 2


def test_struct_splits_long_section_on_paragraphs():
    doc = _doc(H("1 Intro"), *[P(SENT * 8) for _ in range(6)])  # ~490 chars each
    chunks = chunk_struct(doc, max_chars=1500)
    assert len(chunks) > 1
    assert all(len(c.text) <= 1500 for c in chunks)
    assert all(c.section == "1 Intro" for c in chunks)
    assert all(c.text.endswith(".") for c in chunks)  # never mid-sentence


def test_struct_merges_lone_heading_into_next_section():
    doc = _doc(H("3 Model"), H("3.1 Encoder", 2), P(SENT * 5))
    chunks = chunk_struct(doc)
    assert len(chunks) == 1
    assert chunks[0].text.startswith("3 Model\n\n3.1 Encoder")
    assert chunks[0].section == "3 Model > 3.1 Encoder"
    assert chunks[0].sections_spanned == 2


def test_struct_small_last_section_joins_previous():
    doc = _doc(H("1 Intro"), P(SENT * 5), H("2 End"), P("Short."))
    chunks = chunk_struct(doc)
    assert len(chunks) == 1 and chunks[0].text.endswith("2 End\n\nShort.")


def test_split_long_prefers_sentences():
    parts = split_long(SENT * 30, 400)
    assert all(len(p) <= 400 for p in parts)
    assert all(p.endswith(".") for p in parts)
    assert split_long("x" * 1000, 300) == ["x" * 300, "x" * 300, "x" * 300, "x" * 100]


def test_struct_heading_never_alone_before_long_paragraph():
    long_para = " ".join([SENT.strip()] * 24)  # ~1460 chars: heading + paragraph > 1500
    doc = _doc(H("1 Intro"), P(SENT * 5), H("2 Long"), P(long_para), P(SENT * 3))
    chunks = chunk_struct(doc, max_chars=1500)
    assert all(c.text.strip() not in ("1 Intro", "2 Long") for c in chunks)
    second = [c for c in chunks if c.section == "2 Long"]
    assert second[0].text.startswith("2 Long\n\nThe quick")
    assert all(len(c.text) <= 1500 for c in chunks)
