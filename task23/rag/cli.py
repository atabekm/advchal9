"""rag — answer questions about the indexed documents: cosine search, then a cross-encoder reranker.

  rag ask  "question" [--mode base,rerank] [--k-before 20] [--k-after 5] [--show-context]
           modes: plain (no retrieval), base (cosine top-k), rerank (cosine pool → cross-encoder)
  rag chat [--mode rerank] …
           in chat: /rag on|off  /rerank on|off  /k-before N  /k-after N  /context on|off  /quit
  rag check [--questions FILE] [--k-before N] [--k-after N]   retrieval only: ranks before and after reranking
  rag eval  [--modes base,rerank] [--markdown EVAL.md]        all questions × all modes, judged
  rag eval  --rejudge eval/run-….json            grade saved answers again (or --report to only print)
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from pathlib import Path

from indexer.embed import EmbedError

from . import evalset, evaluate, report
from .agent import Agent, Answer
from .llm import MODELS, DeepSeek, LLMError
from .pipeline import DEFAULT_K_AFTER, DEFAULT_K_BEFORE, DEFAULT_MODE, MODES, Config, Pipeline, Retrieval
from .rerank import DEFAULT_MODEL as DEFAULT_RERANKER
from .rerank import Reranker
from .retrieve import DEFAULT_DB, IndexMissing, Retriever

WIDTH = 100
ALL_MODES = ("plain", *MODES)


def _modes(text: str) -> list[str]:
    modes = [m.strip() for m in text.split(",") if m.strip()]
    bad = [m for m in modes if m not in ALL_MODES]
    if bad or not modes:
        raise argparse.ArgumentTypeError(f"unknown modes {bad}, expected a comma-separated list of {list(ALL_MODES)}")
    return modes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rag", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def retrieval(p):
        p.add_argument("--db", type=Path, default=DEFAULT_DB)
        p.add_argument("--k-before", type=int, default=DEFAULT_K_BEFORE, help="cosine candidates for the reranker")
        p.add_argument("--k-after", type=int, default=DEFAULT_K_AFTER, help="chunks that go into the prompt")
        p.add_argument("--reranker-model", default=DEFAULT_RERANKER)

    ask = sub.add_parser("ask", help="answer one question")
    ask.add_argument("question")
    ask.add_argument("--mode", type=_modes, default=["base", "rerank"], help=f"comma-separated: {','.join(ALL_MODES)}")
    ask.add_argument("--model", choices=MODELS, default=MODELS[0])
    ask.add_argument("--show-context", action="store_true", help="print the retrieved chunks")
    retrieval(ask)

    chat = sub.add_parser("chat", help="interactive session with RAG and reranker switches")
    chat.add_argument("--mode", choices=ALL_MODES, default=DEFAULT_MODE)
    chat.add_argument("--model", choices=MODELS, default=MODELS[0])
    chat.add_argument("--show-context", action="store_true")
    retrieval(chat)

    check = sub.add_parser("check", help="retrieval check of the control questions, no LLM")
    check.add_argument("--questions", type=Path, default=evalset.DEFAULT_QUESTIONS)
    retrieval(check)

    ev = sub.add_parser("eval", help="answer every control question in every mode, score, report")
    ev.add_argument("--questions", type=Path, default=evalset.DEFAULT_QUESTIONS)
    ev.add_argument("--model", choices=MODELS, default=MODELS[0], help="model that answers")
    ev.add_argument("--judge-model", choices=MODELS, help="model that grades (default: --model)")
    ev.add_argument("--modes", type=_modes, default=list(MODES), help=f"comma-separated: {','.join(ALL_MODES)}")
    ev.add_argument("--workers", type=int, default=6, help="parallel LLM calls")
    ev.add_argument("--markdown", type=Path, help="write the tables into this file (between the eval markers)")
    saved = ev.add_mutually_exclusive_group()
    saved.add_argument("--rejudge", type=Path, metavar="RUN", help="grade the answers of a saved run again")
    saved.add_argument("--report", type=Path, metavar="RUN", help="print / write the report of a saved run")
    retrieval(ev)

    args = ap.parse_args(argv)
    try:
        return {"ask": cmd_ask, "chat": cmd_chat, "check": cmd_check, "eval": cmd_eval}[args.cmd](args)
    except (EmbedError, IndexMissing, LLMError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _pipeline(args) -> Pipeline:
    return Pipeline(Retriever(args.db), Reranker(args.reranker_model))


def _config(args, mode: str) -> Config | None:
    return None if mode == "plain" else Config(mode, args.k_before, args.k_after)


def cmd_ask(args) -> int:
    agent = Agent(DeepSeek(args.model), _pipeline(args))
    for mode in args.mode:
        ans = agent.answer(args.question, _config(args, mode))
        if ans.retrieval and args.show_context:
            print_context(ans.retrieval)
        print_answer(ans)
    return 0


def cmd_chat(args) -> int:
    agent = Agent(DeepSeek(args.model), _pipeline(args))
    rag, rerank = args.mode != "plain", args.mode != "base"
    k_before, k_after, show = args.k_before, args.k_after, args.show_context
    print(f"rag chat · {args.model} · type /help for commands")
    while True:
        config = Config("rerank" if rerank else "base", k_before, k_after) if rag else None
        prompt_label = "plain" if config is None else f"{config.mode} {k_before}→{k_after}"
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
            elif cmd == "rerank" and arg in ("on", "off"):
                rerank = arg == "on"
            elif cmd in ("k-before", "k-after") and arg.isdigit() and int(arg) > 0:
                k_before, k_after = (int(arg), min(k_after, int(arg))) if cmd == "k-before" else (max(k_before, int(arg)), int(arg))
            elif cmd == "context" and arg in ("on", "off"):
                show = arg == "on"
            else:
                print("  /rag on|off   /rerank on|off   /k-before N   /k-after N   /context on|off   /quit")
            continue
        try:
            ans = agent.answer(line, config)
        except (EmbedError, LLMError) as e:
            print(f"error: {e}")
            continue
        if ans.retrieval and show:
            print_context(ans.retrieval)
        print_answer(ans)


def cmd_check(args) -> int:
    """Where the first expected chunk ranks in the cosine pool, and where the reranker puts it."""
    questions = evalset.load(args.questions)
    pipeline = _pipeline(args)
    config = Config("rerank", args.k_before, args.k_after)
    kb, ka = args.k_before, args.k_after
    answerable = [q for q in questions if q.answerable]
    totals = {"pool": 0, "base": 0, "rerank": 0}
    print(f"{'id':4}  {'kind':12}  {f'pool@{kb}':>10}  {f'cosine@{ka}':>10}  {f'rerank@{ka}':>10}   top after rerank")
    for q in questions:
        r = pipeline.retrieve(q.question, config)
        ranked = r.ranked  # the whole reranked pool, to see where misses land
        top = ranked[0]
        top_txt = f"{top.rerank:.3f}  {top.source} {top.pages}  (cosine #{top.cosine_rank})"
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
    print(f"\nover {n} answerable questions: in the pool of {kb}: {totals['pool']}/{n}, "
          f"in the top {ka} by cosine: {totals['base']}/{n}, after reranking: {totals['rerank']}/{n}")
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
            pipeline = _pipeline(args)
            print(f"answering {len(questions)} questions × {len(args.modes)} modes with {args.model} …")
            try:
                data = evaluate.run(questions, pipeline, DeepSeek(args.model), args.modes, args.k_before,
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
    head = f"{c.mode}: cosine top {c.k_before} → cross-encoder → top {c.k_after}" if reranked else f"{c.mode}: cosine top {c.k_after}"
    t = "  ".join(f"{k} {v:.2f}s" for k, v in r.timings.items())
    print(f"── context ({head};  {t})")
    for h in r.kept:
        scores = f"rerank {h.rerank:.3f} · cos #{h.cosine_rank} {h.score:.3f}" if reranked else f"cos {h.score:.3f}"
        print(f"  [{h.rank}] {scores}  {h.source}  {h.pages}  {h.section or '—'}")
        snippet = " ".join(h.text.split())
        snippet = snippet[:300] + ("…" if len(snippet) > 300 else "")
        print(textwrap.indent(textwrap.fill(snippet, WIDTH - 6), " " * 6))
    if reranked:
        dropped = r.ranked[len(r.kept):]
        print(f"  not kept ({len(dropped)}):")
        for h in dropped:
            print(f"    #{h.rank:<2} rerank {h.rerank:.3f} · cos #{h.cosine_rank:<2} {h.score:.3f}  {h.source}  {h.pages}  {h.section or '—'}")
    print()


def print_answer(ans: Answer) -> None:
    print(f"── {ans.label}  ({ans.prompt_tokens}→{ans.completion_tokens} tokens, {ans.seconds:.1f}s)")
    for para in ans.text.splitlines():
        print(textwrap.fill(para, WIDTH, initial_indent="  ", subsequent_indent="  ") if para.strip() else "")
    if ans.cited:
        print("  sources:")
        for h in ans.cited:
            print(f"    [{h.rank}] {h.source}  {h.pages}  {h.section or '—'}")
    elif ans.mode == "rag":
        print("  sources: none cited")
    print()
