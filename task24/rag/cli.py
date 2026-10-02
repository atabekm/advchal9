"""rag — answer questions about the indexed documents, with sources and quotes, or "I don't know".

  rag ask  "question" [--mode rewrite+rerank] [--style cited|legacy] [--json] [--k-before 20] [--k-after 5]
           [--threshold T] [--show-context]
           modes: plain (no retrieval), base (cosine top-k), cos-filter (top-k within --cos-delta of the
           best cosine score), rerank (cosine pool → cross-encoder → top-k over --threshold)
  rag chat [--mode rerank] …
           in chat: /rag on|off  /mode M  /style cited|legacy  /threshold T  /k-before N  /k-after N
                    /context on|off  /quit
           rewrite (the question + 1-3 LLM rewrites, fused), rewrite+rerank (that pool → cross-encoder)
  rag check [--rewrite] [--k-before N] [--k-after N]   retrieval only: ranks before and after reranking
  rag calibrate [--k-before N] [--k-after N]     score distributions and the cutoff sweeps, no LLM
  rag eval  [--modes base,rerank] [--markdown EVAL.md]        all questions × all modes, judged
  rag eval  --rejudge eval/run-….json            grade saved answers again (or --report to only print)
"""

from __future__ import annotations

import argparse
import json
import sys
import textwrap
from dataclasses import replace
from pathlib import Path

from indexer.embed import EmbedError

from . import evalset, evaluate, report
from .agent import STYLES, Agent, Answer
from .llm import MODELS, DeepSeek, LLMError
from . import calibrate
from .pipeline import (DEFAULT_COS_DELTA, DEFAULT_K_AFTER, DEFAULT_K_BEFORE, DEFAULT_MODE, DEFAULT_THRESHOLDS, MODES,
                       Config, Pipeline, Retrieval)
from .rerank import DEFAULT_MODEL as DEFAULT_RERANKER
from .rerank import Reranker
from .rewrite import Rewriter
from .retrieve import DEFAULT_DB, IndexMissing, Retriever

WIDTH = 100
ALL_MODES = ("plain", *MODES)


