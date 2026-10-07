from rag.cited import Quote
from rag.retrieve import Hit
from rag.verify import match, normalize, verify

CHUNK = ("The TatarTTS dataset contains about 70 hours of tran-\nscribed audio, recorded by two pro-\n"
         "fessional speakers \u2014 actors of the Tatar National Theatre.\u200b The texts were \u201cchecked\u201d.")


def test_normalize_undoes_pdf_artefacts():
    assert normalize("tran-\nscribed  Audio\u200b \u2014 \u201cx\u2019s\u201d") == 'transcribed audio - "x\'s"'


def test_exact_and_reflowed_quotes_match():
    assert match("about 70 hours of transcribed audio", CHUNK) == 100
    assert match("recorded by two professional speakers - actors of the Tatar National Theatre.", CHUNK) == 100
    assert match('The texts were "checked".', CHUNK) == 100


def test_small_differences_still_pass():
    assert match("contains about 70 hours of transcribed audio recorded by two professional speaker", CHUNK) >= 90


def test_paraphrase_and_invention_fail():
    assert match("The dataset has roughly seventy hours of audio from two speakers", CHUNK) < 90
    assert match("recorded in Kazan in 2023", CHUNK) < 90
    assert match("", CHUNK) == 0


def test_verify_splits_and_scores_against_the_cited_chunk():
    hits = [Hit(1, 0.9, "a", "a.pdf", "A", "", 1, 1, CHUNK), Hit(2, 0.8, "b", "b.pdf", "B", "", 2, 2, "Unrelated text.")]
    ok, bad = verify([Quote(1, "about 70 hours"), Quote(2, "about 70 hours"), Quote(7, "about 70 hours")], hits)
    assert [q.ref for q in ok] == [1] and ok[0].score == 100
    assert [q.ref for q in bad] == [2, 7] and bad[1].score == 0


def test_one_gap_for_a_page_break_inside_the_quote():
    chunk = ("This makes it possible to process nested structures such as relative clauses or prepositional\n\n"
             "3 https://example.org/footnote.\n\nRecent advances in Apertium… phrases within prepositional phrases. More.")
    quote = "This makes it possible to process nested structures such as relative clauses or prepositional phrases within prepositional phrases."
    assert match(quote, chunk) >= 90
    assert match("This makes it possible to process nested structures such as noun phrases inside verb phrases in Basque.", chunk) < 90
    assert match("phrases within prepositional phrases. This makes it possible to process nested structures", chunk) < 90
