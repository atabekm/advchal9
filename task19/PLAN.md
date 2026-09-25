# Task 19 — Composing MCP tools · plan

> *Build several MCP tools, e.g. search, summarize and saveToFile. Chain them
> into a pipeline: the first gets the data, the second processes it, the third
> saves the result. Verify that the chain runs automatically and that the data
> passes correctly between the tools.
> Result: an automated pipeline of several MCP tools.*

In [task 17](../task17) and [task 18](../task18) every tool call stood alone.
Here three tools depend on each other's output, but **the tools themselves are
independent**. None of them knows the others exist. Each is a plain function
from text to text, on its own server. The chain exists only in the client.

## Shape

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

- **Three servers, one tool each**, each a standalone process on its own port.
  They share no state, no storage and no ids.
- **`pipeagent`** connects to all three, merges their `tools/list` into one
  list for the model, and sends each call to the server that owns the tool.
  The model gets one request in plain language ("find recent HN stories about
  Rust async, summarize them and save the summary to rust-async.md"), and
  decides the order itself.
- **Data passes through the model.** Search output goes into the model's
  context, and the model puts it into the `summarize` call's arguments.
  Summarize output goes into the `save_to_file` call the same way. This is
  what "composition" means here. It is also where data can get corrupted, so
  the agent **checks every handoff** (see below).

## Tools

All three return **plain text** as their main result, since text is what the
next tool accepts. Metadata goes into `structuredContent`, which the trace
shows but which is not needed to continue the chain.

### `search` — searchserver

| param | type | |
|---|---|---|
| `query` | string, required | full-text query |
| `limit` | int 1–30, default 10 | number of stories |
| `sort` | `relevance` \| `date`, default `relevance` | `date` = newest first |

Source: `hn.algolia.com/api/v1/search` (or `search_by_date`), `tags=story`.
It needs no API key (checked live). The result is a compact numbered list the
model can pass along without much token cost:

```
Hacker News search: "rust async" · 10 of 1,284 matches · by relevance

1. Why asynchronous Rust doesn't work
   https://theta.eu.org/2021/03/08/async-rust-2.html
   612 points · 435 comments · 2021-03-08 · https://news.ycombinator.com/item?id=26406989
2. …
```

- Ask HN and text posts have no `url`, so the HN item link is used instead.
- No hits is not an error: the result is a one-line `No stories found for "…"`.
- Timeout 10s. An API failure returns `isError` with the status.

### `summarize` — sumserver

| param | type | |
|---|---|---|
| `text` | string, required, ≤ 60,000 chars | anything |
| `focus` | string, optional | e.g. "performance complaints" |
| `max_words` | int 50–800, default 200 | |
| `format` | `markdown` \| `plain`, default `markdown` | |

It makes one DeepSeek call (`deepseek-flash`, configurable) with a fixed
system prompt: *summarize only the given text; add no facts, numbers or links
that are not in it; keep the links you mention exactly as written.* The key
belongs to the server (`DEEPSEEK_API_KEY` / `.env`). The agent's key is
separate even when it holds the same value.

It checks the summary against the input for **grounding**. Every URL in the
summary must appear exactly in the input text. Any that don't are listed in
`structuredContent.ungrounded_links` and noted in one line at the end of the
text. This is generic, since it knows nothing about search results. It catches
a model that makes up or "fixes" a link.

`structuredContent`: `{input_chars, output_words, model, ungrounded_links}`.

### `save_to_file` — fileserver

| param | type | |
|---|---|---|
| `filename` | string, required | a bare name, e.g. `rust-async.md` |
| `content` | string, required | written exactly as given |
| `overwrite` | bool, default false | |

- Files are written only into the `-dir` folder (default `./out`). The
  filename must be a bare name: no `/`, `\`, `..`, or leading `.`. Allowed
  extensions are `.md`, `.txt` and `.json`. Anything else is rejected with a
  message saying what is allowed, so the model can fix it and retry.
- If the file exists and `overwrite` is false, the call returns `isError` and
  names the existing file. It never overwrites silently.
- The file is written atomically: to a temp file, then renamed.
- Result text: `Saved out/rust-async.md · 1,412 bytes · sha256 3f9a…`.
  `structuredContent`: `{path, bytes, sha256}`.

## Checking the handoffs

The tools can't check the handoffs because they don't know about each other.
The client can, because it sees every call's arguments and every result.

`agent/chain.go` keeps each tool result from the current turn. When a new
call comes in, every string argument of 200+ chars is compared with every
earlier result and gets one verdict:

| verdict | meaning |
|---|---|
| `exact` | byte-identical to the output of step N |
| `whitespace` | identical after trimming and collapsing whitespace |
| `partial` | x% of step N's non-empty lines present, y lines added |
| `none` | no match with any earlier result (the model wrote it itself) |

The trace prints it next to the call, and the turn ends with a chain report:

```
  ⚙ search {"query":"rust async","limit":10}           ✓ 412ms · 10 stories · 2,031 chars
  ⚙ summarize {"text":"Hacker News search: …","max_words":200}
      text ⇐ step 1 · exact · 2,031 chars · sha256 9c1e…     ✓ 3.1s · 187 words
  ⚙ save_to_file {"filename":"rust-async.md","content":"…"}
      content ⇐ step 2 · exact · 1,412 chars · sha256 3f9a…  ✓ 2ms · out/rust-async.md

  chain  search → summarize → save_to_file · 2 handoffs · 2 exact
```

The final check closes the loop. After `save_to_file`, the agent compares the
server's reported `sha256` with the hash of the `content` it sent. So the file
on disk is proven to match the summary, not just the model's claim that it
does.

The system prompt tells the model to **pass a tool's output on verbatim** when
it feeds another tool. The report shows whether it did. A `partial` or `none`
verdict is shown in yellow but doesn't fail the turn, because the demo should
show that too if it happens.

## The agent

The DeepSeek client, tool loop, observer and glamour rendering are copied from
task 18 (each task is its own module). New pieces:

- **Several sessions.** `-servers` is a comma-separated list, defaulting to
  the three local URLs. The agent connects to each one with the same
  retry/backoff as task 18, merges the tool lists and routes each call by tool
  name. If two servers offer a tool with the same name, startup fails and
  names both servers. A server that is down at startup is reported, and the
  agent continues with the tools it has. The model then says it can't finish
  the chain, which is better than failing silently.
- **One request = one fresh turn**, as in task 18. The chain report is per
  turn.
- **Usage:** `pipeagent -q "…"` runs one request and exits (easy to script
  for the video), otherwise a REPL. `/tools` lists the merged tools with their
  server, `/raw` toggles full arguments and results, `/quit`.
- **The agent names no tool**, in code or prompts, as in tasks 17 and 18. The
  model finds all three through `tools/list`.

## Files

```
task19/
  go.mod                        module task19 · go-sdk v1.8.0
  cmd/searchserver/main.go      flags (-addr :8771), HTTP MCP handler
  cmd/sumserver/main.go         flags (-addr :8772, -model), key, HTTP MCP handler
  cmd/fileserver/main.go        flags (-addr :8773, -dir out), HTTP MCP handler
  cmd/pipeagent/main.go         flags, connect ×3, REPL / -q, rendering
  search/                       Algolia client + search tool
  summarize/                    DeepSeek call + grounding check + summarize tool
  savefile/                     name validation, atomic write + save_to_file tool
  mcpserve/serve.go             shared boilerplate: Streamable HTTP, nullArgsAsEmpty, shutdown
  agent/                        DeepSeek client + loop (from task 18), router.go, chain.go
  *_test.go
  README.md
```

`mcpserve` is shared server plumbing, not shared state. The three tool
packages don't import each other.

## Tests

No network in tests.

- **search**: an `httptest` fake of Algolia. Check formatting, a missing
  `url`, zero hits, a 5xx error, and that `limit`/`sort` map to the right
  endpoint and params.
- **summarize**: a fake DeepSeek. Check that the prompt contains the text and
  focus, the `max_words` bounds, that oversize input is rejected, and that an
  invented link is flagged in `ungrounded_links` while a link copied from the
  input is not.
- **savefile**: `../x.md`, `/etc/x.md`, `a/b.md`, `.env`, `x.exe` and an
  empty name are rejected. Also check that an existing file is not
  overwritten without `overwrite`, that the reported sha256 matches the file,
  and that content is written byte-for-byte (unicode, CRLF, no trailing
  newline added).
- **chain**: the verdict classifier (`exact` / `whitespace` / `partial` /
  `none`, and the 200-char threshold) and the sha256 closing check.
- **router**: tool lists are merged, calls go to the right session, and a
  name collision is an error.
- **End to end**: the three real servers on `httptest.Server` plus a scripted
  fake DeepSeek for the agent. The fake reads the tool results from the
  request history and issues search → summarize → save with those exact
  results. The test asserts that the file on disk has the summary's bytes and
  that the report shows 2 × `exact`. A second script passes a shortened text
  and must get `partial`.

## Sequence

1. Module, `mcpserve`, `searchserver` against the live API; poke it by hand
2. `sumserver` with grounding + tests
3. `fileserver` with the sandbox + tests
4. `agent`: copy from task 18, add router + chain check + tests
5. `pipeagent` + end-to-end test
6. Live demo: three servers in three terminals, one agent request, then a
   run where one server is down; README with the transcript

## Branch

Single branch `task19/tool-pipeline`, one PR (same as tasks 16–18).

## Addendum — what the build changed

- **The model sees a tool's text, not its structured output.** Task 18's loop
  sent `structuredContent` to the model when there was any. Here that would
  hand the model JSON metadata in place of the search list, and it would carry
  the wrong thing. `ResultForModel` now returns the text content.
  `structuredContent` only feeds the one-line trace and the sha256 check.
- **`search` output has no trailing newline.** The first live run passed the
  search list on as `whitespace` rather than `exact`, because the model
  dropped the final `\n`. The tool no longer emits one, and since then the
  handoff is `exact`.
- **`whitespace` verdicts say where the texts differ** (`trailing "\n" added`,
  or the line and a few characters on each side). A bare "whitespace" didn't
  explain what happened.
- **The store check is generic.** It doesn't look for `save_to_file` or
  `content`. Any result whose structured output has a `sha256` is compared
  with the hashes of every string argument sent in that call. The agent still
  names no tool.
- **The DeepSeek client moved to `llm/`,** since `sumserver` needs it too, and
  a server importing the agent package would be backwards.
- **Seen live: a second `summarize`, then the first result saved.** The model
  summarized twice and saved the earlier summary. The handoff line (`from
  step 2`) shows it. Nothing forbids this, so it isn't flagged as an error.
- **Seen live: the model adds a newline at the end of a file.** It is reported
  as `whitespace (trailing "\n" added)` and left alone, since it's a
  reasonable choice for a file and the trace says exactly what happened.
- **`save_to_file` without `overwrite` links the temp file into place**
  instead of renaming it, so two calls racing for a new name can't both
  succeed. A test with 8 concurrent writers covers it.
