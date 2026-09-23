# Task 17 — First MCP tool

An MCP server that wraps the [Open Library API](https://openlibrary.org/developers/api)
as two tools, and a REPL agent in which **DeepSeek decides when to call them**.

Written in Go against the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk) v1.8.0.

```
┌──────────────┐  stdio · JSON-RPC  ┌──────────────────┐   HTTPS   ┌───────────────┐
│  bookagent   │ ─────────────────▶ │     olserver     │ ────────▶ │  Open Library │
│  REPL + LLM  │ ◀───────────────── │  MCP server (Go) │ ◀──────── │               │
└──────┬───────┘                    └──────────────────┘           └───────────────┘
       │ HTTPS
       ▼
  DeepSeek chat API (function calling)
```

- **`olserver`** is the MCP server, and the only code that talks to Open
  Library. It registers the tools, declares their input schemas and returns
  structured results. It speaks stdio, so you never start it yourself.
- **`bookagent`** is the agent. It starts `olserver` as a child process,
  learns the tools through `tools/list`, passes them to DeepSeek as functions,
  and runs whatever the model asks for through `tools/call`. It has **no
  tool-specific code**: `grep -rn "search_books\|get_work" agent cmd/bookagent`
  finds one comment and the tests.

See [PLAN.md](PLAN.md) for the reasoning and the Open Library quirks found
along the way.

## Task checklist

| task item | where |
|---|---|
| tool registration | `openlibrary/tools.go` · `NewServer` → `mcp.AddTool` × 2 |
| input parameter definitions | typed `In` structs with `jsonschema` descriptions, plus bounds, a default and a pattern added to the schema (`searchSchema`, `workSchema`) |
| result return | typed `Out` structs → `structuredContent` + JSON text; failures → `isError: true` |
| call it from the application | `agent/loop.go` · `Agent.Ask` → `session.CallTool` |
| receive and use the result | tool result appended as a `role: "tool"` message; the model answers from it |

## Tools

**`search_books`** wraps `GET /search.json`.

| param | type | |
|---|---|---|
| `query` | string | free text |
| `author` | string | |
| `title` | string | |
| `subject` | string | |
| `year_from` / `year_to` | integer | first-publication year range, inclusive |
| `limit` | integer | 1–20, default 5 |

At least one of `query`/`author`/`title`/`subject` is required, and
`year_from ≤ year_to`. A JSON Schema can't express these rules, so the handler
checks them and returns them as tool errors the model can read and fix.
Zero hits is a normal result (`total_found: 0`), not an error.

**`get_work`** wraps `GET /works/{id}.json` and `/authors/{id}.json`.

| param | type | |
|---|---|---|
| `work_id` | string, required | `OL59798W`; `/works/…` and full URLs are accepted too |

It returns the title, author names, description, subjects and first-publication
date. It also copes with what the live API actually returns:

- **Merged records** come back as redirects. The tool follows them and reports
  `redirected_from`.
- **Descriptions** come in two shapes, a plain string or `{"type", "value"}`.
- **Authors** are listed only by key, so their names are looked up
  concurrently. A failed lookup falls back to the key.
- **Editions filed as works:** search sometimes returns an edition ID
  (`…M`). The tool resolves it to its work, or returns the edition itself if
  it has none.

## Run

```bash
go build -o . ./cmd/...           # builds ./olserver and ./bookagent
export DEEPSEEK_API_KEY=sk-…      # or put it in a .env file here
./bookagent
```

| flag | effect |
|---|---|
| `-model` | `deepseek-flash` (default) or `deepseek-v4-pro` |
| `-server` | path to the MCP server (default: `olserver` next to the binary or in the working dir) |
| `-rounds` | maximum tool rounds per question (default 6) |
| `-raw` | start with full tool arguments and results shown |
| `-plain` | print answers as raw markdown instead of rendering them |
| `-- cmd args…` | run any other stdio MCP server instead |

REPL commands: `/tools` · `/raw` · `/history` · `/reset` · `/quit`. Ctrl-C
cancels a question in progress; at the prompt it exits.

