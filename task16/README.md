# Task 16 — `mcpls`

A CLI that connects to an MCP server over stdio and lists its tools.

Written in Go against the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk) v1.8.0.

## Why it looks like this

The task is satisfied, literally, by a program that prints `Connected!` and
three tool names. That program and a real MCP client produce identical output,
which means the interesting problem is not *connect and list* — it is **making
the list impossible to have faked**. Three things do that here:

- **The handshake is shown, not hidden.** Every JSON-RPC method appears with its
  real elapsed time, captured through the SDK's `AddSendingMiddleware` hook
  rather than reconstructed afterwards.
- **The server names itself.** `serverInfo`, the negotiated `protocolVersion`
  and the capability set all come from the server's `initialize` response.
- **The schemas are parsed.** Every tool prints its parameters with types and
  required markers, decoded from an `inputSchema` this program did not write.

And the server is data, not code — point it at something nobody anticipated and
it renders that server's tools.

See [PLAN.md](PLAN.md) for the full reasoning.

## Requirements

- Go 1.24+ (built with 1.27.1)
- Node/`npx` on `$PATH` — the four bundled servers are npm packages

## Run

```bash
go build -o mcpls .

./mcpls                                   # default server (everything)
./mcpls filesystem ~/Projects             # named server + its own argument
./mcpls -- npx -y @modelcontextprotocol/server-memory   # any command at all
./mcpls servers                           # what's in the registry
./mcpls --json | jq '.tools[].name'
```

### Flags

| flag | effect |
|---|---|
| `--json` | emit the raw result as JSON; progress moves to stderr so stdout stays pipeable |
| `--schema` | print each tool's full input schema |
| `--full` | print complete descriptions instead of clipping them to two lines |
| `--timeout` | give up if the handshake takes longer (default 30s) |
| `--servers` | use an alternate `servers.json` |
| `--no-color` | disable ANSI colour (also honours `NO_COLOR`) |
| `-v` | announce each JSON-RPC method on stderr before it is sent |

Exit codes: **0** listed · **1** connection or protocol failure · **2** usage error.

## Verified output

Real runs, not mock-ups.

### Connection established, tools returned

```
$ ./mcpls everything

  mcpls · MCP tool inspector

  transport   stdio
  command     npx -y @modelcontextprotocol/server-everything

  ·  server/discover                      1.04s   incl. server startup · not supported
  ✓  initialize                             3ms
  ✓  notifications/initialized              0ms
  ✓  tools/list                             4ms

  server      mcp-servers/everything  v2.0.0
  protocol    2025-11-25
  caps        tools · prompts · resources · completions · logging

  TOOLS · 14

  echo                      Echoes back the input string
                            message*:string

  get-annotated-message     Demonstrates how annotations can be used to provide metadata about
                            content.
                            messageType*:string  includeImage:boolean

  get-env                   Returns all environment variables, helpful for debugging MCP server
                            configuration
                            —

  get-sum                   Returns the sum of two numbers
                            a*:number  b*:number

  …

  14 tools · 16 params · mcp-servers/everything v2.0.0 · 1.05s
```

`*` marks a required parameter. `—` means the tool takes none, said explicitly
so a blank line never reads as a rendering bug.

Two details worth pointing at:

- **`server/discover` is dimmed, not red.** The SDK probes for an optional
  method and this server answers JSON-RPC `-32601`. That is a negotiation
  outcome, not a fault, so it must not look like one.
- **`incl. server startup`.** The first round trip waits for Node to boot, which
  on a cold `npx` is seconds against milliseconds for everything after. The SDK
  spawns the child inside `Connect` with no hook for when the process is up, so
  there is no honest way to time the spawn separately — the step is labelled
  instead of having an invented duration placed in front of it.

### The list changes with the server

```
$ ./mcpls sequential-thinking

  server      sequential-thinking-server  v2026.8.31
  protocol    2025-11-25
  caps        tools

  TOOLS · 1

  sequentialthinking  A detailed tool for dynamic and reflective problem-solving through thoughts.
                      This tool helps analyze problems through a flexible thinking process that …
                      thought*:string  nextThoughtNeeded*:boolean|string  thoughtNumber*:integer
                      totalThoughts*:integer  branchFromThought:integer  branchId:string
                      isRevision:boolean|string  needsMoreThoughts:boolean|string
                      revisesThought:integer

  1 tool · 9 params · sequential-thinking-server v2026.8.31 · 1.12s
```

This server ships sixteen lines of prompt text in one `description`, which is
why descriptions clip at two lines and `…` marks where more exists. `--full`
prints all of it.

### Registry

```
$ ./mcpls servers

  NAME                    TOOLS  COMMAND
  ──────────────────────────────────────────────────────────────────────
  everything (default)       14  npx -y @modelcontextprotocol/server-everything
  filesystem                 14  npx -y @modelcontextprotocol/server-filesystem <dir>
  memory                      ~  npx -y @modelcontextprotocol/server-memory
  sequential-thinking         1  npx -y @modelcontextprotocol/server-sequential-thinking
```

`~` means never connected; counts are cached from the last successful run.

### Failures

A connection check is only meaningful if failure looks different from success,
so each failure names its stage and the next action.

```
$ ./mcpls filesytem                          # exit 2

  unknown server "filesytem"

  Did you mean "filesystem"?
  Run `mcpls servers` to see all 4.
```

```
$ ./mcpls -- definitely-not-installed-xyz    # exit 1

  ✗  spawn

  "definitely-not-installed-xyz" is not in $PATH
  Install it, or point mcpls at a different command with `mcpls -- <command> [args...]`.
```

```
$ ./mcpls --timeout 1s everything            # exit 1

  ✗  server/discover                      998ms   incl. server startup
  ✗  initialize                             0ms

  server did not complete the handshake within 1s
  The first `npx` run downloads the package, which can take longer than this.
  Retry, or raise the limit with --timeout 60s.
```

## Tests

```bash
go test ./...      # 22 tests
```

The tests cover `schema.go`, which is where the only real logic lives.
`Tool.InputSchema` is typed `any` — whatever the server's JSON decoded into —
and servers vary: `properties` may be absent, `required` may hold non-strings or
name a property that does not exist, `type` may be a list such as
`["boolean","null"]`. Each of those is real server output and none may panic.

The ordering test runs twenty times on purpose: Go randomises map iteration, so
without an explicit order the same server would render differently on
consecutive runs.

## Files

| file | holds |
|---|---|
| `main.go` | flags, subcommand dispatch, exit codes |
| `registry.go` | `servers.json` loading, name resolution, suggestions, count cache |
| `connect.go` | client construction, tracing middleware, handshake, `tools/list` |
| `schema.go` | `inputSchema` → ordered, typed, required-flagged parameters |
| `render.go` | the two-line renderer, TTY detection, colour |
| `servers.json` | the four registry entries (embedded into the binary) |
| `schema_test.go` | schema decoding, argv splitting, registry behaviour |

## Scope

**stdio only.** MCP also defines streamable HTTP; `servers.json` carries a
`transport` key so adding it later is a new case rather than a new shape.
Pagination *is* handled — `tools/list` is walked to the last page, because a
client that reads only the first page reports a truncated list as a complete
one.