def _modes(text: str) -> list[str]:
    """Comma-separated modes; a rerank mode may carry its own threshold: rerank@0.3."""
    modes = [m.strip() for m in text.split(",") if m.strip()]
    for m in modes:
        if m == "plain":
            continue
        try:
            Config.parse(m)
        except ValueError as e:
            raise argparse.ArgumentTypeError(f"{m}: {e}; modes are {list(ALL_MODES)}, optionally mode@threshold")
    if not modes:
        raise argparse.ArgumentTypeError("no modes")
    return modes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rag", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def retrieval(p):
        p.add_argument("--db", type=Path, default=DEFAULT_DB)
        p.add_argument("--k-before", type=int, default=DEFAULT_K_BEFORE, help="cosine candidates for the reranker")
        p.add_argument("--k-after", type=int, default=DEFAULT_K_AFTER, help="chunks that go into the prompt")
        p.add_argument("--threshold", type=float, help="rerank modes: minimum cross-encoder score (default: "
                       + ", ".join(f"{m} {t:g}" for m, t in DEFAULT_THRESHOLDS.items()) + ")")
        p.add_argument("--cos-delta", type=float, default=DEFAULT_COS_DELTA,
                       help="cos-filter: maximum distance from the best cosine score")
        p.add_argument("--reranker-model", default=DEFAULT_RERANKER)

    ask = sub.add_parser("ask", help="answer one question")
    ask.add_argument("question")
    ask.add_argument("--mode", type=_modes, default=[DEFAULT_MODE], help=f"comma-separated: {','.join(ALL_MODES)}; rerank@0.3 sets a threshold")
    ask.add_argument("--model", choices=MODELS, default=MODELS[0])
    ask.add_argument("--show-context", action="store_true", help="print the retrieved chunks")
    ask.add_argument("--style", choices=STYLES, default=STYLES[0], help="cited: JSON with quotes; legacy: task 23's free text")
    ask.add_argument("--json", action="store_true", help="print the structured answer as JSON")
    retrieval(ask)

    chat = sub.add_parser("chat", help="interactive session with RAG and reranker switches")
    chat.add_argument("--mode", choices=ALL_MODES, default=DEFAULT_MODE)
    chat.add_argument("--model", choices=MODELS, default=MODELS[0])
    chat.add_argument("--show-context", action="store_true")
    chat.add_argument("--style", choices=STYLES, default=STYLES[0])
    retrieval(chat)

    check = sub.add_parser("check", help="retrieval check of the control questions, no LLM")
    check.add_argument("--questions", type=Path, default=evalset.DEFAULT_QUESTIONS)
    check.add_argument("--rewrite", action="store_true", help="search with the question and its rewrites (calls the LLM)")
    check.add_argument("--model", choices=MODELS, default=MODELS[0], help="model that rewrites")
    retrieval(check)

    cal = sub.add_parser("calibrate", help="pick the cutoffs: score distributions and sweeps, no LLM")
    cal.add_argument("--questions", type=Path, default=evalset.DEFAULT_QUESTIONS)
    cal.add_argument("--rewrite", action="store_true", help="calibrate rewrite+rerank (calls the LLM)")
    cal.add_argument("--model", choices=MODELS, default=MODELS[0], help="model that rewrites")
    retrieval(cal)

    ev = sub.add_parser("eval", help="answer every control question in every mode, score, report")
    ev.add_argument("--questions", type=Path, default=evalset.DEFAULT_QUESTIONS)
    ev.add_argument("--model", choices=MODELS, default=MODELS[0], help="model that answers")
    ev.add_argument("--judge-model", choices=MODELS, help="model that grades (default: --model)")
    ev.add_argument("--modes", type=_modes, default=list(MODES), help=f"comma-separated: {','.join(ALL_MODES)}; rerank@0.3 sets a threshold")
    ev.add_argument("--workers", type=int, default=6, help="parallel LLM calls")
    ev.add_argument("--markdown", type=Path, help="write the tables into this file (between the eval markers)")
    saved = ev.add_mutually_exclusive_group()
    saved.add_argument("--rejudge", type=Path, metavar="RUN", help="grade the answers of a saved run again")
    saved.add_argument("--report", type=Path, metavar="RUN", help="print / write the report of a saved run")
    retrieval(ev)

    args = ap.parse_args(argv)
    try:
        return {"ask": cmd_ask, "chat": cmd_chat, "check": cmd_check, "calibrate": cmd_calibrate, "eval": cmd_eval}[args.cmd](args)
    except (EmbedError, IndexMissing, LLMError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _pipeline(args, llm: DeepSeek | None = None) -> Pipeline:
    """`llm` enables the rewrite modes."""
    retriever = Retriever(args.db)
    return Pipeline(retriever, Reranker(args.reranker_model), Rewriter(llm, retriever.titles()) if llm else None)


def _config(args, mode: str) -> Config | None:
    if mode == "plain":
        return None
    config = Config.parse(mode, k_before=args.k_before, k_after=args.k_after, cos_delta=args.cos_delta)
    return config if args.threshold is None or "@" in mode else replace(config, threshold=args.threshold)


def cmd_ask(args) -> int:
    llm = DeepSeek(args.model)
    agent = Agent(llm, _pipeline(args, llm), args.style)
    answers = []
    for mode in args.mode:
        ans = agent.answer(args.question, _config(args, mode))
        if args.json:
            answers.append(answer_json(ans))
            continue
        if ans.retrieval and args.show_context:
            print_context(ans.retrieval)
        print_answer(ans)
    if args.json:
        print(json.dumps(answers[0] if len(answers) == 1 else answers, ensure_ascii=False, indent=2))
    return 0


def cmd_chat(args) -> int:
    llm = DeepSeek(args.model)
    agent = Agent(llm, _pipeline(args, llm), args.style)
    rag, mode = args.mode != "plain", (args.mode if args.mode != "plain" else DEFAULT_MODE)
    k_before, k_after, threshold, show = args.k_before, args.k_after, args.threshold, args.show_context
    print(f"rag chat · {args.model} · type /help for commands")
    while True:
        config = Config(mode, k_before, k_after, threshold, args.cos_delta) if rag else None
        prompt_label = "plain" if config is None else f"{mode} {k_before}→{k_after}" + (f" ≥{config.threshold:g}" if config.reranks else "")
        try:
            line = input(f"\n[{prompt_label}] › ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            continue
        if line.startswith("/"):
            cmd, _, arg = line[1:].partition(" ")
            arg = arg.strip()
            if cmd in ("quit", "exit", "q"):
                return 0
            elif cmd == "rag" and arg in ("on", "off"):
                rag = arg == "on"
            elif cmd == "mode" and arg in MODES:
                mode, rag = arg, True
            elif cmd == "threshold" and _float01(arg) is not None:
                threshold = _float01(arg)
            elif cmd in ("k-before", "k-after") and arg.isdigit() and int(arg) > 0:
                k_before, k_after = (int(arg), min(k_after, int(arg))) if cmd == "k-before" else (max(k_before, int(arg)), int(arg))
            elif cmd == "context" and arg in ("on", "off"):
                show = arg == "on"
            elif cmd == "style" and arg in STYLES:
                agent.style = arg
            else:
                print(f"  /rag on|off   /mode {'|'.join(MODES)}   /style {'|'.join(STYLES)}   /threshold 0..1"
                      "   /k-before N   /k-after N   /context on|off   /quit")
            continue
        try:
            ans = agent.answer(line, config)
        except (EmbedError, LLMError) as e:
            print(f"error: {e}")
            continue
        if ans.retrieval and show:
            print_context(ans.retrieval)
        print_answer(ans)


def _float01(text: str) -> float | None:
    try:
        x = float(text)
    except ValueError:
        return None
    return x if 0 <= x <= 1 else None


def cmd_check(args) -> int:
    """Where the first expected chunk ranks in the cosine pool, and where the reranker puts it."""
    questions = evalset.load(args.questions)
    pipeline = _pipeline(args, DeepSeek(args.model) if args.rewrite else None)
    config = Config("rewrite+rerank" if args.rewrite else "rerank", args.k_before, args.k_after, threshold=0.0)
    kb, ka = args.k_before, args.k_after
    answerable = [q for q in questions if q.answerable]
    totals = {"pool": 0, "base": 0, "rerank": 0}
    first = "fused" if args.rewrite else "cosine"
    print(f"{'id':4}  {'kind':12}  {f'pool@{kb}':>10}  {f'{first}@{ka}':>10}  {f'rerank@{ka}':>10}   top after rerank")
    for q in questions:
        r = pipeline.retrieve(q.question, config)
        if args.rewrite:
            print(f"{'':20}" + " | ".join(r.queries[1:]) + (f"  ({r.rewrite.error})" if r.rewrite.error else ""))
        ranked = r.ranked  # the whole reranked pool, to see where misses land
        top = ranked[0]
        top_txt = f"{top.rerank:.3f}  {top.source} {top.pages}  ({first} #{top.cosine_rank})"
        checks = {"pool": evalset.retrieval_check(q, r.pool), "base": evalset.retrieval_check(q, r.pool),
                  "rerank": evalset.retrieval_check(q, ranked)}
        if checks["pool"] is None:
            print(f"{q.id:4}  {q.kind:12}  {'n/a':>10}  {'n/a':>10}  {'n/a':>10}   {top_txt}")
            continue
        cells = []
        for name, rc in checks.items():
            rank = rc.first_rank
            found = rank is not None and (name == "pool" or rank <= ka)
            hit = rc.hit if name == "pool" else evalset.retrieval_check(q, (r.pool if name == "base" else ranked)[:ka]).hit
            totals[name] += hit
            cells.append(f"{('hit' if hit else 'part' if found else 'miss') + (f' #{rank}' if rank else ''):>10}")
        print(f"{q.id:4}  {q.kind:12}  " + "  ".join(cells) + f"   {top_txt}")
    pipeline.retriever.close()
    n = len(answerable)
    print(f"\nover {n} answerable questions: in the pool ({kb} per query): {totals['pool']}/{n}, "
          f"in the top {ka} by {first}: {totals['base']}/{n}, after reranking: {totals['rerank']}/{n}")
    return 0


def cmd_calibrate(args) -> int:
    questions = evalset.load(args.questions)
    pipeline = _pipeline(args, DeepSeek(args.model) if args.rewrite else None)
    scored = calibrate.collect(questions, pipeline, args.k_before, "rewrite+rerank" if args.rewrite else "rerank")
    pipeline.retriever.close()
    ka = args.k_after

    def f(x):
        return "—" if x is None else f"{x:.3f}"

    print(f"best relevant vs best irrelevant chunk in the pool of {args.k_before} (relevant = from an expected source)\n")
    print(f"{'id':4}  {'kind':12}  {'rerank: rel':>11} {'(rank)':>6} {'irrel':>7}   {'cosine: top':>11} {'rel':>7} {'irrel':>7}")
    for s in scored:
        d = calibrate.per_question(s)
        rank = f"#{d['rel_rank']}" if d["rel_rank"] else ""
        print(f"{s.question.id:4}  {s.question.kind:12}  {f(d['rel_rerank']):>11} {rank:>6} {f(d['irr_rerank']):>7}   "
              f"{f(d['top_cos']):>11} {f(d['rel_cos']):>7} {f(d['irr_cos']):>7}")

    n_ans = sum(q.answerable for q in questions)
    n_un = len(questions) - n_ans
    for title, name, rows in (
        (f"{'rewrite+' if args.rewrite else ''}rerank: cosine top {args.k_before} → cross-encoder → top {ka}, keep score ≥ threshold", "threshold",
         calibrate.rerank_sweep(scored, ka)),
        *([] if args.rewrite else [
            (f"cos-filter: cosine top {ka}, keep cosine ≥ best − delta", "delta", calibrate.cosine_sweep(scored, ka))]),
    ):
        print(f"\n{title}\n")
        print(f"{name:>9}  {f'hit@{ka}':>8}  {'answerable':>10}  {'unanswerable':>12}  {'relevant':>8}  {'irrelevant':>10}  {'chunks':>6}")
        print(f"{'':9}  {'':8}  {'emptied':>10}  {'emptied':>12}  {'kept':>8}  {'kept':>10}  {'mean':>6}")
        best = calibrate.suggest(rows)
        for r in rows:
            mark = "  ◀ suggested" if r is best else ""
            print(f"{r.cutoff:>9.2f}  {f'{r.hits}/{n_ans}':>8}  {r.answerable_emptied:>10}  {f'{r.unanswerable_emptied}/{n_un}':>12}  "
                  f"{r.relevant_kept:>8}  {r.irrelevant_kept:>10}  {r.mean_kept:>6.1f}{mark}")
    return 0


def cmd_eval(args) -> int:
    questions = evalset.load(args.questions)
    if args.report:
        data = evaluate.load(args.report)
    else:
        judge_llm = DeepSeek(args.judge_model or args.model)
        if args.rejudge:
            data = evaluate.load(args.rejudge)
            path = args.rejudge
        else:
            llm = DeepSeek(args.model)
            pipeline = _pipeline(args, llm)
            print(f"answering {len(questions)} questions × {len(args.modes)} modes with {args.model} …")
            try:
                data = evaluate.run(questions, pipeline, llm, args.modes, args.k_before,
                                    args.k_after, args.workers)
            finally:
                pipeline.retriever.close()
            path = evaluate.save(data)
            print(f"answers saved → {path}")
        print(f"grading with {judge_llm.model} …")
        data = evaluate.grade(data, questions, judge_llm, args.workers)
        evaluate.save(data, path)
        print(f"verdicts saved → {path}")
    print()
    print(report.terminal(data, questions))
    for line in report.disagreements(data, questions):
        print(f"  ! {line}")
    if args.markdown:
        report.write_markdown(args.markdown, report.markdown(data, questions))
        print(f"\nwrote {args.markdown}")
    return 0


def print_context(r: Retrieval) -> None:
    c = r.config
    reranked = c.reranks
    head = {"base": f"base: cosine top {c.k_after}",
            "cos-filter": f"cos-filter: cosine top {c.k_after} within {c.cos_delta:g} of the best",
            "rerank": f"rerank: cosine top {c.k_before} → cross-encoder → top {c.k_after} ≥ {c.threshold:g}",
            "rewrite": f"rewrite: {len(r.queries)} queries × cosine top {c.k_before}, fused → top {c.k_after}",
            "rewrite+rerank": f"rewrite+rerank: {len(r.queries)} queries × cosine top {c.k_before}, fused ({len(r.pool)}) "
                              f"→ cross-encoder → top {c.k_after} ≥ {c.threshold:g}"}[c.mode]
    t = "  ".join(f"{k} {v:.2f}s" for k, v in r.timings.items())
    print(f"── context ({head};  {t})")
    if c.rewrites:
        print("  queries: " + "\n           ".join(r.queries) + (f"\n  rewrite failed: {r.rewrite.error}" if r.rewrite.error else ""))
    for h in r.kept:
        scores = f"rerank {h.rerank:.3f} · {'fused' if c.rewrites else 'cos'} #{h.cosine_rank} {h.score:.3f}" if reranked else f"cos {h.score:.3f}"
        print(f"  [{h.rank}] {scores}  {h.source}  {h.pages}  {h.section or '—'}")
        snippet = " ".join(h.text.split())
        snippet = snippet[:300] + ("…" if len(snippet) > 300 else "")
        print(textwrap.indent(textwrap.fill(snippet, WIDTH - 6), " " * 6))
    kept = {h.chunk_id for h in r.kept}
    if reranked:
        dropped = [h for h in r.ranked if h.chunk_id not in kept]
        print(f"  not kept ({len(dropped)}; top {c.k_after}, score ≥ {c.threshold:g}):")
        for h in dropped:
            print(f"    #{h.rank:<2} rerank {h.rerank:.3f} · cos #{h.cosine_rank:<2} {h.score:.3f}  {h.source}  {h.pages}  {h.section or '—'}")
    elif c.mode == "cos-filter":
        dropped = [h for h in r.ranked[:c.k_after] if h.chunk_id not in kept]
        print(f"  dropped from the top {c.k_after} ({len(dropped)}; cosine < {r.pool[0].score - c.cos_delta:.3f}):")
        for h in dropped:
            print(f"    cos #{h.rank:<2} {h.score:.3f}  {h.source}  {h.pages}  {h.section or '—'}")
    print()


def _source_line(h) -> str:
    return f"[{h.rank}] {h.source} · {h.section or '—'} · {h.pages} · {h.chunk_id}"


def print_answer(ans: Answer) -> None:
    if ans.early_refusal:
        print(f"── {ans.label}  (no chunk passed the filter: refused without calling the LLM)")
    else:
        tries = f", {ans.attempts} attempts" if ans.attempts > 1 else ""
        print(f"── {ans.label}  ({ans.prompt_tokens}→{ans.completion_tokens} tokens, {ans.seconds:.1f}s{tries})")
    if ans.format_error:
        print(f"  ! format error{'' if ans.unknown and not ans.clarification else ', fixed on retry'}: {ans.format_error}")
    for para in ans.text.splitlines():
        print(textwrap.fill(para, WIDTH, initial_indent="  ", subsequent_indent="  ") if para.strip() else "")
    if ans.retrieval is None or ans.unknown:
        print()
        return
    print("  Sources")
    for h in ans.cited:
        print(f"    {_source_line(h)}")
    if not ans.cited:
        print("    none cited")
    if ans.style == "cited":
        print("  Quotes")
        for q in ans.quotes:
            print(textwrap.fill(f'[{q.ref}] "{q.text}"', WIDTH, initial_indent="    ", subsequent_indent="        "))
    print()


def answer_json(ans: Answer) -> dict:
    return {
        "mode": ans.label, "question": ans.question, "status": ans.status, "answer": ans.text,
        "sources": [{"ref": h.rank, "source": h.source, "title": h.title, "section": h.section, "pages": h.pages,
                     "chunk_id": h.chunk_id} for h in ans.cited],
        "quotes": [{"ref": q.ref, "quote": q.text} for q in ans.quotes],
        "clarification": ans.clarification,
        "attempts": ans.attempts, "format_error": ans.format_error or None,
    }
