# Task 20 — MCP orchestration

Three MCP servers, **twelve tools**, and an agent that has to pick the right
ones, route each call to the right server, and run them in an order that lets
the data flow. Five scenarios state what a correct run looks like, and a
grader checks every real run against them.

Go, [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk)
v1.8.0 over **Streamable HTTP**, DeepSeek for the agent and for the text tools.

```
                                  ┌─ searchserver :8771 ────────────────────────┐   Wikipedia
                                  │ wikipedia · wiki_article · hackernews       │──▶ HN Algolia
┌──────────────┐                  │ books · book                                │   Open Library
│ orchagent    │  Streamable      └─────────────────────────────────────────────┘
│              │  HTTP × 3        ┌─ textserver :8772 ──────────────────────────┐
│ router:      │─────────────────▶│ summarize · extract · compare               │──▶ DeepSeek
│ server__tool │                  └─────────────────────────────────────────────┘
│ chain check  │                  ┌─ fileserver :8773 ──────────────────────────┐
│ grader       │                  │ save · append · read · list                 │──▶ ./out/
└──────┬───────┘                  └─────────────────────────────────────────────┘
       │ HTTPS
       ▼
   DeepSeek: picks 1 tool of 12 per step, carries each output into the next call
```

[PLAN.md](PLAN.md) has the design and what the build changed.

## Task 19 vs task 20

[Task 19](../task19) already had three servers, a merged tool list and a
router. What it never tested was **choice**: each server offered one tool,
every step had exactly one candidate, and the chain had one possible order.

| | task 19 | task 20 |
|---|---|---|
| tools | 3, one per server | 12: 5 + 3 + 4, overlapping on purpose |
| names | `search`, as the server calls it | `search__hackernews`: server prefix + tool, so two servers may share a tool name |
| routing | name → server; a duplicate name is an error | prefix → server, called by its own name; the trace shows `→ searchserver.hackernews` |
| order | one line: search → summarize → save | partial orders: two searches then compare; list before append; book → article by the title it found |
| checked | each handoff: did the data arrive intact | the handoffs, **plus** a scenario: right tools, right order, data from the right step, nothing forbidden, not too many calls |

## Task checklist

| task item | where |
|---|---|
| register several MCP servers | `orchagent -servers`; each URL may carry a prefix (`search=http://…`). Servers that are down cost their tools, not the run (as in task 19) |
| the agent selects the right tool | 12 tools with overlaps: three search sources and two ways into Wikipedia, `summarize` vs `extract` vs `compare`, `save` vs `append`. Descriptions say what each is **for**, and the system prompt asks the model to choose by that |
| requests are routed correctly | `agent/router.go`: `prefix__tool` → (server, tool), called by the tool's own name. Tests: two servers both offering `search`, prefix clashes, names a model API would refuse |
| multi-step flow | every scenario spans 2–3 servers and 3–8 calls |
| verify a scenario with tools from different servers | `scenarios/*.json`, run with `orchagent -eval scenarios/`; the real output is below |
| verify tool selection and call order | `grade/`: each step's tool (`a\|b` for alternatives), `after`, `from` (data provenance, direct or through other calls), exact `args`, `forbid`, `max_calls`. The e2e test plays scenario 1 right (PASS) and wrong (FAIL, with the reasons) through the three real servers |

## Tools

All tools return **plain text**, since that is what the next tool takes;
counts and hashes go to `structuredContent`, which the trace shows.

