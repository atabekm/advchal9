import pytest

from rag import judge, report
from rag.evalset import Question, Source
from rag.llm import LLMError


def test_judge_parse():
    v = judge.parse('Sure.\n{"verdict": "Partial", "hallucination": true, "reason": "misses X"}')
    assert (v.verdict, v.hallucination, v.reason, v.score) == ("partial", True, "misses X", 0.5)
    for bad in ("no json", '{"verdict": "great"}', "{not json}"):
        with pytest.raises(LLMError):
            judge.parse(bad)


def test_judge_prompt_marks_unanswerable():
    q = Question("q", "unanswerable", "Dose?", "Not covered.", (), ())
    assert "do not contain the answer" in judge.user_prompt(q, "5 g")


def test_judge_prompt_marks_ambiguous():
    q = Question("q", "ambiguous", "What did it show?", "Ask which.", (), ())
    assert "ambiguous" in judge.user_prompt(q, "x")


def test_faithfulness_parse_and_prompt():
    f = judge.parse_faith('{"verdict": "Partial", "unsupported_claims": ["in 2023"], "reason": "date"}')
    assert (f.verdict, f.unsupported_claims) == ("partial", ["in 2023"])
    assert judge.faith_prompt("Q?", "70 h [1].", [{"ref": 1, "quote": "70 hours"}]).endswith('Quotes:\n[1] "70 hours"')
    with pytest.raises(LLMError):
        judge.parse_faith('{"verdict": "fine"}')


def _data():
    qs = [Question("q1", "fact", "?", "70 h", (("70",),), (Source("a.pdf", (1,)),)),
          Question("q2", "unanswerable", "?", "none", (("not",),), ())]
    src = [{"ref": 1, "source": "a.pdf", "section": "2", "pages": "p. 1", "chunk_id": "a:0001"}]

    def res(qid, label, verdict, status="answer", quotes=0, failed=0, faith=None, clar="", early=False, sources=src):
        return {"id": qid, "label": label, "answer": "a", "keywords": 1.0, "keywords_matched": [True],
                "status": status, "clarification": clar, "sources": sources if status == "answer" else [],
                "quotes": [{"ref": 1, "quote": "q", "match": 100.0}] * quotes,
                "failed_quotes": [{"ref": 1, "quote": "x", "match": 50.0}] * failed, "attempts": 2 if failed else 1,
                "retrieval": {"hit": True, "recall": 1.0, "first_rank": 1} if qid == "q1" else None,
                "early_refusal": early, "timings": {"search": 0.1, "answer": 1.0},
                "cited": [1] if status == "answer" else [], "cited_expected": True if qid == "q1" else None,
                "context": [], "prompt_tokens": 10, "completion_tokens": 5, "seconds": 1.0,
                "judge": {"verdict": verdict, "hallucination": False, "reason": "r"},
                "faithful": None if faith is None else {"verdict": faith, "unsupported_claims": [], "reason": "r"}}

    data = {"created": "t", "model": "m", "judge_model": "m", "k": 5, "min_match": 90,
            "labels": ["legacy:rr", "rr"],
            "results": [res("q1", "legacy:rr", "correct"), res("q2", "legacy:rr", "wrong"),
                        res("q1", "rr", "correct", quotes=2, failed=1, faith="supported"),
                        res("q2", "rr", "refused", status="unknown", clar="Which one?", early=True)]}
    return data, qs


def test_summary_rows_cover_the_task_checks():
    data, qs = _data()
    rows = dict(report.summary_rows(data, qs))
    assert rows["answers / I don't know"] == ["2 / 0", "1 / 1"]
    assert rows["**sources** in the answer"] == ["2 / 2", "1 / 1"]
    assert rows["**quotes** in the answer"] == ["0 / 2", "1 / 1"]
    assert rows["quotes found in their chunk (match ≥ 90)"] == ["—", "2 / 3"]
    assert rows["**meaning matches the quotes** (faithfulness judge): supported"] == ["—", "1 / 1"]
    assert rows["I don't know where expected (1)"] == ["0 / 1", "1 / 1"]
    assert rows["  with a clarifying question"] == ["0 / 1", "1 / 1"]
    assert rows["  of them before the LLM (relevance below the threshold)"] == ["0", "1"]
    assert rows["correctness judge (correct 1, partial ½)"] == ["1.0 / 2", "2.0 / 2"]
    assert rows["answers retried for format or quotes"] == ["0", "1"]
    assert report.per_question_rows(data, qs)[0][2:] == ["✅ 1S 0Q", "✅ 1S 2/3Q F✓"]
    assert report.per_question_rows(data, qs)[1][2:] == ["❌ 1S 0Q", "✅ IDK+? ∅"]


def test_markdown_shows_sources_quotes_and_verdicts():
    data, qs = _data()
    md = report.markdown(data, qs)
    assert "`a.pdf` · 2 · p. 1 · `a:0001`" in md and "- ✓ 100 [1] “q”" in md and "(dropped)" in md
    assert "Faithfulness: **supported**" in md


def test_write_markdown_keeps_text_around_markers(tmp_path):
    p = tmp_path / "EVAL.md"
    report.write_markdown(p, "one\n")
    p.write_text(p.read_text().replace("I don't know\n", "I don't know\n\nmy notes\n"))
    report.write_markdown(p, "two\n")
    text = p.read_text()
    assert "my notes" in text and "two" in text and "one" not in text
