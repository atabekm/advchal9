# Task 17 — First MCP tool · plan

> *Build your own MCP server around any API · register a tool · describe its
> input parameters · return a result. Connect it to your agent, call it from the
> application, receive and use the result.*

[Task 16](../task16) was the client half of MCP: connect, handshake, list. This
task is the other side of the pipe — **we write the server** — plus the thing
MCP exists for: an LLM that decides, on its own, to call a tool.

## Shape

```
┌──────────────┐  stdio · JSON-RPC  ┌──────────────────┐   HTTPS   ┌───────────────┐
│  bookagent   │ ─────────────────▶ │     olserver     │ ────────▶ │  Open Library │
│  REPL + LLM  │ ◀───────────────── │  MCP server (Go) │ ◀──────── │  (Internet    │
└──────┬───────┘                    └──────────────────┘           │   Archive)    │
       │ HTTPS                                                      └───────────────┘
       ▼
  DeepSeek chat API (function calling)
```

Two binaries, deliberately:

- **`olserver`** — the MCP server. The *only* code that knows Open Library
  exists. Speaks MCP over stdio; nobody runs it by hand.
- **`bookagent`** — the agent. Spawns `olserver` as a child process, discovers
  its tools via `tools/list`, hands them to DeepSeek, executes whatever the model
  asks for via `tools/call`.

The agent's source contains no book-specific code: no tool names, no parameter
lists. Everything it knows about tools arrives through the handshake. That is
checkable two ways:

1. `mcpls -- ./olserver` (task 16's binary) lists our tools with typed params —
   the server is a real MCP server, not a private protocol with MCP's name on it.
2. `grep -rn "search_books\|get_work" agent cmd/bookagent` finds only a comment
   and the tests.

## Why Open Library

Checked live before choosing (QuoteGarden, the first candidate, turned out to be
dead — `503 Service Suspended`):

- keyless, run by the Internet Archive, 0.7–1.5 s responses;
- **real parameters** — author, title, subject, year range — so the model has to
  map a question onto a schema, not just press a button;
- **verifiable** — every result carries `/works/OL…W`, which opens on
  openlibrary.org, so a hallucinated book is one click from exposed;
- **real edge cases**, observed, not imagined (below).

## Tool 1 — `search_books`

Wraps `GET /search.json`.

| param | type | notes |
|---|---|---|
| `query` | string | free text |
| `author` | string | |
| `title` | string | |
| `subject` | string | e.g. `science fiction` |
| `year_from` | integer | first publish year, inclusive |
| `year_to` | integer | inclusive |
| `limit` | integer | 1–20, default 5 |

Rules the schema can't express, enforced in the handler and returned as
`isError: true` (a tool error the model can read and recover from, not a
protocol error):

- at least one of `query` / `author` / `title` / `subject`;
- `year_from ≤ year_to`.

Year range becomes `first_publish_year:[A TO B]` appended to `q` — verified:
Le Guin + 1960–1969 → 11 works, *A Wizard of Earthsea* first.
`fields=` limits the response to what we return.

Result (`structuredContent`, mirrored as JSON text in `content` for clients that
ignore structured output):

```json
{
  "total_found": 11,
  "returned": 5,
  "books": [
    { "work_id": "OL59798W", "title": "A Wizard of Earthsea",
      "authors": ["Ursula K. Le Guin"], "first_publish_year": 1968,
      "edition_count": 180, "url": "https://openlibrary.org/works/OL59798W" }
  ]
}
```

Zero hits is **not** an error: `total_found: 0, books: []`. "Nothing matched" is
a valid answer the model should relay, not a failure it should retry around.

## Tool 2 — `get_work`

Wraps `GET /works/{id}.json`, plus `GET /authors/{id}.json` per author.

| param | type | notes |
|---|---|---|
| `work_id` | string, required | `OL59798W`; also accepts `/works/OL59798W` or the full URL — the model will pass whatever it saw |

Returns title, author **names**, description, top subjects (≤10), first publish
date, url — and `redirected_from` when applicable.

The three quirks, all seen in real responses:

- **Redirects.** `OL893415W` returns `{"type": "/type/redirect", "location":
  "/works/OL893414W"}` — a merged record, HTTP 200. Follow up to 3 hops and
  report `redirected_from`, so the id the model cited and the id returned
  don't silently disagree.
- **`description` is two shapes** — a plain string, or
  `{"type": "/type/text", "value": "…"}`. Normalise; truncate to ~1500 chars.
- **Authors are keys, not names** (`/authors/OL79034A`). Resolve concurrently;
  a failed lookup degrades to the key rather than failing the whole call.

404 → `isError: true`, "no work with id …".

## Registering the tools

`mcp.AddTool` with typed `In`/`Out` structs. The SDK infers `inputSchema` and
`outputSchema` from the structs, validates incoming arguments against the
schema before the handler runs, and fills `structuredContent` from the returned
`Out`. Parameter descriptions come from `jsonschema:"…"` tags.

Tags can't express `minimum`/`maximum`/`default`/`pattern`, so the inferred
schema is post-processed (`jsonschema.For[In]()` → set `limit` bounds and
default, `work_id` pattern) and passed explicitly as `Tool.InputSchema`. Those
constraints then reach the model too, because the agent forwards the schema
verbatim.

The HTTP client sends `User-Agent: ai-advent-task17 (<contact>)` as Open Library
asks, with a 15 s timeout.

## The agent loop

```
user ─▶ DeepSeek(messages, tools)
          ├─ plain answer ─────────────────────────▶ print
          └─ tool_calls[] ─▶ for each: MCP tools/call ─▶ append role:"tool" message
                                                     └─▶ DeepSeek again (≤ 6 rounds)
```

- **Tool conversion:** MCP `{name, description, inputSchema}` → OpenAI-style
  `{type:"function", function:{name, description, parameters}}`. Mechanical;
  no per-tool code.
- **Result → model:** `structuredContent` JSON if present, else concatenated
  text. `isError` results are passed as `{"error": "…"}` so the model sees *why*
  and can fix its arguments.
- **Round cap** of 6 tool rounds per user turn, so a confused model can't loop
  forever; hitting it is printed, not swallowed.
- **History persists across turns**, which is what makes the two tools
  compose: *"books by Le Guin from the 60s"* → `search_books`; *"tell me more
  about the second one"* → the model pulls `work_id` from the earlier result and
  calls `get_work`.
- DeepSeek via plain `net/http` (OpenAI-compatible `/chat/completions`), no SDK.
  Non-streaming — tool rounds need the whole message anyway.

## The REPL

Scrolling, like task 16's interactive mode, so the trace survives in
scrollback. Every MCP exchange is visible, timed by the same
`AddSendingMiddleware` hook task 16 used:

```
  bookagent · deepseek-flash · olserver v0.1.0 · 2 tools

  ✓ server/discover   110ms   incl. server startup
  ✓ tools/list          1ms

  connected olserver 0.1.0 · protocol 2026-07-28
  tools · 2   get_work, search_books

› what did Le Guin publish in the 1960s?

  ⚙ search_books {"author":"Ursula K. Le Guin","year_from":1960,"year_to":1969}
    ✓ 812ms · 5 of 11

  In the 1960s Ursula K. Le Guin published … A Wizard of Earthsea (1968) …

› tell me more about the second one

  ⚙ get_work {"work_id":"OL59800W"}
    ✓ 1.1s · The Left Hand of Darkness

  …
```

Commands: `/tools` (list with params), `/raw` (toggle full JSON of calls and
results), `/reset` (clear history), `/quit`. Flags: `-model`
(`deepseek-flash` default, `deepseek-v4-pro`), `-server` (path to
`olserver`, default: sibling of the `bookagent` executable).

Key from `DEEPSEEK_API_KEY`, falling back to a `.env` in the working dir.
Missing key → one line naming the variable, exit 2.

## Files

```
task17/
  go.mod                       module task17 · go-sdk v1.8.0
  cmd/olserver/main.go         server setup, tool registration, stdio run
  cmd/bookagent/main.go        flags, key, spawn, REPL
  openlibrary/client.go        HTTP client: search, work, author, redirects
  openlibrary/tools.go         In/Out types, schemas, handlers
  openlibrary/tools_test.go    fake Open Library (httptest) + in-memory MCP transport
  agent/deepseek.go            chat/completions with tools
  agent/loop.go                tool-call loop, MCP ↔ OpenAI conversion
  agent/loop_test.go           scripted fake DeepSeek + in-memory olserver
  agent/render.go              trace + answer rendering
  README.md
```

## Tests

No network in tests.

**Server** — through a real MCP client over `mcp.NewInMemoryTransports`, not by
calling handlers directly, so schema validation is exercised as a client sees
it: happy search; zero hits; no search fields → `isError`; `limit: 50` →
rejected by schema; year range inverted; `get_work` redirect chain; both
description shapes; 404; author lookup failure degrades.

**Agent** — fake DeepSeek returning a scripted sequence (tool_call → final
text): the call reaches the server with the model's arguments, the result is
appended as a `tool` message with the right `tool_call_id`, the final answer
is returned; `isError` is forwarded; round cap triggers; unknown tool name
produces an error message to the model rather than a crash.

## Branch

Single branch `task17/book-tools`, one PR.

## Sequence

1. Module, `openlibrary/client.go` against the live API
2. Tools + schema post-processing + server tests
3. `olserver`; verify with `mcpls -- ./olserver`
4. DeepSeek client + loop + agent tests
5. REPL + rendering
6. Live run of the demo conversation; README with the transcript

## Addendum — what the build changed

- **The handshake is `server/discover`, not `initialize`.** go-sdk v1.8.0
  negotiates protocol `2026-07-28`, which opens with `server/discover`. The
  trace prints whatever the middleware saw, so the mockup above was corrected
  rather than the trace faked to match it. A raw `initialize` at `2025-06-18`
  still works — checked by hand over stdio.
- **A fourth quirk: editions filed as works.** Live search for Le Guin in the
  60s returned `/works/OL7524720M` — an `M` (edition) id under `/works/`, an
  orphaned Ace Double with no parent work. `get_work` now accepts `…M`: it
  follows the edition to its work when one exists (reported as
  `redirected_from`), and returns the edition itself when it's an orphan. Links
  for `M` ids point at `/books/`. Editions also spell authors differently
  (`{"key"}` rather than `{"author": {"key"}}`); one decoder handles both.
- **Summaries are generic.** The one-line result under each tool call
  (`returned=5 total_found=11 books[5]`) is derived from `structuredContent`
  (scalars as `k=v`, arrays as `k[n]`) — the agent still has no per-tool code.

## Addendum — rendering answers

Answers are markdown; the REPL now renders them with glamour. Three findings
shaped the setup:

- **`auto` style is unsafe here.** It sends an OSC 11 background query and
  reads the reply from stdin. Under a pty that doesn't answer, it timed out and
  swallowed the first question. Style is chosen from `GLAMOUR_STYLE` /
  `COLORFGBG` / `dark` instead, without talking to the terminal.
- **Word wrap breaks link URLs** (`https://openlibrary.` / `org/works/…`),
  and the model cites work ids as links. Wrap is off; terminal soft-wrap
  keeps URLs intact.
- **Colourless styles keep `**` markers**, so piped output is raw markdown
  rather than half-rendered text. `-plain` forces that on a terminal.