| tool | does | chosen when |
|---|---|---|
| `search__wikipedia` | full-text search, article text (lead or whole) | a topic, title unknown |
| `search__wiki_article` | one article by exact title, redirects followed, up to 12,000 chars | the title is known, e.g. from another tool |
| `search__hackernews` | stories: title, link, points, comments, date | discussions, reactions, news |
| `search__books` | Open Library catalogue; `sort: readers` for most-read | books by author, title, subject |
| `search__book` | one work by `work_id`: description, subjects | details of a book `books` found |
| `text__summarize` | one text → shorter text; links checked against the input | condense |
| `text__extract` | one text → Markdown table or JSON array with the columns asked for; a row whose quote isn't in the text is dropped | a list of things, data |
| `text__compare` | two labelled texts → In common / Only in A / Only in B / Where they disagree | two sources side by side |
| `file__save` | new file, byte for byte; replaces only with `overwrite` | a new file |
| `file__append` | adds to the end, on a new paragraph; creates if missing | adding to an existing note |
| `file__read` | a file's exact text | what a note says |
| `file__list` | name, size, modified, first line | which notes exist |

The file tools share one sandbox: bare names ending in `.md`, `.txt` or
`.json`, inside `-dir`, no symlinks followed. There is no `delete`: no
scenario needs it, and it is the one tool where a wrong choice would cost data.

## Namespacing and routing

- The model sees `<prefix>__<tool>`. The prefix is the server's name without
  `server` (`searchserver` → `search`) or the one given in `-servers`.
  `__`, because OpenAI-style APIs, DeepSeek among them, accept only
  `[a-zA-Z0-9_-]{1,64}` in function names.
- Each description starts with the server's title
  (`[Search · Wikipedia, Hacker News, Open Library] …`), so the model reads
  the server as part of the choice.
- The router maps the namespaced name to (server, tool) and calls the server
  with the **tool's own name**; servers never see prefixes. Two servers with
  the same prefix are refused at startup; two servers with the same tool name
  are fine.
- Every call in the trace shows both sides: `⚙ 2 search__wiki_article → searchserver.wiki_article`.

## Scenarios and the grader

```json
{
  "name": "hn-vs-wiki",
  "prompt": "Compare what Hacker News discussions and Wikipedia say about the James Webb Space Telescope, and save the comparison to jwst-hn-vs-wiki.md",
  "steps": [
    {"id": "hn",   "tool": "search__hackernews"},
    {"id": "wiki", "tool": "search__wikipedia|search__wiki_article"},
    {"id": "cmp",  "tool": "text__compare", "from": ["hn", "wiki"]},
    {"id": "save", "tool": "file__save", "from": ["cmp"], "args": {"filename": "jwst-hn-vs-wiki.md"}}
  ],
  "forbid": ["file__append", "search__books", "search__book"],
  "max_calls": 6
}
```

| field | checks |
|---|---|
| `tool` | the step is filled by a successful call of this tool; `a\|b` accepts either |
| `after` | those steps' calls came earlier: a partial order, so two searches may run in either order |
| `from` | those steps' output reached this call's arguments (implies `after`). A long argument counts by its handoff verdict (`exact`, `whitespace`, `partial`, `joined`, `reworded`). A short one, such as a title or a `work_id`, counts when the value is in that output and not in the prompt. Data may pass through other calls: `from hn (via 2: exact)` |
| `args` | these arguments have exactly these values |
| `forbid` | these tools are not called at all, successfully or not |
| `max_calls` | at most this many successful calls: the steps plus two, room for one retry. The notes scenario also allows reading the notes, since the prompt asks for that |
| `setup` | calls made through the router before the turn, outside the grade: the notes that scenario 3 looks through |

The grader tries **every** assignment of calls to steps and keeps the one
where the most steps are met. When the model summarizes twice and saves the
second summary, the save step matches that second call, and only the step
that actually went wrong fails. Calls no step accounts for are listed as
`extra`. They fail the run only when they are forbidden or push it over
`max_calls`. A call to a tool no server offers always fails the run.

| # | scenario | servers | what it tests |
|---|---|---|---|
| 1 | HN vs Wikipedia → `compare` → `save` | search, text, file | picking among three search tools; `compare` needs both outputs |
| 2 | Le Guin's most-read book → its article → summary → `append` to a reading list | search, text, file | a short value (the title) carried between tools; `append`, not `save` |
| 3 | "look through my notes" → add a Rust summary where it belongs | file, search, text, file | reading before writing; the file chosen from what it holds |
| 4 | Apollo 11 → people and roles → JSON file | search, text, file | `extract`, not `summarize`; `format: json` |
| 5 | tomorrow's weather in Paris, saved to a file | none | no tool fits: zero calls, nothing saved, and the model says so |