**Answers are rendered as markdown** with [glamour](https://github.com/charmbracelet/glamour):
bold, lists, tables drawn with box characters, and underlined links. Some details:

- **Style:** `dark` by default, or `light` when `COLORFGBG` says the background
  is light. Set `GLAMOUR_STYLE` to override. glamour's `auto` style is never
  used: it asks the terminal for its background colour and reads the reply from
  stdin, and in a terminal that doesn't answer, that costs a timeout and eats
  the first question typed.
- **No hard wrapping:** glamour's word wrap splits URLs inside links, so it's
  off. The terminal soft-wraps long lines, which keeps each URL whole and
  clickable.
- **Piped output** (and `-plain`) is the model's raw markdown, as in the
  transcript below. `NO_COLOR` keeps the structure without colour.

The server works with any MCP client, for example task 16's inspector:

```
$ ../task16/mcpls -- ./olserver

  ✓  server/discover                      606ms   incl. server startup
  ✓  tools/list                             0ms

  server      olserver  v0.1.0
  protocol    2026-07-28
  caps        tools · logging

  TOOLS · 2

  get_work      Fetch one Open Library work by id: title, author names, description, subjects and
                first publication date. Follows merged-record redirects.
                work_id*:string

  search_books  Search the Open Library catalogue. Provide at least one of query, author, title or
                subject; optionally narrow by first-publication year. Returns matching works …
                author:string  limit:integer  query:string  subject:string  title:string
                year_from:integer  year_to:integer
```

## A real session

Unedited output against the live APIs:

```
  bookagent · deepseek-flash · MCP over stdio

  server   /…/task17/olserver

  ✓ server/discover                  5ms   incl. server startup
  ✓ tools/list                       0ms

  connected olserver 0.1.0 · protocol 2026-07-28
  tools · 2   get_work, search_books

› what did Ursula Le Guin publish in the 1960s? just the novels, briefly

  ⚙ search_books {"author":"Ursula K. Le Guin","year_from":1960,"year_to":1969,"limit":20}
    ✓ 846ms · returned=11 total_found=11 books[11]
  ⚙ search_books {"query":"Ursula Le Guin","year_from":1960,"year_to":1969,"limit":20}
    ✓ 855ms · returned=11 total_found=11 books[11]

  Five novels, all from the catalogue:

  - **Rocannon's World** — 1966 (OL59850W)
  - **Planet of Exile** — 1966 (OL59836W)
  - **City of Illusions** — 1967 (OL36745884W)
  - **A Wizard of Earthsea** — 1968 (OL59798W)
  - **The Left Hand of Darkness** — 1969 (OL59800W)

  Notes: the first three are the "Hainish" novels, later collected as *Three Hainish
  Novels* (listed 1966/1967, OL59813W) — an omnibus, not a new work. …

  2 model calls · 3,692 in / 608 out tokens · 5.3s

› tell me more about the left hand of darkness

  ⚙ get_work {"work_id":"OL59800W"}
    ✓ 517ms · title="The Left Hand of Darkness" work_id="OL59800W" authors[1] subjects[10]

  **The Left Hand of Darkness** — Ursula K. Le Guin, first published **1969**
  (work OL59800W, 91 editions in the catalogue). …

  **Award:** it's flagged as a Hugo Award winner (1970, novel category) — it also
  won the Nebula.

  2 model calls · 7,159 in / 313 out tokens · 3.6s
```

What it shows:

- **The model chose the arguments.** "In the 1960s" became `year_from`/`year_to`,
  which it could only know about from the schema that came through `tools/list`.
- **It used the result.** The IDs in the answer are the `work_id`s the tool
  returned; each one opens as `https://openlibrary.org/works/<id>`.
- **History links the two tools.** The second question names a book, and the
  model takes its `work_id` from the first result to call `get_work`.
- **You can check where each fact came from.** The Hugo 1970 comes from the tool (the
  subjects include `award:hugo_award=1970`). "Also won the Nebula" does not; it
  comes from the model's own knowledge, even though the system prompt says to
  rely on the tools. `/raw` shows the exact JSON the model received, so you can
  make this check yourself.

## Tests

```bash
go test -race ./...     # 25 tests, no network
```

- **Server** (`openlibrary/tools_test.go`): a real MCP client connects over
  in-memory transports to the real server, which talks to a fake Open Library.
  Covered: the schemas as listed, a normal search, zero hits, bad input rejected
  by the schema and by the handler (without reaching the API), upstream 503,
  redirect chains, a bounded redirect loop, both description shapes, truncation,
  404, the author-lookup fallback, and edition IDs (resolved and orphaned).
- **Agent** (`agent/loop_test.go`): a scripted fake DeepSeek talking to the real
  server. Covered: the server's schema reaches the model unchanged, the full
  tool-call round trip, tool errors passed back and recovered from, an unknown
  tool and malformed arguments, the round cap (including a model that ignores
  it), history kept across turns and rolled back on failure, and
  `reasoning_content` preserved.
- **Rendering** (`cmd/bookagent/render_test.go`): markdown renders with and
  without colour, URLs stay whole, padding is trimmed, and style selection
  never falls back to `auto`.
