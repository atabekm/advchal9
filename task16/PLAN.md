# Task 16 — Connecting to MCP · plan

The task is four lines long and one of them is a trap:

> *establishes an MCP connection · retrieves the list of available tools ·
> verify the connection is established · verify the list is returned correctly*

The trap is the word **verify**. A program that prints

```
Connected!
Tools: echo, add, printEnv
```

satisfies a literal reading of every line above, and proves nothing. Those two
strings can be produced by a forty-character program that never opens a socket.
The output of a working MCP client and the output of a `fmt.Println` are
byte-identical, and the task asks for the first while accepting the second.

So the real problem is not *connect and list*. It is:

> **Make the list impossible to have faked.**

Everything in this task's design follows from that one sentence.

## What makes a tool list believable

A tool list is not a fact. It is a **claim made by another process**, arriving
over a pipe, after a negotiation. There are exactly three things that make the
claim credible, and a client that hides any of them is asking to be taken on
faith:

1. **The handshake happened.** MCP does not let you ask for tools first. You
   send `initialize`, the server answers with a protocol version and a
   capability set, you send `notifications/initialized`, and only then is
   `tools/list` legal. A tool list with no handshake in front of it is a
   fabrication.
2. **The server named itself.** `initialize` comes back with `serverInfo`
   (name, version) and a negotiated `protocolVersion` that may differ from what
   we asked for. Printing it proves we are quoting a stranger, not ourselves.
3. **The schemas came too.** Each tool carries an `inputSchema` — a JSON Schema
   object we did not write. Rendering parameters with their types and required
   flags means we parsed a structure that only the server could have produced.
   Names alone are cheap; typed parameters are not.

Hence the interface: the handshake is not a spinner to be hidden behind, it is
**the top third of the screen**, and every tool is printed **with its
parameters**, not just its name.

## The second proof: the list must be able to change

Even a fully honest transcript of one hardcoded server invites the same
suspicion one level up — a program can be written to connect to exactly one
server and nothing else, and such a program is a demo, not a client.

The disproof is swappability. The server is **data, not code**:

```
mcpls                                     # default from servers.json
mcpls filesystem ~/Projects               # named entry + extra argv
mcpls -- npx -y @modelcontextprotocol/server-memory   # anything at all
```

Nothing in the Go source knows what `echo` or `read_file` is. Point it at a
server nobody anticipated, and it renders that server's tools. That is the
difference between a client and a printer, and it is a five-second
demonstration.

## Scope

**stdio transport only.** MCP also defines streamable HTTP, and adding it is
maybe forty lines — but it drags in base URLs, sessions, auth headers and
retries, none of which make the tool list more believable. One transport, done
properly, beats two done partially. `servers.json` gains a `"transport"` key
anyway so the extension has an obvious seam.

Four servers in the registry, all no-auth, all reachable through the `npx`
already on this machine:

| name | package | why |
|---|---|---|
| `everything` (default) | `@modelcontextprotocol/server-everything` | official reference server; deliberately varied schemas |
| `filesystem` | `@modelcontextprotocol/server-filesystem` | takes a directory argument — proves argv passthrough |
| `memory` | `@modelcontextprotocol/server-memory` | different domain, same protocol |
| `sequential-thinking` | `@modelcontextprotocol/server-sequential-thinking` | exactly one tool — the list-of-one edge case |

## Honest instrumentation

The first draft of the screen mockup had four timed checkmarks:
`process spawned`, `initialize`, `notifications/initialized`, `tools/list`.

The SDK does not decompose that way. `client.Connect(ctx, transport, nil)` spawns
the child *and* performs the whole handshake behind one call, so timing those
four phases from the outside means inventing three of the numbers. Inventing
timings in a tool whose entire purpose is to be checkable would be a strange
thing to do.

`Client.AddSendingMiddleware` fixes it properly. Middleware is
`func(MethodHandler) MethodHandler`, and it sees every outgoing JSON-RPC method
by name:

```go
client.AddSendingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
    return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
        start := time.Now()
        res, err := next(ctx, method, req)
        trace.record(method, time.Since(start), err)   // real elapsed, real method name
        return res, err
    }
})
```

Now each printed line corresponds to an actual JSON-RPC exchange, and the
timings are measured rather than asserted. The same hook powers `-v`, which
dumps the frames themselves.

One consequence worth stating: the checkmarks print as they resolve, so a hang
is visible at the step that hung rather than as a frozen cursor.

## Layout

