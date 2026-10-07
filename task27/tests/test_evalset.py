import json

import pytest

from rag import evalset
from rag.evalset import Question, Source
from rag.retrieve import Hit


def _hit(rank, source, p0, p1=None):
    return Hit(rank, 0.5, f"c{rank}", source, "T", "", p0, p1 or p0, "text")


def _q(sources=(Source("a.pdf", (3,)),), groups=(("70",), ("male", "man"))):
    return Question("q", "fact", "?", "", tuple(groups), tuple(sources))


def test_keyword_groups_need_one_alternative_each():
    q = _q(groups=(("1850", "1,850"), ("2220",)))
    assert evalset.keyword_score(q, "Between 1,850 and 2,220 kcal") == (1.0, [True, True])
    assert evalset.keyword_score(q, "about 1850") == (0.5, [True, False])
    assert evalset.keyword_score(_q(groups=(("doesn't",),)), "It doesn’t say.")[0] == 1.0


def test_retrieval_check_pages_and_ranks():
    q = _q(sources=(Source("a.pdf", (3,)), Source("b.pdf", ())))
    rc = evalset.retrieval_check(q, [_hit(1, "a.pdf", 1), _hit(2, "a.pdf", 2, 4), _hit(3, "c.pdf", 3)])
    assert rc.found == (True, False) and rc.first_rank == 2 and not rc.hit and rc.recall == 0.5
    rc = evalset.retrieval_check(q, [_hit(1, "b.pdf", 9), _hit(2, "a.pdf", 3)])
    assert rc.hit and rc.first_rank == 1
    assert evalset.retrieval_check(_q(sources=()), [_hit(1, "a.pdf", 3)]) is None


def test_cited_expected():
    q = _q()
    assert evalset.cited_expected(q, [_hit(2, "a.pdf", 3)]) is True
    assert evalset.cited_expected(q, [_hit(1, "a.pdf", 5)]) is False
    assert evalset.cited_expected(_q(sources=()), []) is None


def test_load_validates(tmp_path):
    good = {"id": "q1", "kind": "fact", "question": "?", "expect": "", "must_contain": [["x"]],
            "sources": [{"source": "a.pdf", "pages": [1]}]}
    p = tmp_path / "q.json"
    p.write_text(json.dumps([good]))
    assert evalset.load(p)[0].sources == (Source("a.pdf", (1,)),)
    p.write_text(json.dumps([{**good, "kind": "unanswerable"}]))
    with pytest.raises(ValueError):
        evalset.load(p)
    p.write_text(json.dumps([good, good]))
    with pytest.raises(ValueError):
        evalset.load(p)


def test_shipped_questions_load():
    qs = evalset.load()
    assert len(qs) == 10 and sum(not q.answerable for q in qs) == 3 and {q.kind for q in qs} >= set(evalset.NO_ANSWER)
