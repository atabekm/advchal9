# Task 21 — Document indexing

Turn a folder of PDFs into a local vector index: extract text, chunk it two
ways, embed every chunk, store vectors + metadata in SQLite, and compare the
two chunking strategies with static stats.

Python 3.13, `uv`, Ollama `nomic-embed-text` for embeddings. English only.

## Decisions

| | choice | why |
|---|---|---|
| corpus | `docs/` — PDFs you drop in (also `.md`/`.txt` if present) | outside material, ≥ 20–30 pages total |
| extraction | **PyMuPDF** (`pymupdf`) | text per page, the PDF outline (`get_toc()`), and font sizes per span — the last two are what structure chunking needs |
| embeddings | Ollama `nomic-embed-text`, 768-dim, `POST /api/embed` in batches | local, free, rebuild at will |
| nomic prefix | chunks are embedded as `search_document: <text>` | the model is trained with task prefixes; queries later use `search_query: ` |
| storage | one SQLite file `index/index.db` (stdlib `sqlite3`), vectors as float32 BLOBs (numpy) | one file, metadata as real columns, both strategies side by side |
| comparison | static stats only, printed as a table + written to `COMPARISON.md` | per your answer |

## Layout

```
task21/
  docs/                 ← drop PDFs here (gitignored except .gitkeep)
  index/index.db        ← generated (gitignored)
  indexer/
    extract.py          PDF → Document(pages, outline, spans with font size)
    chunk_fixed.py      fixed-size strategy
    chunk_struct.py     structure strategy
    embed.py            Ollama client, batching, retries
    store.py            SQLite schema, write, read
    stats.py            per-strategy statistics
    cli.py              `index`, `stats`, `show` subcommands
  pyproject.toml
  README.md
```

## Chunk record (metadata)

```
chunk_id     "<doc-slug>:<strategy>:<ordinal>"   e.g. attention-is-all:struct:0012
strategy     fixed | struct
source       relative path, docs/attention.pdf
title        PDF metadata title → first large-font line on page 1 → file name
section      heading path, "3 Model Architecture > 3.2 Attention" (fixed: the section
             the chunk *starts* in, so both strategies are comparable)
page_start / page_end
ordinal      position within the document
char_len / token_est
text
embedding    float32[768]
```

Plus a `documents` table (source, title, pages, chars, sha256) so re-running
`index` skips unchanged files.

## The two strategies

**Fixed-size** — ignores structure on purpose.
- Whole document text joined (page breaks tracked for page_start/end).
- Window of ~1000 chars, 150 overlap, end snapped back to the nearest whitespace.

**Structure-based** — follows the document's own sections.
1. Headings from the PDF outline (`get_toc()`) when it exists — most papers
   and books have one.
2. Fallback when there is no outline: font-size heuristic — lines noticeably
   larger than the body font (or bold + numbered like `3.2 Attention`) are headings.
3. Text between headings = one section, with the heading path as `section`.
4. Sections over ~1500 chars split on paragraph boundaries; sections under
   ~200 chars merged into the next one (a lone heading is not a chunk).

## Comparison (static stats)

Per strategy, over the whole corpus and per document:
- chunk count; char length min / p25 / median / p75 / max / std
- % of chunks that start mid-sentence, % that end mid-sentence
- % of chunks spanning more than one section (fixed will have many, struct ~0)
- % of chunks spanning a page break
- duplicated text from overlap (fixed) — total chars stored vs. corpus chars
- embedding time and index size

Output: a terminal table and `COMPARISON.md` with the numbers and a short
reading of them.

## Stages

One branch, `task21/document-indexing`, one commit per stage.

1. **extract** — project scaffold (`uv`, pyproject), `docs/`,
   PyMuPDF extraction with outline + font-size heading detection; a
   `show` command that prints what was extracted (titles, pages, headings found).
2. **chunking** — both chunkers with metadata; `show --chunks`
   prints a sample so you can eyeball the boundaries. Unit tests for the
   boundary rules (snap to whitespace, merge small, split large).
3. **embed + store** — Ollama embedding client, SQLite store,
   `index` command (incremental by sha256, `--rebuild`).
4. **compare** — `stats` command, `COMPARISON.md`, README with
   how to run and the results.

## Setup you need to do

- `ollama pull nomic-embed-text`
- drop PDFs into `task21/docs/` (≥ 20–30 pages total; papers with an
  outline show the structure strategy best)

## What the build changed

- **Outline + fonts, not outline or fonts.** arXiv outlines leave out
  Abstract, References, Broader Impact; with the outline alone the
  references piled onto "6 Discussion". Unnumbered blocks in a heading font
  size are now top-level headings next to the outline's.
- **Figure labels repeat headings.** "Scaled Dot-Product Attention" is also a
  box in Figure 2, which comes first on the page. Outline matching takes the
  best candidate on the page (numbered, bold), not the first.
- **Ligatures** (`ﬁ`) broke matching "4.4 Fact Verification"; extraction
  expands them.
- **Paragraphs split by column/page breaks** are glued back (no closing
  punctuation + lowercase continuation). On the dev papers this took struct
  chunks starting mid-sentence from 5.9% to 0%, ending mid-sentence from
  17.8% to 12.7%; the rest are tables, author blocks and reference entries.
- **Merged small sections can exceed MAX_CHARS** by up to MIN_CHARS (a lone
  heading prepended to a full chunk). Accepted: splitting it off again would
  recreate the lone-heading chunk.
- Added `indexer query` — not asked for, but it is the quickest proof that
  the stored vectors are usable.