## Run

```bash
go build -o . ./cmd/...        # four binaries
export DEEPSEEK_API_KEY=sk-…   # or a .env file (textserver and orchagent both read it)

./searchserver                 # terminal 1
./textserver                   # terminal 2
./fileserver                   # terminal 3, reads and writes ./out
./orchagent                    # terminal 4, REPL; /tools lists all 12 with their prefixes
./orchagent -q "…"             # one request
./orchagent -eval scenarios/   # every scenario, graded, with a table at the end
./orchagent -eval scenarios/2-le-guin.json -raw
```

| flag | default | |
|---|---|---|
| `orchagent -servers` | the three local URLs | comma-separated, each `url` or `prefix=url` |
| `orchagent -eval` | | scenario file or directory; exit code 1 unless all pass |
| `orchagent -q` / `-model` / `-rounds` | / `deepseek-flash` / `8` | |
| `orchagent -raw` / `-plain` | | full arguments and results / raw markdown answer |
| `searchserver -addr` | `localhost:8771` | |
| `textserver -addr` / `-model` | `localhost:8772` / `deepseek-flash` | |
| `fileserver -addr` / `-dir` | `localhost:8773` / `out` | |

## Real run

Unedited `./orchagent -plain -eval scenarios/`, on an empty `out/`. The
servers ran against the live APIs and DeepSeek. In eval mode each tool's
output is not printed in full (`-q` and the REPL print it, as in task 19).
The trace shows where every call went and how the data reached it, and
under each scenario the grade says how the calls met its steps.

