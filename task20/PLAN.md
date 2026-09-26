# Task 20 — MCP orchestration · plan

> *Register several MCP servers. Make sure the agent selects the right tool,
> routes each request correctly and runs a multi-step interaction flow.
> Verify a scenario that uses tools from different servers, and that tool
> selection and call order are correct.
> Result: a multi-step flow across several MCP servers and tools.*

[Task 19](../task19) already registers three servers, merges their tool lists
and routes each call. What it never tested was **choice**: each server had one
tool, and every step had exactly one candidate, so selection and order could
not go wrong. Task 20 makes both non-trivial and checks them:

- **Several tools per server, with overlap.** Three search sources with
  similar-looking tools, four file tools, three text tools. Picking the server
  is not enough. The tool has to be right too.
- **Namespaced tools.** Every tool is offered as `<server>__<tool>`, so two
  servers can have a tool with the same name.
- **Scenarios with expected traces.** Each scenario states which tools must be
  called, on which server, in what partial order, with which data flowing
  between them, and which tools must *not* be called. A grader checks the real
  trace against it, and `orchagent -eval` runs all scenarios as a table.

## Shape

```
                                      ┌─ searchserver :8771 ─────────────┐   Wikipedia
                                      │ wikipedia  wiki_article          │──▶ HN Algolia
┌─────────────┐                       │ hackernews books  book           │   Open Library
│ orchagent   │  Streamable HTTP ×3   └──────────────────────────────────┘
│ router with │─────────────────────▶ ┌─ textserver :8772 ───────────────┐
│ namespaces  │                       │ summarize  extract  compare      │──▶ DeepSeek
│ + grader    │                       └──────────────────────────────────┘
└──────┬──────┘                       ┌─ fileserver :8773 ───────────────┐
       │                              │ save  append  read  list         │──▶ ./out/
       ▼                              └──────────────────────────────────┘
   DeepSeek — picks tools from 12, in an order the request implies
```

## Reused from task 19

Copied, not imported (each task is its own module):

- `mcpserve/`: serving over Streamable HTTP
- `llm/`: the DeepSeek client
- `agent/`: loop, router, handoff checker (`exact` / `whitespace` /
  `partial` / `joined` / `none`), store check (`sha256`), trace printing
- `search/`: Wikipedia search, becoming `wikipedia`
- `summarize/`: becoming `summarize`, with the grounding check
- `savefile/`: sandbox, atomic write and name rules, becoming `save`

Brought back from elsewhere:

- Hacker News search from task 19's first commit (`ce80254`), before search
  moved to Wikipedia
- `search_books` / `get_work` from task 17's Open Library server

## Tools

All tools return plain text. Metadata goes into `structuredContent` as in
task 19.

### searchserver (namespace `search`)

| tool | does | notes |
|---|---|---|
| `wikipedia` | full-text search over English Wikipedia, article text | task 19's `search`, unchanged |
| `wiki_article` | one article by exact title, full text | for "the article about X" after another tool named X |
| `hackernews` | HN stories: title, link, points, comments, date | `sort`: `relevance` \| `date` |
| `books` | Open Library search: title, authors, year, work id | task 17's `search_books` |
| `book` | one work by id: description, subjects, first published | task 17's `get_work` |

The overlap is deliberate. "What does Hacker News say about X" must pick
`hackernews` and not `wikipedia`. "Le Guin's best-known novel" should go to
`books`, then `wiki_article` with the title it found.

### textserver (namespace `text`), was sumserver

| tool | does |
|---|---|
| `summarize` | task 19's, unchanged (focus, max_words, format, grounding) |
| `extract` | pulls a requested list out of text (e.g. "people and years", "every book title") as a Markdown list or JSON, each item traced to a line of the input |
| `compare` | two texts plus a focus → similarities, differences, and what only one side mentions; each point says which side it came from |

`compare` takes **two** inputs, so a scenario using it joins two earlier
outputs. `extract` gives a structured result that a later step uses as an
argument (a title, an id), so data dependencies go beyond "pass the whole
text on". Both use the same grounding check as `summarize` (links must appear
in the input).

### fileserver (namespace `files`)

