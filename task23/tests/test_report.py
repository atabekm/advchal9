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


def _data():
    qs = [Question("q1", "fact", "?", "70 h", (("70",),), (Source("a.pdf", (1,)),)),
          Question("q2", "unanswerable", "?", "none", (("not",),), ())]

    def res(qid, label, verdict, kw, hit=None, halluc=False, pool_rank=None, early=False):
        return {"id": qid, "label": label, "answer": "a", "keywords": kw, "keywords_matched": [kw == 1],
                "retrieval": None if hit is None else {"hit": hit, "recall": float(hit), "first_rank": 1 if hit else None},
                "pool": None if pool_rank is None else {"hit": True, "first_rank": pool_rank, "size": 20},
                "early_refusal": early, "timings": {} if label == "plain" else {"search": 0.1, "rerank": 0.5, "answer": 1.0},
                "cited": [], "cited_expected": None if label == "plain" or qid == "q2" else hit,
                "context": [], "prompt_tokens": 10, "completion_tokens": 5, "seconds": 1.0,
                "judge": {"verdict": verdict, "hallucination": halluc, "reason": "r"}}

    data = {"created": "t", "model": "m", "judge_model": "m", "k": 5, "labels": ["plain", "rerank"],
            "results": [res("q1", "plain", "wrong", 0.0, halluc=True), res("q2", "plain", "refused", 0.0),
                        res("q1", "rerank", "correct", 1.0, hit=True, pool_rank=6),
                        res("q2", "rerank", "refused", 1.0, early=True)]}
    return data, qs


def test_summary_counts_refusal_on_unanswerable_as_correct():
    data, qs = _data()
    rows = dict(report.summary_rows(data, qs))
    assert rows["judge score (correct 1, partial ½)"] == ["1.0 / 2", "2.0 / 2"]
    assert rows["hallucinations (judge)"] == ["1", "0"]
    assert rows["in the context, hit@5 (answerable)"] == ["—", "1 / 1"]
    assert rows["in the candidate pool (answerable)"] == ["—", "1 / 1"]
    assert rows["refused before the LLM: unanswerable"] == ["—", "1 / 1"]
    assert rows["latency: rerank (mean)"] == ["—", "0.50s"] and rows["latency: total (mean)"] == ["1.0s", "1.6s"]
    assert report.per_question_rows(data, qs)[0][3] == "✅ 100% · r1 ←#6"
    assert report.per_question_rows(data, qs)[1] == ["q2", "unanswerable", "✅ 0%", "✅ 100% ∅"]
    assert len(report.disagreements(data, qs)) == 1  # q2 plain: no keywords, counted correct


def test_write_markdown_keeps_text_around_markers(tmp_path):
    p = tmp_path / "EVAL.md"
    report.write_markdown(p, "one\n")
    p.write_text(p.read_text().replace("query rewriting\n", "query rewriting\n\nmy notes\n"))
    report.write_markdown(p, "two\n")
    text = p.read_text()
    assert "my notes" in text and "two" in text and "one" not in text