```

  orchagent · deepseek-flash · 3 MCP servers over Streamable HTTP

  ✓ searchserver  http://localhost:8771/mcp · protocol 2025-11-25
      search__book · books · hackernews · wiki_article · wikipedia
  ✓ textserver    http://localhost:8772/mcp · protocol 2025-11-25
      text__compare · extract · summarize
  ✓ fileserver    http://localhost:8773/mcp · protocol 2025-11-25
      file__append · list · read · save
  12 tools from 3 servers, offered to the model as one list, each as <prefix>__<tool>

  ━━ scenario 1/5 hn-vs-wiki scenarios/1-jwst-hn-vs-wiki.json

  › Compare what Hacker News discussions and Wikipedia say about the James Webb Space Telescope, and save the comparison to jwst-hn-vs-wiki.md

  ⚙ 1 search__hackernews → searchserver.hackernews
      {"limit":15,"query":"James Webb Space Telescope","sort":"relevance"}
      ✓ 681ms · query="James Webb Space Telescope" returned=15 sort="relevance" total_matches=5…
  ⚙ 2 search__wikipedia → searchserver.wikipedia
      {"chars":5000,"limit":3,"query":"James Webb Space Telescope"}
      ✓ 1.6s · detail="intro" query="James Webb Space Telescope" returned=3 total_matches=1446…
  ⚙ 3 text__compare → textserver.compare
      {"a":"1. The James Webb Space Telescope is fin… (3,700 chars)","a_label":"Hacker News","b":…
      ⇐ a · from step 1 search__hackernews · exact · 3,700 chars · sha256 8f32d75c
      ⇐ b · from step 2 search__wikipedia · exact · 5,588 chars · sha256 6d6b7280
      ✓ 27.5s · a_chars=3700 b_chars=5588 model="deepseek-flash" output_words=415 sections[4] u…
  ⚙ 4 file__save → fileserver.save
      {"content":"## In common - A includes an item titled… (2,607 chars)","filename":"jwst-hn-vs…
      ⇐ content · from step 3 text__compare · whitespace differs (trailing "\n" added) · 2,607 chars
      ✓ 10ms · bytes=2627 overwritten=false path="out/jwst-hn-vs-wiki.md"
      ≡ stored sha256 dfa5e1ad… = content sent

  chain search__hackernews → search__wikipedia → text__compare → file__save · 3 handoffs: 2 exact, 1 whitespace · stored = sent

  I searched Hacker News (15 top JWST stories with points, comments and dates) and Wikipedia (the JWST, JWST sunshield and James E. Webb articles), compared the two with the compare tool, and saved the result.

  The comparison is at `out/jwst-hn-vs-wiki.md` (2627 bytes) — it shows shared ground (launch on 25 December 2021, NASA's role, early-galaxy science, budget pressures), headline-only coverage unique to HN, the technical/historical detail unique to Wikipedia, and no outright disagreements.

  4 model calls · 28,114 in / 3,682 out tokens · 43.4s

  grade hn-vs-wiki PASS · 4 calls
    ✓ hn   search__hackernews                     → searchserver.hackernews · call 1
    ✓ wiki search__wikipedia                      → searchserver.wikipedia · call 2
    ✓ cmp  text__compare                          → textserver.compare · call 3
           after hn, wiki ✓ · from hn (exact) · from wiki (exact)
    ✓ save file__save                             → fileserver.save · call 4
           after cmp ✓ · from cmp (whitespace) · filename="jwst-hn-vs-wiki.md" ✓

  ━━ scenario 2/5 le-guin scenarios/2-le-guin.json
  setup file__save → Saved out/reading-list.md · 92 bytes · sha256 c92dbcf28355e24ff646b6f…

  › Find Ursula K. Le Guin's most-read book on Open Library, read its Wikipedia article, summarize it in about 120 words and add the summary to my reading-list.md

  ⚙ 1 search__books → searchserver.books
      {"author":"Ursula K. Le Guin","limit":5,"sort":"readers"}
      ✓ 824ms · returned=5 total_found=260 work_ids[5]
  ⚙ 2 search__wiki_article → searchserver.wiki_article
      {"chars":12000,"title":"A Wizard of Earthsea"}
      ✓ 951ms · chars=34946 title="A Wizard of Earthsea" truncated=true
  ⚙ 3 text__summarize → textserver.summarize
      {"format":"plain","max_words":120,"text":"# A Wizard of Earthsea https://en.wikipe… (11,617…
      ⇐ text · from step 2 search__wiki_article · exact · 11,617 chars · sha256 086b4f4b
      ✓ 3.9s · input_chars=11617 model="deepseek-flash" output_words=100 ungrounded_links[0]
  ⚙ 4 file__append → fileserver.append
      {"content":"A Wizard of Earthsea, by Ursula K. Le Gu… (584 chars)","filename":"reading-list…
      ⇐ content · from step 3 text__summarize · exact · 584 chars · sha256 5ecc5945
      ✓ 5ms · appended=586 bytes=679 created=false path="out/reading-list.md" separator="\n"
      ≡ stored sha256 5ecc5945… = content sent

  chain search__books → search__wiki_article → text__summarize → file__append · 2 handoffs: 2 exact · stored = sent

  Le Guin's most-read Open Library work is *A Wizard of Earthsea* (OL59798W, 1,072 readers); I read its Wikipedia article, summarized it in ~120 words, and appended that summary to your reading list.

  The result is in `out/reading-list.md` (now 679 bytes; appended 586 bytes, sha256 `5ecc59453500ca83f38ba31624df0e30daccdc7ad9d3621bd8f9aff5e1898273`).

  5 model calls · 32,515 in / 3,509 out tokens · 20.4s

  grade le-guin PASS · 4 calls
    ✓ books   search__books                          → searchserver.books · call 1
    ✓ article search__wiki_article                   → searchserver.wiki_article · call 2
              after books ✓ · from books (value "A Wizard of Earthsea")
    ✓ sum     text__summarize                        → textserver.summarize · call 3
              after article ✓ · from article (exact)
    ✓ add     file__append                           → fileserver.append · call 4
              after sum ✓ · from sum (exact) · filename="reading-list.md" ✓

  ━━ scenario 3/5 notes scenarios/3-notes.json
  setup file__save → Saved out/space.md · 70 bytes · sha256 435c949e143d259deded3f69a56a1d…
  setup file__save → Saved out/languages.md · 101 bytes · sha256 496c7bf603782b4f815604714…

  › Look through my notes and add a short summary of the Wikipedia article on the Rust programming language to the note where it belongs.

  ⚙ 1 file__list → fileserver.list
      {}
      ✓ 2ms · dir="out" files[4]
  ⚙ 2 file__read → fileserver.read
      {"filename":"languages.md"}
      ✓ 5ms · bytes=101 modified="2026-09-26T11:50:38+10:00" path="out/languages.md"
  ⚙ 3 file__read → fileserver.read
      {"filename":"reading-list.md"}
      ✓ 1ms · bytes=679 modified="2026-09-26T11:50:37+10:00" path="out/reading-list.md"
  ⚙ 4 file__read → fileserver.read
      {"filename":"jwst-hn-vs-wiki.md"}
      ✓ 1ms · bytes=2627 modified="2026-09-26T11:50:16+10:00" path="out/jwst-hn-vs-wiki.md"
  ⚙ 5 file__read → fileserver.read
      {"filename":"space.md"}
      ✓ 0ms · bytes=70 modified="2026-09-26T11:50:38+10:00" path="out/space.md"
  ⚙ 6 search__wiki_article → searchserver.wiki_article
      {"title":"Rust (programming language)"}
      ✓ 870ms · chars=34252 title="Rust (programming language)" truncated=true
  ⚙ 7 text__summarize → textserver.summarize
      {"focus":"what Rust is, its key features, origin,… (52 chars)","format":"plain","max_words"…
      ⇐ text · from step 6 search__wiki_article · exact · 4,958 chars · sha256 e38efe99
      ✓ 2.7s · input_chars=4958 model="deepseek-flash" output_words=96 ungrounded_links[0]
  ⚙ 8 file__append → fileserver.append
      {"content":"## Rust Rust is a general-purpose progr… (661 chars)","filename":"languages.md"}
      ⇐ content · from step 7 text__summarize · partial: 1 of 1 lines kept, 1 added · 661 chars
      ✓ 4ms · appended=661 bytes=763 created=false path="out/languages.md" separator="\n"
      ≡ stored sha256 2b0c4c8b… = content sent

  chain file__list → file__read → file__read → file__read → file__read → search__wiki_article → text__summarize → file__append · 2 handoffs: 1 exact, 1 partial · stored = sent

  I read your four notes and found that the Rust summary belongs in `out/languages.md`, the "Programming languages" note that already had a Go section. I fetched the Wikipedia article "Rust (programming language)", condensed it, and appended it as a new "## Rust" section alongside the existing "## Go" entry.

  The file is now 763 bytes at `out/languages.md`.

  6 model calls · 31,271 in / 1,889 out tokens · 14.1s

  grade notes PASS · 8 calls
    ✓ list file__list                             → fileserver.list · call 1
    ✓ wiki search__wiki_article                   → searchserver.wiki_article · call 6
    ✓ sum  text__summarize                        → textserver.summarize · call 7
           after wiki ✓ · from wiki (exact)
    ✓ add  file__append                           → fileserver.append · call 8
           after list, sum ✓ · from sum (partial) · filename="languages.md" ✓
    · extra call 2 file__read
    · extra call 3 file__read
    · extra call 4 file__read
    · extra call 5 file__read

  ━━ scenario 4/5 apollo scenarios/4-apollo.json

  › Get the Wikipedia article on the Apollo 11 mission, pull out every person it names together with their role, and save them as JSON to apollo11-people.json

  ⚙ 1 search__wiki_article → searchserver.wiki_article
      {"chars":12000,"title":"Apollo 11"}
      ✓ 1.1s · chars=79626 title="Apollo 11" truncated=true
  ⚙ 2 text__extract → textserver.extract
      {"columns":["person","role"],"format":"json","max_items":100,"text":"# Apollo 11 https://en…
      ⇐ text · from step 1 search__wiki_article · exact · 10,222 chars · sha256 633f955c
      ✓ 24.9s · items=14 model="deepseek-flash" columns[2] dropped[0]
  ⚙ 3 file__save → fileserver.save
      {"content":"[ {\"person\": \"Neil Armstrong\", \"role\":… (1,599 chars)","filename":"apollo…
      ⇐ content · from step 2 text__extract · exact · 1,599 chars · sha256 0207a611
      ✓ 5ms · bytes=1599 overwritten=false path="out/apollo11-people.json"
      ≡ stored sha256 0207a611… = content sent

  chain search__wiki_article → text__extract → file__save · 2 handoffs: 2 exact · stored = sent

  I fetched the Wikipedia article "Apollo 11" (https://en.wikipedia.org/wiki/Apollo_11), extracted 14 named people with their roles, and saved them as JSON to `out/apollo11-people.json` (1599 bytes) — the mission crew (Neil Armstrong, Michael Collins, Buzz Aldrin), presidents Richard Nixon, John F. Kennedy and Dwight D. Eisenhower, cosmonaut Yuri Gagarin, Alan Shepard, Norbert Wiener, Nikita Khrushchev, James Webb, and astronauts Gus Grissom, Ed White and Roger B. Chaffee.

  One caveat: the article fetch is capped at 12,000 characters, so the text ends at the start of the "Personnel" section; the extraction therefore covers the lead and Background sections only, not any people named later in the article.

  4 model calls · 27,477 in / 3,896 out tokens · 41.4s

  grade apollo PASS · 3 calls
    ✓ article search__wiki_article                   → searchserver.wiki_article · call 1
    ✓ people  text__extract                          → textserver.extract · call 2
              after article ✓ · from article (exact) · format="json" ✓
    ✓ save    file__save                             → fileserver.save · call 3
              after people ✓ · from people (exact) · filename="apollo11-people.json" ✓

  ━━ scenario 5/5 weather scenarios/5-weather.json

  › What will the weather be in Paris tomorrow? Save the forecast to paris.md.


  I can't do this: none of the tools I have access to provide weather data or forecasts. My tools cover Wikipedia, Hacker News, Open Library book search, text summarising/comparison and file storage in the output directory — nothing that reads current or predicted weather, so I have no factual basis for a Paris forecast and won't invent one. For that reason I've also written nothing to `paris.md`; for the forecast itself you'd need a dedicated weather service or app.

  1 model call · 3,268 in / 192 out tokens · 1.5s

  grade weather PASS · 0 calls
    ✓ no tool called, as expected

  ━━ results

  scenario    grade   steps  calls llm calls    tokens    time
  hn-vs-wiki  PASS      4/4      4         4    31,796   43.4s
  le-guin     PASS      4/4      4         5    36,024   20.4s
  notes       PASS      4/4      8         6    33,160   14.1s
  apollo      PASS      3/3      3         4    31,373   41.4s
  weather     PASS      0/0      0         1     3,460    1.5s

  5 of 5 scenarios passed
```

