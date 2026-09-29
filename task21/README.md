# Task 21 — Document indexing

A folder of PDFs becomes a local vector index: text and headings are pulled
out of each PDF, chunked **two ways**, every chunk is embedded with
`nomic-embed-text` (Ollama, local), and vectors + metadata go into one SQLite
file. A `stats` command compares the two chunking strategies.

Python 3.13, `uv`, PyMuPDF, numpy, Ollama.

```
docs/*.pdf ──▶ extract ──▶ Document ──┬─▶ fixed chunker  ──┐
               (PyMuPDF)   headings   │                    ├─▶ Ollama ──▶ index/index.db
               outline /   + paras    └─▶ struct chunker ──┘   nomic-embed-text   documents · chunks
               fonts                                           768-dim            embed_runs · meta
```

[PLAN.md](PLAN.md) has the design; [COMPARISON.md](COMPARISON.md) has the
numbers for the indexed corpus.

## Run

```bash
ollama pull nomic-embed-text          # once
cp ~/papers/*.pdf docs/               # ≥ 20–30 pages in total

uv run indexer show --headings        # what extraction found per document
uv run indexer show --chunks struct   # chunk boundaries + metadata (also: fixed)
uv run indexer index                  # chunk, embed, store → index/index.db
uv run indexer stats --markdown COMPARISON.md
uv run indexer query "why is dot-product attention scaled?"   # sanity check
uv run pytest -q
```

`index` is incremental: a file whose sha256 is unchanged is skipped, a
deleted file is removed from the index. Changing the model or the chunk
parameters makes it refuse until you pass `--rebuild`.

## Extraction

PDF text comes out of PyMuPDF as blocks of lines with a font size and weight
per line. Two things make structure chunking possible:

- **Headings from the PDF outline** (its bookmarks). Each outline entry is
  searched for on the page it points to (or the next). When a figure label
  repeats the heading words, the candidate that is numbered and bold wins.
  Outlines tend to leave out unnumbered sections (Abstract, References,
  Broader Impact), so a block set in a heading font size becomes a top-level
  heading too.
- **Headings from fonts** when there is no outline: a short block set larger
  than body text, or bold and numbered like `3.2 Attention`. Level comes from
  the numbering, else from the font size rank. The largest size is the title
  when it only occurs on page 1.

Cleanup: rotated margin text (arXiv stamps), page numbers and lines repeated
on half the pages (running headers) are dropped. Ligatures are expanded
(`ﬁ` → `fi`), end-of-line hyphenation undone, and a paragraph split by a
column or page break is glued back (no closing punctuation + next starts in
lowercase). `.md` and `.txt` files are read too, headings from `#`.

## The two strategies

Both cut the **same flat text** (headings on their own line, paragraphs
separated by a blank line), so only the boundaries differ.

| | fixed (`chunk_fixed.py`) | struct (`chunk_struct.py`) |
|---|---|---|
| unit | 1000-char window, 150 overlap | one section |
| boundary | last whitespace before the limit | heading; inside a long section, paragraph then sentence |
| long | never (window) | section > 1500 chars packed into several chunks, heading line only in the first |
| short | only the document tail | section < 200 chars merged into the next (a heading with no text of its own) |
| `section` | the section the chunk *starts* in | the section's heading path |

## Metadata

Every chunk row in `chunks`:

| column | example |
|---|---|
| `chunk_id` | `attention:struct:0011` — document slug, strategy, ordinal |
| `strategy` | `fixed` / `struct` |
| `source` | `attention.pdf` (path under `docs/`) |
| `title` | `Attention Is All You Need` — PDF metadata, else the biggest line on page 1, else the file name |
| `section` | `3 Model Architecture > 3.2 Attention > 3.2.1 Scaled Dot-Product Attention` |
| `page_start`, `page_end` | `4`, `4` |
| `ordinal` | position within the document |
| `char_len`, `sections_spanned` | `394`, `1` |
| `text` | the chunk |
| `embedding` | 768 × float32, unit length (cosine = dot product) |

`documents` holds title, pages, chars, sha256 and where the headings came
from; `embed_runs` the chunks, tokens and seconds each document took per
strategy; `meta` the model, prefix and chunk parameters the index was built
with. Chunks are embedded as `search_document: <text>` — nomic-embed-text is
trained with task prefixes; queries use `search_query: `.

## What `stats` measures

| metric | meaning |
|---|---|
| length distribution | min / p10 / median / p90 / max, mean ± std of chunk chars |
| small / large | share under 200 or over 1500 chars |
| starts mid-sentence | first char lowercase or trailing punctuation |
| ends mid-sentence | last char not sentence punctuation (or a number, as references end) |
| mixes 2+ sections | chunk text comes from more than one section |
| crosses a page break | `page_end > page_start` |
| stored / corpus chars | redundancy from overlap |
| neighbour similarity | mean cosine between consecutive chunks of a document — high means neighbours say the same thing |
| embedding tokens / time, storage | what the strategy costs |

## Layout

```
indexer/
  extract.py       PDF / Markdown → Document (headings + paragraphs)
  chunk.py         Chunk record, flat text with page/section per offset, sentence splitter
  chunk_fixed.py   fixed-size strategy
  chunk_struct.py  structure strategy
  embed.py         Ollama client (batches of 32, prefixes, retries)
  store.py         SQLite schema, write per document in one transaction, read, search
  stats.py         the comparison
  cli.py           show · index · query · stats
tests/             extraction on generated PDFs, chunk boundary rules, store round trip
```