| tool | does |
|---|---|
| `save` | task 19's `save_to_file`: create or overwrite, returns sha256 |
| `append` | adds to the end of an existing file (or creates it), returns new size and sha256 |
| `read` | returns a file's text |
| `list` | names, sizes and modified times in `out/` |

Same sandbox for all four: bare names, `.md` / `.txt` / `.json`, nothing
outside `-dir`. No `delete`. The agent has no reason to need it, and it is
the one tool a wrong selection would make costly.

## Namespacing and routing

- The name the model sees is `<prefix>__<tool>`, e.g. `search__hackernews`.
  A dot would be clearer, but OpenAI-style APIs (DeepSeek included) accept
  only `[a-zA-Z0-9_-]{1,64}` in tool names.
- The prefix defaults to the server's `serverInfo.name` without a `server`
  suffix, and can be set per URL: `-servers search=http://…,files=http://…`.
- The router keeps `prefixed name → (server, original name)` and calls the
  server with the **original** name. The server never sees the prefix.
- Two servers with the same prefix are an error at startup. Two servers with
  the same tool name are fine. A test registers two fake servers that both
  offer `search` and checks each call reaches the right one.
- The tool description gets the server's title in front
  (`[Search · Wikipedia, HN, Open Library] …`), so the model has the server
  as context when choosing.
- The trace prints both: `⚙ 2 search__hackernews → searchserver.hackernews`.

## Verifying selection and order

### Scenario format

`scenarios/*.json`, one per scenario:

```json
{
  "name": "hn-vs-wiki",
  "prompt": "Compare what Hacker News discussions and Wikipedia say about the James Webb telescope, and save the comparison to jwst.md",
  "steps": {
    "hn":   {"tool": "search__hackernews"},
    "wiki": {"tool": "search__wikipedia|search__wiki_article"},
    "cmp":  {"tool": "text__compare", "after": ["hn", "wiki"], "from": ["hn", "wiki"]},
    "save": {"tool": "files__save", "after": ["cmp"], "from": ["cmp"],
             "args": {"filename": "jwst.md"}}
  },
  "forbid": ["files__append", "search__books"],
  "max_calls": 6
}
```

- `tool`: which tool fills the step. `a|b` means either one is correct.
- `after`: a partial order, not a fixed sequence. Two independent searches
  can run in either order, or in the same turn.
- `from`: the step's long argument must come from those steps' outputs,
  judged by the existing handoff checker (`exact`, `whitespace`, `partial`
  or `joined` pass; `none` fails).
- `args`: exact values for arguments that the prompt fixes.
- `forbid`: tools that must not be called at all (the distractors).
- `max_calls`: an upper bound on calls, so a correct flow with pointless
  extra calls still shows up.

### Grader

`grade/` matches the recorded trace against a scenario and returns one
verdict per check:

```
hn-vs-wiki                                          PASS  5 calls
  ✓ hn    search__hackernews   → searchserver  call 1
  ✓ wiki  search__wikipedia    → searchserver  call 2
  ✓ cmp   text__compare        → textserver    call 3  after hn, wiki ✓  from hn (exact), wiki (exact)
  ✓ save  files__save          → fileserver    call 5  after cmp ✓  from cmp (exact)  filename=jwst.md ✓
  ✓ forbid: none called
  · extra: call 4 files__list (allowed, within max_calls 6)
```

A step is matched to the **first** call of that tool that satisfies it. Calls
that match no step are listed as extra. They fail the scenario only if
forbidden or over `max_calls`. Failed calls that the model retried do not
count against it, but they are shown.

### Scenarios for the demo

| # | scenario | servers | what it tests |
|---|---|---|---|
| 1 | HN vs Wikipedia on a topic → `compare` → `save` | all 3 | picking among search tools, join of two outputs |
| 2 | "Le Guin's most-read book: find it, read its Wikipedia article, summarize, add to reading-list.md" → `books` → `wiki_article` (title from step 1) → `summarize` → `append` | all 3 | a data dependency that is not whole text, `append` vs `save` |
| 3 | "What's in my notes? Add a summary of X to the file that covers it" → `list` → `read` → `wikipedia` → `summarize` → `append` | 2 → 1 → 2 → 3 | reading before writing, choice driven by file content |
| 4 | "List the people and years in the Wikipedia article on the Apollo program and save them as apollo.json" → `wiki_article` → `extract` → `save` | all 3 | `extract` vs `summarize` |
| 5 | "What's the weather in Paris?" | none | no tool fits: zero calls, and the model says so |