In scenario 3 the model read all four notes: the two from the scenario's
setup, plus the two that scenarios 1 and 2 had just written. Those reads are
`extra`: they fill no step, and they stay within the scenario's budget. It
then appended to `languages.md`, the note it had to find. It put a `## Rust`
heading before the summary; the handoff says so (`partial: 1 of 1 lines
kept, 1 added`), and `from` accepts it.

## What the earlier runs caught

This was the third full run. The first two failed in ways that changed the
code or the scenarios. Each failure is kept here, because each one shows
what the grader and the checks are for.

**The model wrote its own text instead of passing the article** (scenario 2,
run 1). It fetched 20,000 characters of *A Wizard of Earthsea*, then called
`summarize` with a 1,533-character text of its own (`matches no earlier
output`), twice, and appended the second summary. The grade failed `sum` with
`carries nothing from article`. That was right. It also failed `add`, which
was wrong: the grader then took the earliest `summarize` call for `sum`, and
the append had carried the second one. Since then the grader searches for the
best assignment, and only the step that went wrong fails.

**Carrying 20,000 characters is slow, and invites shortcuts.** The model asked
`wiki_article` for its maximum every time. In scenario 4 it carried 19,907
characters into `extract` three times; each extraction took about a minute
and the scenario took 3½ minutes. The first `extract` also returned a single
row, a one-off bad answer that did not happen again when repeated by hand.
The model rightly retried, and went over the call budget. `wiki_article` now
stops at 12,000 characters (default 6,000). In run 3 every article reached
the next tool `exact`, and scenario 4 took 41 seconds.

