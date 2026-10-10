"""`bench`: freeze the retrieval, run variants, print the comparison."""

from __future__ import annotations

import argparse
import sys

from . import evalset, freeze, report
from .bench import RESULTS, rescore, run
from .hits import TASK_DIR
from .variants import BY_NAME, VARIANTS, modelfile


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="bench", description="Optimize qwen3 for task 27's cited RAG answers.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("freeze", help="retrieve once per question → contexts.json")
    sub.add_parser("list", help="the variants")
    sub.add_parser("modelfile", help="write the qwen3-rag Modelfile (then: ollama create qwen3-rag -f Modelfile)")
    r = sub.add_parser("run", help="run variants (default: all) → results/<variant>.json")
    r.add_argument("variants", nargs="*")
    r.add_argument("-n", "--repeats", type=int, default=3, help="runs of a sampling (temperature > 0) variant")
    r.add_argument("-q", "--question", action="append", help="only these question ids (a quick check)")
    sub.add_parser("rescore", help="score the saved replies again (after an eval-set or scorer change)")
    rep = sub.add_parser("report", help="the comparison table")
    rep.add_argument("--per-question", action="store_true")
    a = p.parse_args(argv)

    questions = evalset.load()
    if a.cmd == "freeze":
        for c in freeze.freeze(questions):
            mark = {True: "found", False: "MISSED", None: "-"}[c["retrieved"]]
            print(f"{c['id']}  {mark:6}  " + ", ".join(f"{h['source'][:10]} p{h['page_start']} {h['rerank']:.2f}"
                                                      for h in c["hits"]))
    elif a.cmd == "list":
        for v in VARIANTS:
            print(f"{v.name:10} {v.group:9} {v.model:16} {v.template:7} think={v.think!s:5} "
                  f"format={v.format_label:6} {v.options}  {v.note}")
    elif a.cmd == "modelfile":
        path = TASK_DIR / "Modelfile"
        path.write_text(modelfile())
        print(f"wrote {path}; now: ollama create qwen3-rag -f Modelfile")
    elif a.cmd == "run":
        names = a.variants or [v.name for v in VARIANTS]
        unknown = [n for n in names if n not in BY_NAME]
        if unknown:
            sys.exit(f"unknown variant(s): {unknown}; see `bench list`")
        contexts = freeze.load()
        questions = [q for q in questions if q.id in contexts and (not a.question or q.id in a.question)]
        for n in names:
            print(f"== {n}", flush=True)
            path = run(BY_NAME[n], questions, contexts, a.repeats, log=lambda s: print(s, flush=True))
            print(f"   → {path}")
    elif a.cmd == "rescore":
        contexts = freeze.load()
        for path in sorted(RESULTS.glob("*.json")):
            rescore(path, questions, contexts)
            print(f"rescored {path.name}")
    elif a.cmd == "report":
        runs = report.load_all()
        print(report.table(runs))
        if a.per_question:
            print()
            print(report.per_question(runs))


if __name__ == "__main__":
    main()
