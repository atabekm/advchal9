# Task 19 — Composing MCP tools

Three **independent** MCP tools, each on **its own server**, and an agent that
chains them from one request: **search → summarize → save_to_file**. The
tools know nothing about each other. The chain exists only in the client, and
the client checks every handoff.

Go, [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk)
v1.8.0 over **Streamable HTTP**, DeepSeek for both the agent and the
summarizer.

```
                                        ┌─ searchserver :8771 ─┐        ┌───────────────┐
                                        │  search(query)       │──HTTPS▶│ HN Algolia API│
┌────────────┐   Streamable HTTP ×3     └──────────────────────┘        └───────────────┘
│ pipeagent  │────────────────────────▶ ┌─ sumserver :8772 ────┐
│ 3 sessions │                          │  summarize(text)     │──HTTPS▶ DeepSeek
│ 1 tool list│                          └──────────────────────┘
│ + LLM      │                          ┌─ fileserver :8773 ───┐
└─────┬──────┘                          │  save_to_file(…)     │──▶ ./out/
      │ HTTPS                           └──────────────────────┘
      ▼
  DeepSeek ── decides the order and passes each output into the next call
```

[PLAN.md](PLAN.md) has the design and what the build changed.

## Task checklist

| task item | where |
|---|---|
| several MCP tools: search, summarize, saveToFile | `search/`, `summarize/`, `savefile/`, each served by its own binary in `cmd/` |
| first tool gets the data | `search`: full-text search over Hacker News stories, returned as a compact numbered list |
| second processes it | `summarize`: one DeepSeek call over any text, with a check that every link in the summary is in the input |
| third saves the result | `save_to_file`: writes the text byte for byte into `out/`, atomically, and returns its sha256 |
| automatic execution of the chain | one request to `pipeagent`, and the model makes all three calls in order. The agent names no tool; it merges the servers' `tools/list` into one list (`agent/router.go`) |
| correct data transfer between tools | `agent/chain.go` compares every long argument with the earlier outputs (`exact` / `whitespace` / `partial` / `none`) and checks the saved file's sha256 against the content sent; `e2e/` runs the three real servers and asserts both |

## Tools

All three return **plain text** as their result, because text is what the
next tool accepts. Metadata goes into `structuredContent`, which the trace
shows but the model never needs to carry.

| tool | server | params | returns |
|---|---|---|---|
| `search` | searchserver | `query`, `limit` (1–30, default 10), `sort` (`relevance` \| `date`) | numbered list: title, link, points, comments, date, discussion link |
| `summarize` | sumserver | `text` (≤ 60,000 chars), `focus`, `max_words` (50–800, default 200), `format` (`markdown` \| `plain`) | the summary; `ungrounded_links` lists any link that isn't in the input |
| `save_to_file` | fileserver | `filename`, `content`, `overwrite` (default false) | `Saved out/x.md · 967 bytes · sha256 …` |

- **`search`** has no trailing newline in its output. A model passing text on
  tends to drop one, and the handoff would then differ by that one byte.
- **`summarize`** tells its model to use only the given text. A link in the
  summary that isn't in the input is listed in `ungrounded_links` and noted at
  the end of the text. The server has its own DeepSeek key. The agent never
  sees which model summarizes.
- **`save_to_file`** accepts only a bare file name ending in `.md`, `.txt` or
  `.json`. Paths, hidden names, `..` and other extensions are rejected, with a
  message saying what is accepted. It never replaces a file unless asked,
  including when two calls race for the same name. It writes to a temp file
  and renames it.

## Checking the handoffs

The tools can't check the handoffs because they don't know about each other.
The client can, because it sees every call's arguments and every result.

Every string argument of 200+ characters is compared with the outputs of the
earlier calls in the same request:

| verdict | meaning |
|---|---|
| `exact` | byte-identical to the output of step N |
| `whitespace` | identical once whitespace is collapsed; the trace says where it first differs |
| `partial` | x of step N's lines present, y lines added |
| `none` | matches no earlier output: the model wrote it itself |