**Reworded data looked like no data** (scenario 1, run 2). The model rewrote
the Hacker News list before passing it to `compare`. No line survived as it
was, so the handoff said `none` and the grade said "carries nothing from hn".
The data did come from HN, only reworded. The chain check now has a
`reworded` verdict: no line kept, but most of the argument's words are one
output's (at least 60% of its words, and at least 10 of them). It counts as
provenance, shows the share in the trace, and is flagged in yellow like
`partial` and `none`.

**`read` looked like a failed store** (scenario 3, run 1). The chain check
compares any `sha256` in a result with the hashes of what was sent, which
task 19 used to prove a file matched its call. `read` reported the file's hash
as `sha256`, so every read printed `stored ≠ sent`. It is `file_sha256` now.

**Network errors are not grades** (run 2). DeepSeek timed out on scenario 3,
and a local network error cut off scenario 4; both were graded as FAIL with 0
calls. A turn that ends in an error is now marked as having no grade.

**The first budget for scenario 3 was too tight.** "Look through my notes"
led the model to read every note, one call over `max_calls: 7`. The budget is
now the steps plus two for every scenario, and scenario 3 also allows the
reads its prompt asks for.

## Tests

`go test ./...`: no network, 65 tests.

- **agent**: routing with prefixes, the same tool name on two servers,
  prefix clashes, names a model API would refuse; the handoff verdicts,
  `reworded` included.