### Tests

- **Router**: prefixing, routing by original name, duplicate names across
  servers, prefix clash rejected, a server that is down.
- **Grader**: tables of hand-built traces: correct, wrong tool, wrong
  order, forbidden call, `none` handoff, extra calls under and over the
  limit, `a|b` alternatives, retried failure.
- **Tools**: unit tests carried over; new ones for `wiki_article`, `book`,
  `extract`, `compare`, `append`, `read`, `list` (HTTP faked with
  `httptest`, DeepSeek faked for the text tools).
- **e2e**: the three real servers in-process and a scripted fake LLM that
  plays scenario 1 correctly (must PASS) and then with a wrong tool and a
  wrong order (must FAIL with the right reason).
- **Live eval**: `orchagent -eval scenarios/` runs every scenario against
  DeepSeek and prints the table. Not part of `go test`, since the model isn't
  deterministic. The README gets the real output.

## Run

```bash
go build -o . ./cmd/...
./searchserver & ./textserver & ./fileserver &
./orchagent                       # REPL; /tools shows every tool with its prefix
./orchagent -q "…"                # one request
./orchagent -eval scenarios/      # all scenarios, pass/fail table
./orchagent -eval scenarios/2-le-guin.json -raw
```

## Sequence

1. Copy task 19, rename (`pipeagent` → `orchagent`, `sumserver` →
   `textserver`), build, tests green
2. Router namespacing + tests
3. searchserver: `wiki_article`, `hackernews`, `books`, `book` + tests
4. fileserver: `append`, `read`, `list` + tests
5. textserver: `extract`, `compare` + tests
6. `grade/` + scenario files + tests
7. `-eval` mode, e2e with scripted LLM
8. Live eval runs, fix what they show, README with the real output

## Branch

Single branch `task20/mcp-orchestration`, one PR (same as tasks 16–19).

## Addendum — what the build changed

- **The file prefix is `file`, not `files`.** Prefixes default to the server's
  name without `server`, and the server is `fileserver`. Tools are
  `file__save`, `file__append`, `file__read`, `file__list`.
- **A nil source offers no tools.** `search.NewServer` registers only the
  tools of the sources it is given, so tests and partial setups don't
  advertise tools that would crash.
- **The SDK lists tools sorted by name**, not in registration order; the
  tests compare sorted lists.
- **`from` is provenance, and it is transitive.** A call counts as carrying
  a step's data when a long argument's handoff verdict points to it, or a
  short argument (a title, an id) is in that output and not in the prompt,
  or either holds for a call in between: `from hn (via 2: exact)`.
- **The grader tries every assignment of calls to steps** and keeps the one
  where the most steps are met. Greedy matching took the first `summarize` of
  two for the summary step and then blamed the append, which carried the
  second one (seen live).
- **A `reworded` handoff verdict.** The model once rewrote the HN list
  before passing it on, so no line matched and the verdict was `none`. Now
  an argument none of whose lines survive, but 60% or more of whose words
  (10 or more) are one output's, is `reworded` from it. It counts as
  provenance and is flagged in yellow.
- **`read` reports `file_sha256`.** Any `sha256` in a result is taken as a
  hash of what the call stored; a read stores nothing and printed
  `stored ≠ sent`.
- **`wiki_article` returns at most 12,000 characters (default 6,000).** The
  model always asked for the maximum; carrying 20,000 characters made
  `extract` take a minute a call and led the model to write its own excerpt.
- **Budgets are the steps plus two**, room for one retry after a poor
  result. The notes scenario allows its reads on top.
- **A turn that ends in an error gets no grade** (DeepSeek timeouts,
  network errors), rather than a FAIL with no calls.
- **`append` refuses a symlink**, as `read` and `list` already did.
- **`extract` uses DeepSeek's JSON mode** (`CompleteJSON` in `llm/`), and
  writes JSON objects with their keys in column order, the quote last.