Compact two-line, chosen because it is the only one of the three candidates that
keeps parameters on screen — and parameters are proof #3 above. A pure table
hides them behind a flag; a full tree shows four tools per screen.

```
  mcpls · MCP tool inspector

  transport   stdio
  command     npx -y @modelcontextprotocol/server-everything

  ✓  initialize                                            318ms
  ✓  notifications/initialized                               2ms
  ✓  tools/list                                             24ms

  server      example-servers/everything  v1.0.0
  protocol    2025-06-18
  caps        tools · prompts · resources · logging

  TOOLS · 8

  echo           Echoes back the input as a text message
                 message*:string

  add            Adds two numbers together
                 a*:number  b*:number

  printEnv       Prints all environment variables
                 —

  8 tools · 11 params · everything v1.0.0 · 485ms
```

`*` marks required. `—` means the tool takes no parameters, stated explicitly so
an empty line never reads as a rendering bug.

## Failure is part of the deliverable

"Verify the connection is established" is only meaningful if a failed connection
looks different from a successful one. Three failures get first-class treatment,
each naming the next action:

- **`npx` missing** → `exec.LookPath` fails before spawning, so the error is
  "not in $PATH", not a generic pipe error.
- **handshake timeout** → the first `npx` run downloads the package, which
  legitimately exceeds a tight deadline. The message says so and names
  `--timeout`, instead of implying the server is broken.
- **unknown registry name** → Levenshtein against the four known names, so
  `filesytem` suggests `filesystem`.

Exit codes: `0` listed, `1` connection or protocol failure, `2` usage error.
A client you can't branch on in a shell script isn't finished.

## Files

| file | holds |
|---|---|
| `main.go` | flags, subcommand dispatch, exit codes |
| `registry.go` | `servers.json` loading, name resolution, suggestions |
| `connect.go` | client construction, tracing middleware, handshake, `tools/list` |
| `schema.go` | `inputSchema` (`any`) → ordered, typed, required-flagged params |
| `render.go` | the two-line renderer, TTY detection, colour |
| `servers.json` | the four entries |
| `schema_test.go` | schema decoding against hand-written fixtures |

`schema.go` is the only part with real logic worth testing. `Tool.InputSchema`
is typed `any` — from the client it is whatever the server's JSON unmarshalled
into, typically `map[string]any`. Servers vary: `properties` may be absent,
`required` may be absent or hold non-strings, `type` may be a list. Every one of
those is a real server's output, and each must render as something rather than
panic. Hence a test file, and hence `--json`, which passes the untouched result
through for anyone who would rather trust `jq` than my formatter.

## Sequence

1. Module + SDK — **done** (`go-sdk v1.8.0`, Go 1.27.1)
2. `registry.go` + `servers.json`
3. `connect.go` — the middleware trace is the load-bearing piece
4. `schema.go` + tests
5. `render.go`
6. `main.go` wiring, exit codes
7. Run against all four servers; capture the transcripts for the README

## Addendum — interactive mode

Added after the one-shot CLI was working, and it changes the argument in one
useful way.

The one-shot output proves the list is real. It does not prove the *client* is
general, because a reader still has to take on faith that `mcpls filesystem`
would have worked. Interactive mode collapses that: switching servers mid-
session, live, is the demonstration. One binary, four handshakes, four
different tool lists, no restart.

Three decisions worth recording.

**A scrolling REPL, not a full-screen TUI.** A bubbletea interface would look
better and would have been the obvious choice — but it takes the alternate
screen, and the handshake trace goes with it. The trace is the evidence. A mode
that hides the evidence to look nicer is the wrong trade for this task
specifically, so the REPL prints and scrolls, and the whole session survives in
scrollback.

**Read-only.** Selecting a tool shows its description, typed parameters and
optionally its raw schema. It does not call it. `tools/call` is a different
task, and adding it here would mean argument parsing, validation and result
rendering — a second program wearing this one's clothes.

**Revisiting a server is cached, and says so.** Holding sessions open would
leak child processes across a long browse; re-handshaking on every visit would
make navigation crawl. So the *result* is cached, and the screen states that
the timings shown are from the earlier handshake rather than reprinting them as
if they were fresh. `r` forces a real reconnect. The alternative — replaying
old timings silently — would have been a fabrication in exactly the place this
program exists to be trustworthy about.

The navigation loop takes an `*Inspection` and an `io.Reader`, so it is tested
against a fabricated tool list and scripted keystrokes, with no server involved:
wrapping past the last tool, the schema toggle, out-of-range input, `b` versus
`q`, and EOF.