- **grade**: hand-built traces that pass, use the wrong tool, go in the wrong
  order, carry made-up data, carry data through another call, carry a title,
  call a forbidden or unknown tool, go over the limit, retry after a failure,
  summarize twice; scenario validation and loading, including the shipped
  files.
- **search / texttools / files**: each tool through a real MCP client, its
  backend faked (`httptest` for Wikipedia, HN, Open Library and DeepSeek).
  `extract` drops rows whose quote is not in the text; `append` separators;
  `read` refuses paths and symlinks; `list` skips hidden, temporary and
  foreign files.
- **e2e**: the three real servers over Streamable HTTP with a scripted model.
  Scenario 1 played right passes, with every call routed to the server its
  prefix names and the file on disk. Played with the wrong search tool, the
  save before the comparison and a forbidden call, it fails with exactly
  those reasons.

## Layout

```
agent/      router (namespaces), tool loop, chain check (handoff verdicts)
grade/      scenarios, provenance, matching calls to steps
search/     wiki.go · hackernews.go · books.go · server.go (five tools)
texttools/  summarize.go · extract.go · compare.go · server.go
files/      save.go · ops.go (append, read, list) · server.go
mcpserve/   Streamable HTTP, request log, shutdown: shared by the servers
llm/        DeepSeek client (JSON mode added for extract)
cmd/        searchserver · textserver · fileserver · orchagent (REPL, -q, -eval)
scenarios/  the five scenarios
e2e/        whole flow on localhost with a scripted model
```