If a result reports a `sha256` of what it stored, the agent compares it with
the hashes of the arguments it sent (`≡ stored = sent`). So the file on disk
is proven to match the call, and the handoff verdict shows whether the call
matched the summary.

## Run

```bash
go build -o . ./cmd/...        # four binaries
export DEEPSEEK_API_KEY=sk-…   # or a .env file here (sumserver and pipeagent both read it)

./searchserver                 # terminal 1
./sumserver                    # terminal 2
./fileserver                   # terminal 3, writes to ./out
./pipeagent                    # terminal 4, REPL
./pipeagent -q "Find the 8 most relevant HN stories about Rust async, summarize them and save to rust-async.md"
```

| flag | default | |
|---|---|---|
| `searchserver -addr` | `localhost:8771` | |
| `sumserver -addr` / `-model` | `localhost:8772` / `deepseek-flash` | |
| `fileserver -addr` / `-dir` | `localhost:8773` / `out` | |
| `pipeagent -servers` | the three URLs above | comma-separated |
| `pipeagent -q` | | run one request and exit |
| `pipeagent -model` / `-rounds` | `deepseek-flash` / `8` | |
| `pipeagent -raw` / `-plain` | | full arguments and results / raw markdown answer |

REPL commands: `/tools` (every server's tools with their parameters) ·
`/raw` · `/quit`.

Each call's arguments are shortened to keep the call on one line: the data
they carry is printed in full under the call that produced it, and the
handoff line says whether it arrived unchanged. `-raw` shows the full JSON
arguments instead.

**A server that is down** costs its tools, not the run. The agent reports it
and offers the model the tools it has. Before each request it pings every
session, replaces lost ones and tries missing servers again.

## Real runs

Unedited, with `-plain`.

**The full chain.** One request, and the model makes every call in order,
each on a different server. Under each call is the data that tool returned,
in full: the text the model now holds and carries into the next call.

```
  pipeagent · deepseek-flash · 3 MCP servers over Streamable HTTP

  ✓ searchserver  search · http://localhost:8771/mcp · protocol 2025-11-25
  ✓ sumserver     summarize · http://localhost:8772/mcp · protocol 2025-11-25
  ✓ fileserver    save_to_file · http://localhost:8773/mcp · protocol 2025-11-25
  3 tools from 3 servers, offered to the model as one list

  › Find the 6 most relevant Hacker News stories about SQLite performance, summarize them in about 100 words, and save the summary to sqlite-perf.md

  ⚙ 1 search @searchserver {"limit":6,"query":"SQLite performance","sort":"relevance"}
      ✓ 683ms · query="SQLite performance" returned=6 sort="relevance" total_matches=184
      │ Hacker News search: "SQLite performance" · 6 of 184 matches · by relevance
      │ 
      │ 1. SQLite performance tuning: concurrent reads, multiple GBs and 100k SELECTs/s
      │    https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
      │    219 points · 69 comments · 2023-04-12 · https://news.ycombinator.com/item?id=35547819
      │ 
      │ 2. SQLite improves performance with memory-mapped I/O
      │    http://www.sqlite.org/releaselog/3_7_17.html
      │    185 points · 80 comments · 2013-05-23 · https://news.ycombinator.com/item?id=5758192
      │ 
      │ 3. Why SQLite Performance Tuning Made Bencher 1200x Faster
      │    https://bencher.dev/learn/engineering/sqlite-performance-tuning/
      │    99 points · 20 comments · 2024-04-17 · https://news.ycombinator.com/item?id=40069583
      │ 
      │ 4. SQLite improving performance with pre-sort
      │    https://andersmurphy.com/2026/06/07/sqlite-improving-performance-with-pre-sort.html
      │    65 points · 5 comments · 2026-06-26 · https://news.ycombinator.com/item?id=48687137
      │ 
      │ 5. Sqlite Performance
      │    http://stackoverflow.com/questions/1711631/improve-insert-per-second-performance-of-sqlite
      │    30 points · 6 comments · 2016-11-12 · https://news.ycombinator.com/item?id=12939690
      │ 
      │ 6. Small Changes for Big SQLite Performance Increases
      │    https://whylabs.ai/blog/posts/small-changes-for-big-sqlite-performance-increases
      │    12 points · 1 comments · 2022-07-20 · https://news.ycombinator.com/item?id=32172231
  ⚙ 2 summarize @sumserver {"focus":"SQLite performance topics, techniques an… (74 chars)","format":"markd…
      ⇐ text · from step 1 search · exact · 1,369 chars · sha256 232e18a5
      ✓ 6.3s · input_chars=1369 model="deepseek-flash" output_words=47 ungrounded_links[0]
      │ - Concurrent reads, multiple GBs, and 100k SELECTs/s.
      │ - Memory-mapped I/O.
      │ - A 1200x speedup via tuning.
      │ - Pre-sort.
      │ - Improving insert-per-second performance.
      │ - Small changes for big increases.
      │ 
      │ Takeaways: tune concurrency/read throughput, use memory-mapped I/O, pre-sort data, optimize inserts,
      │ and small changes can yield major gains.
  ⚙ 3 summarize @sumserver {"focus":"one line per story naming its title, poi… (87 chars)","format":"markd…
      ⇐ text · from step 1 search · exact · 1,369 chars · sha256 232e18a5
      ✓ 5.2s · input_chars=1369 model="deepseek-flash" output_words=88 ungrounded_links[0]
      │ - SQLite performance tuning: concurrent reads, multiple GBs and 100k SELECTs/s — 219 pts, 69
      │ comments, 2023-04-12.
      │ - SQLite improves performance with memory-mapped I/O — 185 pts, 80 comments, 2013-05-23.
      │ - Why SQLite Performance Tuning Made Bencher 1200x Faster — 99 pts, 20 comments, 2024-04-17.
      │ - SQLite improving performance with pre-sort — 65 pts, 5 comments, 2026-06-26.
      │ - Sqlite Performance — 30 pts, 6 comments, 2016-11-12.
      │ - Small Changes for Big SQLite Performance Increases — 12 pts, 1 comments, 2022-07-20.
      │ 
      │ HN search: 6 of 184 matches, by relevance.
  ⚙ 4 save_to_file @fileserver {"content":"- SQLite performance tuning: concurrent… (562 chars)","filename…
      ⇐ content · from step 3 summarize · whitespace differs (trailing "\n" added) · 562 chars
      ✓ 6ms · bytes=574 overwritten=false path="out/sqlite-perf.md"
      ≡ stored sha256 b480a634… = content sent
      │ Saved out/sqlite-perf.md · 574 bytes · sha256
      │ b480a634c6fda289f42c096dc2cff39983c9fccb1c6db175187b1bff1ee42017

  chain search → summarize → summarize → save_to_file · 3 handoffs: 2 exact, 1 whitespace · stored = sent

  I searched Hacker News for "SQLite performance" (6 of 184 matches, by relevance) and summarized the top six stories — from the 100k SELECTs/s tuning post through memory-mapped I/O, Bencher's 1200x speedup, pre-sort, insert-per-second improvements, and small changes with big gains.

  The summary is saved at `out/sqlite-perf.md` (574 bytes, sha256 b480a634c6fda289f42c096dc2cff39983c9fccb1c6db175187b1bff1ee42017).

  5 model calls · 11,432 in / 1,713 out tokens · 21.3s
```

The search result reached both `summarize` calls byte for byte. The model
judged the first summary too thin, summarized again with a sharper focus, and
saved the second one (`from step 3`), with one newline added at the end,
which the trace names instead of hiding. The file's hash matches what was
sent. (562 chars and 574 bytes: `—` is three bytes in UTF-8.)

What the servers logged, each in its own terminal:

```
21:28:48  ✓ search {"limit":6,"query":"SQLite performance","sort":"relevance"} · 678ms · Hacker News search: "SQLite performance" · 6 of 184 matches · by rele…
21:28:57  ✓ summarize {"focus":"SQLite performance topics, techniques an… (74 chars)","format":"markdown","max_words":110,"text":"Hacker News search: \"SQLite performance\"… (1,369 chars)"} · 6.3s · - Concurrent reads, multiple GBs, and 100k SELECTs/s. - Memory-mapped…
21:29:05  ✓ summarize {"focus":"one line per story naming its title, poi… (87 chars)","format":"markdown","max_words":100,"text":"Hacker News search: \"SQLite performance\"… (1,369 chars)"} · 5.2s · - SQLite performance tuning: concurrent reads, multiple GBs and 100k …
21:29:06  ✓ save_to_file {"content":"- SQLite performance tuning: concurrent… (562 chars)","filename":"sqlite-perf.md"} · 3ms · Saved out/sqlite-perf.md · 574 bytes · sha256 b480a634c6fda289f42c096…
```

**A run where the model didn't pass on the latest output.** In an earlier
run, the model called `summarize` twice (a second time with a more detailed
focus) and then saved the *first* summary. The trace shows which output
reached the file:

```
  ⚙ 2 summarize … ⇐ text · from step 1 search · …
  ⚙ 3 summarize … ⇐ text · from step 1 search · …
  ⚙ 4 save_to_file … ⇐ content · from step 2 summarize · exact · 558 chars
  chain search → summarize → summarize → save_to_file · …
```

**One server down.** With `fileserver` stopped, the chain ends where the tools
end, and the model says what it couldn't do:

```
  ✗ http://localhost:8773/mcp unreachable (connect: connection refused) — its tools are missing
  ✓ searchserver  search · http://localhost:8771/mcp · protocol 2025-11-25
  ✓ sumserver     summarize · http://localhost:8772/mcp · protocol 2025-11-25
  2 tools from 2 servers, offered to the model as one list

  › Search Hacker News for the 5 newest stories about SQLite, summarize them in 80 words and save the summary to sqlite.md

  ⚙ 1 search @searchserver {"limit":5,"query":"SQLite","sort":"date"}
      ✓ 410ms · query="SQLite" returned=5 sort="date" total_matches=4533
  ⚙ 2 summarize @sumserver {"focus":"what each story is about","format":"markdown","max_words":8…
      ⇐ text · from step 1 search · exact · 1,018 chars · sha256 9d5d4df0
      ✓ 7.9s · input_chars=1018 model="deepseek-flash" output_words=62 ungrounded_links[0]

  chain search → summarize · 1 handoff: 1 exact

  I found the 5 newest SQLite stories on Hacker News and condensed them into an 80-word summary covering all five: Tlx (SSH chat), DBDelve (Rust DB client), Scalar.dev (Python/SQLite starter app), a SQLite Production Pragma Configurator, and browser-based WebAssembly SQLite migrations.

  However, I could not save it to `sqlite.md`: none of my available tools can write files — I only have a Hacker News search tool and a text summarizer. The summary exists only in this conversation; if you have a file-writing capability available, I can hand the text over for you to save.
```

## Tests

```bash
go test ./...
```

No network. The fakes are `httptest` servers for Algolia and DeepSeek.

- **search**: formatting, a missing `url`, zero hits, a 503, `sort` → endpoint,
  and schema bounds through a real MCP client.
- **summarize**: prompt contents, defaults, rejected input never reaching the
  model, an empty reply, and grounding (an invented link is flagged, a copied
  one isn't).
- **savefile**: byte-exact writes (CRLF, emoji, no newline added), the sha256,
  overwrite rules, 13 rejected names with nothing written outside the
  directory, and 8 concurrent writers of the same name, of which exactly one
  succeeds.
- **agent**: each verdict, failed calls not counting as sources, the store
  check, the report, where whitespace differs, and the router's merge,
  routing and name collision.
- **e2e**: the three real servers over Streamable HTTP, with a scripted model
  that relays each output. When it relays faithfully, the test expects
  2 × `exact`, `stored = sent`, and the file equal to the summary. When it
  drops half the lines and adds one, it expects 2 × `partial`, caught.

## Layout

```
cmd/searchserver  cmd/sumserver  cmd/fileserver   one tool each
cmd/pipeagent                                     multi-server client, trace, REPL
search/  summarize/  savefile/                    the tools; none imports another
mcpserve/                                         shared server plumbing, no state
llm/                                              DeepSeek client (agent and sumserver)
agent/                                            loop, router, chain check
e2e/                                              whole-pipeline tests
```
