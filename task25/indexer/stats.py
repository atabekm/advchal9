"""Static comparison of the chunking strategies, read back from the index.

Nothing here asks a question of the index; every number describes the chunks
themselves: how many, how long, where they are cut, what they mix, what they
cost to embed and store.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from .store import Store

# A chunk starts cleanly on a capital, digit, bracket, quote or symbol, not on
# a lowercase word or trailing punctuation from the previous sentence.
_BAD_START = re.compile(r"^[a-z,;:)\]}.]")
# ... and ends cleanly on sentence punctuation (optionally closed by a
# bracket or quote) or on a citation/number, as reference lists do.
_GOOD_END = re.compile(r"""([.!?:]["'”’)\]]*|\d)$""")

SMALL = 200
LARGE = 1500


@dataclass
class StrategyStats:
    name: str
    chunks: int
    docs: int
    lengths: np.ndarray
    bad_start: int
    bad_end: int
    multi_section: int
    multi_page: int
    stored_chars: int
    corpus_chars: int
    seconds: float
    tokens: int
    bytes_text: int
    bytes_vectors: int
    neighbour_sim: float  # mean cosine between consecutive chunks of a document
    per_doc: dict[str, int]

    def pct(self, n: int) -> str:
        return f"{100 * n / self.chunks:.1f}%" if self.chunks else "–"


def collect(store: Store) -> list[StrategyStats]:
    docs = {r["source"]: r for r in store.documents()}
    corpus = sum(r["chars"] for r in docs.values())
    runs = store.embed_runs()
    out = []
    strategies = [r[0] for r in store.db.execute("SELECT DISTINCT strategy FROM chunks ORDER BY strategy")]
    for name in strategies:
        rows, mat = store.matrix(name)
        texts = [r["text"] for r in rows]
        lengths = np.array([r["char_len"] for r in rows])

        sims = []
        for i in range(1, len(rows)):
            if rows[i]["source"] == rows[i - 1]["source"]:
                sims.append(float(mat[i] @ mat[i - 1]))

        per_doc: dict[str, int] = {}
        for r in rows:
            per_doc[r["source"]] = per_doc.get(r["source"], 0) + 1

        my_runs = [r for r in runs if r["strategy"] == name]
        out.append(StrategyStats(
            name=name,
            chunks=len(rows),
            docs=len(per_doc),
            lengths=lengths,
            bad_start=sum(bool(_BAD_START.match(t)) for t in texts),
            bad_end=sum(not _GOOD_END.search(t.rstrip()) for t in texts),
            multi_section=sum(r["sections_spanned"] > 1 for r in rows),
            multi_page=sum(r["page_end"] > r["page_start"] for r in rows),
            stored_chars=int(lengths.sum()),
            corpus_chars=corpus,
            seconds=sum(r["seconds"] for r in my_runs),
            tokens=sum(r["tokens"] for r in my_runs),
            bytes_text=sum(len(t.encode()) for t in texts),
            bytes_vectors=int(mat.nbytes),
            neighbour_sim=float(np.mean(sims)) if sims else float("nan"),
            per_doc=per_doc,
        ))
    return out


def table(stats: list[StrategyStats]) -> list[tuple[str, ...]]:
    """Rows of (metric, value per strategy...)."""
    def row(label, fn):
        return (label, *[fn(s) for s in stats])

    def q(s, p):
        return f"{np.percentile(s.lengths, p):.0f}" if s.chunks else "–"

    return [
        row("chunks", lambda s: f"{s.chunks}"),
        row("chunks per document (mean)", lambda s: f"{s.chunks / s.docs:.1f}" if s.docs else "–"),
        row("length min", lambda s: f"{s.lengths.min()}" if s.chunks else "–"),
        row("length p10", lambda s: q(s, 10)),
        row("length median", lambda s: q(s, 50)),
        row("length p90", lambda s: q(s, 90)),
        row("length max", lambda s: f"{s.lengths.max()}" if s.chunks else "–"),
        row("length mean ± std", lambda s: f"{s.lengths.mean():.0f} ± {s.lengths.std():.0f}" if s.chunks else "–"),
        row(f"small chunks (< {SMALL} chars)", lambda s: s.pct(int((s.lengths < SMALL).sum()))),
        row(f"large chunks (> {LARGE} chars)", lambda s: s.pct(int((s.lengths > LARGE).sum()))),
        row("starts mid-sentence", lambda s: s.pct(s.bad_start)),
        row("ends mid-sentence", lambda s: s.pct(s.bad_end)),
        row("mixes 2+ sections", lambda s: s.pct(s.multi_section)),
        row("crosses a page break", lambda s: s.pct(s.multi_page)),
        row("stored chars / corpus chars", lambda s: f"{s.stored_chars / s.corpus_chars:.2f}×" if s.corpus_chars else "–"),
        row("neighbour similarity (cosine)", lambda s: f"{s.neighbour_sim:.3f}"),
        row("embedding tokens", lambda s: f"{s.tokens:,}"),
        row("embedding time", lambda s: f"{s.seconds:.1f} s"),
        row("storage: text + vectors", lambda s: f"{(s.bytes_text + s.bytes_vectors) / 1e6:.2f} MB"),
    ]


def render_terminal(stats: list[StrategyStats]) -> str:
    rows = [("metric", *[s.name for s in stats]), *table(stats)]
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    lines = []
    for n, r in enumerate(rows):
        lines.append("  ".join([r[0].ljust(widths[0]), *[c.rjust(w) for c, w in zip(r[1:], widths[1:])]]))
        if n == 0:
            lines.append("  ".join("─" * w for w in widths))
    return "\n".join(lines)


def render_markdown(stats: list[StrategyStats], store: Store) -> str:
    names = [s.name for s in stats]
    out = ["| metric | " + " | ".join(names) + " |", "|---|" + "---:|" * len(names)]
    for r in table(stats):
        out.append("| " + " | ".join(r) + " |")

    out += ["", "### Per document", "",
            "| document | pages | headings | " + " | ".join(f"{n} chunks" for n in names) + " |",
            "|---|---:|---|" + "---:|" * len(names)]
    for d in store.documents():
        counts = [str(s.per_doc.get(d["source"], 0)) for s in stats]
        out.append(f"| {d['title']} (`{d['source']}`) | {d['pages']} | {d['headings']} from {d['heading_source']} | "
                   + " | ".join(counts) + " |")
    return "\n".join(out)
