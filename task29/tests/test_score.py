import json

from opt import prompts, report
from opt.evalset import Question, Source
from opt.hits import Hit
from opt.score import score
from opt.variants import VARIANTS

HITS = [
    Hit(1, 0.8, "a", "tts.pdf", "TatarTTS", "", 2, 2, "The corpus contains 70 hours of speech from two speakers, one male and one female."),
    Hit(2, 0.7, "b", "book.pdf", "Gutless", "", 10, 10, "Multiply your weight in pounds by 10 to 12."),
]
FACT = Question("q1", "fact", "How many hours?", "", (("70",), ("two",)), (Source("tts.pdf", (2,)),))
NONE = Question("q2", "unanswerable", "Creatine?", "", (), ())


def reply(**kw) -> str:
    return json.dumps({"status": "answer", "answer": "", "citations": [], "clarification": "", **kw})


def test_correct_answer():
    s = score(FACT, reply(answer="70 hours from two speakers [1].",
                          citations=[{"ref": 1, "quote": "The corpus contains 70 hours of speech from two speakers"}]), HITS)
    assert s.correct and s.score == 1.0 and s.quotes_ok == 1


def test_paraphrased_quote_costs_a_quarter():
    s = score(FACT, reply(answer="70 hours, two speakers [1].",
                          citations=[{"ref": 1, "quote": "There are seventy hours recorded by a pair of people"}]), HITS)
    assert not s.correct and s.score == 0.75 and s.quotes_ok == 0


def test_wrong_source_and_missing_fact():
    s = score(FACT, reply(answer="70 hours [2].", citations=[{"ref": 2, "quote": "Multiply your weight in pounds by 10 to 12."}]), HITS)
    assert not s.correct and not s.source_ok and s.facts == 0.5


def test_invalid_json_scores_zero():
    s = score(FACT, "Sure! The corpus has 70 hours.", HITS)
    assert not s.format_ok and s.score == 0 and "JSON" in s.format_error


def test_unknown_on_answerable_is_wrong():
    s = score(FACT, reply(status="unknown", clarification="Which corpus?"), HITS)
    assert s.format_ok and not s.status_ok and s.score == 0


def test_unanswerable_needs_unknown():
    assert score(NONE, reply(status="unknown", clarification="It doesn't say. Something else?"), HITS).correct
    s = score(NONE, reply(answer="5 g [2].", citations=[{"ref": 2, "quote": "Multiply your weight"}]), HITS)
    assert not s.correct and s.score == 0


def test_every_template_renders_numbered_passages():
    for name in prompts.TEMPLATES:
        msgs = prompts.messages(name, "How many hours?", HITS)
        assert msgs[0]["role"] == "system" and "[2] Gutless (book.pdf), p. 10" in msgs[-1]["content"]
    assert [m["role"] for m in prompts.messages("tuned", "q", HITS, with_system=False)] == ["user"]


def test_variants_are_unique():
    assert len({v.name for v in VARIANTS}) == len(VARIANTS)


def test_report_summary():
    rec = dict(id="q1", kind="fact", correct=True, score=1.0, format_ok=True, facts=1.0, status="answer",
               quotes_total=2, quotes_ok=1, rep=0, done_reason="stop", wall_s=2.0, completion_tokens=100, eval_s=4.0,
               prompt_tokens=1000, prompt_s=2.0, load_s=0.0)
    run = {"variant": "x", "note": "", "model": "m", "cold_load_s": 3.0, "repeats": 1,
           "memory": {"size_mb": 2048, "context_length": 8192},
           "records": [rec, {**rec, "id": "q2", "kind": "unanswerable", "status": "unknown", "correct": False, "score": 0.0}]}
    s = report.summary(run)
    assert s["correct"] == 0.5 and s["quotes"] == 0.5 and s["idk"] == 1.0 and s["gen_tps"] == 25 and s["mem_gb"] == 2
    assert "| x |" in report.table([run])
