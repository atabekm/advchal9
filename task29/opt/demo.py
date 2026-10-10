"""`bench demo`: one question through several variants, streamed live, then checked and compared.

For each variant: every model is unloaded first (each starts cold, as in the benchmark), the
reply streams in (qwen3's thinking dimmed, then the JSON), and then come the parsed answer, each
quote ✓/✗ against its passage, the timings, and the memory and context `ollama ps` reports.
An eval-set id (q04) uses its frozen passages and is scored. Any other text is a new question:
it's retrieved live first, and there's nothing to score it against.
"""

from __future__ import annotations

import os
import sys

import requests

from . import cited, freeze, prompts
from .evalset import Question
from .hits import Hit
from .ollama import DEFAULT_HOST, Ollama, Reply
from .score import score
from .variants import Variant
from .verify import verify

DEFAULT_VARIANTS = ("baseline", "qwen3-rag")

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


dim, bold = (lambda t: _c("2", t)), (lambda t: _c("1", t))
green, red, cyan = (lambda t: _c("32", t)), (lambda t: _c("31", t)), (lambda t: _c("36", t))


def describe(v: Variant) -> str:
    think = {None: "thinking (model default)", True: "thinking on", False: "thinking off"}[v.think]
    o = v.options
    temp = o.get("temperature", "0.6 (default)" if not v.system_in_modelfile else "0 (Modelfile)")
    ctx = o.get("num_ctx", "Ollama's pick" if not v.system_in_modelfile else "8192 (Modelfile)")
    return f"{v.model} · {think} · temperature {temp} · num_ctx {ctx} · {v.template} prompt · format {v.format_label}"


class Printer:
    """Streams tokens, dimming the thinking and starting a new block when the kind changes."""

    def __init__(self):
        self.kind = None

    def __call__(self, kind: str, text: str) -> None:
        if kind != self.kind:
            print("\n" + (dim("thinking: ") if kind == "thinking" else cyan("reply: ")), end="")
            self.kind = kind
        print(dim(text) if kind == "thinking" else text, end="", flush=True)


def show_answer(reply: Reply, hits: list[Hit], q: Question | None) -> str:
    """Prints the parsed answer and the quote checks; returns a short verdict for the summary."""
    print("\n\n" + bold("answer"))
    try:
        c = cited.parse(reply.text, hits)
    except cited.FormatError as e:
        print(red(f"  invalid reply: {e}"))
        verdict = "invalid reply"
    else:
        if c.status == "unknown":
            print(f"  I don't know: {c.clarification}")
            verdict = "I don't know"
        else:
            print(f"  {c.answer}")
            ok, _ = verify(c.quotes, hits)
            for x in c.quotes:
                mark = green("✓") if x in ok else red(f"✗ {x.score:.0f}%")
                print(f"  {mark} [{x.ref}] {dim(x.text[:140] + ('…' if len(x.text) > 140 else ''))}")
            verdict = f"answer, {len(ok)}/{len(c.quotes)} quotes verified"
    if q is not None:
        s = score(q, reply.text, hits)
        expected = "I don't know" if not q.answerable else q.expect
        print(dim(f"  expected: {expected}"))
        verdict = (green("✓ correct") if s.correct else red("✗ wrong")) + f" ({verdict})"
        print(f"  {verdict}")
    return verdict


def run_variant(v: Variant, question: str, hits: list[Hit], q: Question | None) -> dict:
    print("\n" + bold(f"━━ {v.name}") + dim(f"  {describe(v)}"))
    client = Ollama(v.host)
    for host in dict.fromkeys([DEFAULT_HOST, v.host]):
        try:
            Ollama(host).unload_all()
        except requests.RequestException:
            pass
    msgs = prompts.messages(v.template, question, hits, with_system=not v.system_in_modelfile)
    print(dim(f"loading {v.model} and reading {len(hits)} passages…"), end="", flush=True)
    reply = client.chat(v.model, msgs, options=v.options, think=v.think, format=v.format, on_token=Printer())
    verdict = show_answer(reply, hits, q)
    loaded = next((m for m in client.ps() if m.get("name", "").startswith(v.model)), {})
    mem, ctx = loaded.get("size", 0) / 2**30, loaded.get("context_length")
    think = f", {len(reply.thinking):,} chars of it thinking" if reply.thinking else ""
    print(dim(f"  {reply.wall_s:.1f} s total · load {reply.load_s:.1f} s · prefill {reply.prompt_tokens} tok in "
              f"{reply.prompt_s:.1f} s · {reply.completion_tokens} tok generated at {reply.eval_tps:.0f} tok/s{think}"))
    print(dim(f"  ollama ps: {mem:.1f} GB in memory, context {ctx}"))
    return {"variant": v.name, "seconds": reply.wall_s, "tps": reply.eval_tps, "tokens": reply.completion_tokens,
            "memory": mem, "ctx": ctx, "verdict": verdict}


def demo(arg: str, variants: list[Variant], questions: list[Question]) -> None:
    q = next((x for x in questions if x.id == arg), None)
    if q is not None:
        hits = freeze.load().get(q.id)
        if hits is None:
            sys.exit(f"{q.id}: its answer isn't in the frozen passages (see README)")
        question = q.question
    else:
        question = arg
        print(dim("retrieving…"), flush=True)
        hits = freeze.Retriever()(question)
    print(bold(f"Q: {question}"))
    for h in hits:
        print(dim(f"  [{h.rank}] {h.title[:60]}, {h.pages}  (relevance {h.rerank:.2f})"))
    rows = [run_variant(v, question, hits, q) for v in variants]
    print("\n" + bold("━━ comparison"))
    for r in rows:
        print(f"  {r['variant']:12} {r['seconds']:6.1f} s  {r['tokens']:5} tok  {r['tps']:5.1f} tok/s  "
              f"{r['memory']:4.1f} GB  ctx {r['ctx']!s:6}  {r['verdict']}")
