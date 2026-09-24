# Task 18 — Scheduler and background tasks

An MCP server that **collects the Hacker News front page on a schedule** and
keeps the history in SQLite, and an agent that **runs until stopped** and
writes a digest of what changed every `-every`.

Go, [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk)
v1.8.0 over **Streamable HTTP**, [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite)
(pure Go, no cgo), DeepSeek for the model.

```
                 ┌──────────────────── hnserver (long-running) ─────────────────────┐
┌──────────┐     │                                                                  │
│ hnagent  │ HTTP│  tools: schedule_collection · list_jobs · cancel_job · get_summary│
│ 24/7 loop│────▶│      │                                                           │
│ + LLM    │◀────│      ▼                                              HTTPS        │   ┌────────────┐
└────┬─────┘     │  SQLite ◀── scheduler goroutine ── due job? ── collect ──────────┼──▶│ HN Firebase│
     │ HTTPS     │                                                                  │   │    API     │
     ▼           └──────────────────────────────────────────────────────────────────┘   └────────────┘
 DeepSeek
```

- **`hnserver`** is a standalone process. The scheduler lives here, so
  collection continues with no client connected. Jobs and history are in
  SQLite, so a restart loses nothing.
- **`hnagent`** connects over HTTP. At startup it asks the model to make sure a
  collection is scheduled. After that it writes a digest every `-every`, and it
  answers whatever you type in between. As in task 17, it names no tool: the
  model finds them through `tools/list`.

[PLAN.md](PLAN.md) has the design and what the build changed.

## Task checklist

| task item | where |
|---|---|
| MCP tool with periodic execution | `schedule_collection` creates a job, and `scheduler/scheduler.go` runs it every interval in the background, independently of any client |
| persist data (JSON / SQLite) | `store/store.go`: `jobs`, `runs`, `stories` and `snapshots` tables in one SQLite file, WAL mode; each run is written in a single transaction |
| run on a schedule | `Scheduler.Run`: sleep until the earliest `next_run_at`, run due jobs, reschedule from the finish time; missed runs collapse into one |
| return an aggregated result | `get_summary` → `store/summary.go`: new entries, risers, drop-outs, came-and-went, points gained, most discussed, current top, with counts |
| agent that runs 24/7 and periodically delivers a summary | `cmd/hnagent`: a digest timer, stdin for questions, reconnection when the server restarts, a fresh conversation per digest |

## Tools

| tool | params | returns |
|---|---|---|
| `schedule_collection` | `every` (`30s`…`24h`), `top_n` (1–100, default 30) | the job, and `created: false` when an identical active job already existed |
| `list_jobs` | `include_cancelled` | jobs with `every`, `next_run_at`, `last_run_at`, `runs`, `last_error`, plus server `now` |
| `cancel_job` | `job_id` | the job, now `cancelled`; its history stays |
| `get_summary` | `since` (`2h` or an RFC 3339 time, default 24h), `job_id`, `limit` (1–20, default 5) | the aggregate below |

**How `get_summary` aggregates.** It compares the latest snapshot in the window
with a **baseline**: the last snapshot taken *before* the window, or, if there
is none, the window's first snapshot. So "since the last digest" means
"compared with what the last digest saw".

| list | meaning |
|---|---|
| `new_entries` | on the list now, not at the baseline |
| `risers` | on the list at both ends, climbed the most (`rank_from` → `rank`) |
| `dropped` | on the list at the baseline, gone now (`rank` = last position held) |
| `came_and_went` | appeared and left inside the window (`rank` = best position) |
| `top_points_gained` | on the list now, most points gained since first seen |
| `most_discussed` | on the list now, most comments |
| `current_top` | the latest snapshot, top `limit` |

The `window` field reports the baseline, the latest snapshot, how many
snapshots are in the window and how many runs failed. `counts` gives each
list's full length before truncation. A window with no data is not an error:
`note` says so and gives the time of the next collection.

## Scheduling rules

- **A new job runs immediately**, then every `every` counted from when the
  previous run *finished*, so a slow run can never overlap the next one.
- **Missed runs are skipped, not replayed.** After three hours of downtime, a
  job runs once at startup and continues from there. Replaying 360 snapshots of
  "now" would fake history.
- **A failed run is recorded** (`last_error`, a `runs` row with `ok = 0`) and
  rescheduled as usual. One unreachable item is only counted as `skipped`; the
  run fails only if the ranking itself can't be fetched.
- **Ctrl-C in the middle of a run records nothing**, so the job is still due and
  runs first after a restart.
- **The minimum interval is 10s**, which keeps demos fast without letting a
  typo hammer HN.

## Run

```bash
go build -o . ./cmd/...        # ./hnserver and ./hnagent
export DEEPSEEK_API_KEY=sk-…   # or a .env file here

./hnserver                     # terminal 1: http://localhost:8765/mcp, hn.db
./hnagent                      # terminal 2: digest every hour, collection every 15m
./hnagent -every 2m -collect 20s   # demo pace
```

| `hnserver` flag | default | |
|---|---|---|
| `-addr` | `localhost:8765` | listen address |
| `-db` | `hn.db` | SQLite file |

| `hnagent` flag | default | |
|---|---|---|
| `-server` | `http://localhost:8765/mcp` | MCP endpoint |
| `-every` | `1h` | digest interval |
| `-collect` | `15m` | collection interval to ask for at startup |
| `-top` | `30` | how many top stories the collection should cover |
| `-model` | `deepseek-flash` | or `deepseek-v4-pro` |
| `-rounds` | `6` | tool rounds per turn |
| `-raw` / `-plain` | | full JSON trace / raw markdown answers |

Agent commands: type any question · `/now` (write a digest now; the schedule
restarts from here) · `/tools` · `/raw` · `/quit`.

**What keeps the agent running:**

- **The server isn't up yet:** it retries with backoff (2s → 30s), printing one
  line per attempt with the root cause.
- **The server restarted:** before each turn, a `ping` checks the session; a
  dead session is replaced.
- **A digest failed:** it retries after `min(30s, -every)`. The window still
  starts at the last digest that succeeded, so nothing is skipped.
- **Every digest is a fresh conversation.** A process that runs for days can't
  carry one growing history. What links the digests is the time window, and the
  data is on the server.
- **stdin closed** (e.g. under `nohup`): it keeps running on the timer.

## A real run

Unedited, with `-plain` (the terminal renders the markdown). The server had
been collecting every 30s for 17 minutes, started by an earlier client. The
agent starts, finds that job instead of creating a duplicate, and is asked
about the last 20 minutes:

```

  hnagent · deepseek-flash · MCP over Streamable HTTP
  server   http://localhost:8798/mcp
  digest   every 10m · collection requested every 30s

  ✓ server/discover                  3ms
  ✓ initialize                       0ms
  ✓ notifications/initialized        0ms
  ✓ tools/list                       2ms

  connected hnserver 0.1.0 · protocol 2025-11-25
  tools · 4   cancel_job, get_summary, list_jobs, schedule_collection

  Runs until stopped. Type a question at any time; /now for a digest right away, /help for more.

  ── setup ─────────────────────────────────────────────────────────────

  ⚙ list_jobs {"include_cancelled":true}
    ✓ 7ms · now="2026-09-24T21:54:40+10:00" jobs[1]

  Job 1 (`hn_top`, every 30s, top_n 30, active, 32 runs) already matches, so no new collection was scheduled; it last ran at 21:54 and runs next at 21:54.

  2 model calls · 2,192 in / 154 out tokens · 2.5s
  first digest at 22:04:41
› what changed on the front page over the last 20 minutes?

  ── question ──────────────────────────────────────────────────────────

  ⚙ list_jobs {}
    ✓ 1ms · now="2026-09-24T21:54:50+10:00" jobs[1]
  ⚙ get_summary {"job_id":1,"since":"20m","limit":10}
    ✓ 22ms · job_id=1 stories_tracked=31 came_and_went[0] counts{…} current_top[10] dropped[1] most_di…

  **Front page in the last 20 minutes** (window 21:34–21:54, baseline snapshot 21:37; 33 snapshots, no failed runs):

  **New entries**
  - [The Year of Internal Tools](https://www.geocod.io/code-and-coordinates/2026-09-23-the-year-of-internal-tools) — entered at #24, 7 points, [1 comment](https://news.ycombinator.com/item?id=49827383)

  **Dropped off**
  - [Show HN: An open-source manufacturing ERP/MES/QMS](https://carbon.ms/self-hosted) — fell from #30, 41 points, [17 comments](https://news.ycombinator.com/item?id=49824715)

  **Biggest climbers**
  - [The newest ESP32 can run Linux and it's getting close to a Raspberry Pi](https://www.xda-developers.com/newest-esp32-run-linux-close-to-raspberry-pi/) — #25 → #14
  - [Meta takes down a critical video about meta AI Glasses after filming at Meta](https://www.reddit.com/r/facebook/comments/1wotwrk/meta_takes_down_a_critical_video_about_meta_ai/) — #7 → #5 (+18 pts, most points gained in the window)
  - [VSCode's SSH Agent Is Bananas (2025)](https://fly.io/blog/vscode-ssh-wtf/) — #11 → #9
  - [Claude discovers a novel enzyme system with CRISPR-like repeats](https://www.anthropic.com/news/claude-discovers-novel-enzyme-system) — #4 → #3

  **Most discussed overall**
  - [Claude discovers a novel enzyme system with CRISPR-like repeats](https://www.anthropic.com/news/claude-discovers-novel-enzyme-system) — 688 comments, 676 pts, #3
  - [Italian parliament votes for return to nuclear energy](https://apnews.com/article/italy-nuclear-chernobyl-4891b6b7c7791ae84db6b0bf0f7cf567) — 645 comments, 811 pts, but sitting at #30
  - [Meta VR Glasses](https://www.meta.com/vr-glasses/) — 373 comments, #22

  **Current top 5**
  1. [Nokia Design Archive (2025)](https://nokiadesignarchive.aalto.fi/index.html) — 79 pts, [36 comments](https://news.ycombinator.com/item?id=49828385)
  2. [Linux support is coming to Snapdragon X2 Series](https://www.qualcomm.com/news/onq/2026/09/snapdragon-summit-agentic-ai-pcs-linux) — 456 pts, [193 comments](https://news.ycombinator.com/item?id=49823582)
  3. [Claude discovers a novel enzyme system with CRISPR-like repeats](https://www.anthropic.com/news/claude-discovers-novel-enzyme-system) — 676 pts
  4. [Ideas on modernizing the open-source desktop](https://lwn.net/SubscriberLink/1095425/2d9f411252325784/) — 175 pts, [194 comments](https://news.ycombinator.com/item?id=49825642)
  5. [Meta takes down a critical video about meta AI Glasses after filming at Meta](https://www.reddit.com/r/facebook/comments/1wotwrk/meta_takes_down_a_critical_video_about_meta_ai/) — 226 pts, [102 comments](https://news.ycombinator.com/item?id=49827794)

  Net: 1 new entry, 1 dropout, 9 risers, 0 stories that came and went entirely. Note the collection only began at 21:37, so this window covers 17 minutes of actual snapshots; the next run is due 21:55.

  3 model calls · 6,682 in / 1,060 out tokens · 5.2s · next digest 22:04:41
```

The server terminal meanwhile (excerpt):

```
21:37:54  job 1 hn_top  ✓ 30 stories · 30 new · 2.0s
21:38:25  job 1 hn_top  ✓ 30 stories · 0 new · 1.4s
21:38:57  job 1 hn_top  ✓ 30 stories · 0 new · 1.5s
…
21:54:45  job 1 hn_top  ✓ 30 stories · 0 new · 1.6s
21:54:50  ← list_jobs {} · 0ms
21:54:51  ← get_summary {"job_id":1,"limit":10,"since":"20m"} · 15ms
21:55:16  job 1 hn_top  ✓ 30 stories · 0 new · 1.6s
21:55:48  job 1 hn_top  ✓ 30 stories · 0 new · 1.7s
21:55:53  shutting down
```

What it shows:

- **The work happened without the agent.** 32 runs were already in SQLite
  before the agent connected. The agent only reads.
- **Bootstrapping is idempotent through the model.** It checked `list_jobs`,
  saw a matching job and left it alone.
- **The model gets aggregates, not rows.** One `get_summary` call covered 33
  snapshots × 30 stories. The window began before the first snapshot, so the
  baseline fell back to the first snapshot inside it (21:37), and the model
  reported that.
- **The agent names no tool.** "Over the last 20 minutes" became
  `since: "20m"`, taken from the schema.

The resilience paths were also checked live against the real server: the agent
started before the server, `/now` right before a scheduled digest, and a
server restart in the middle of a digest followed by the retry. What those runs
changed is in the [PLAN.md addendum](PLAN.md#addendum--what-the-build-changed).

## Tests

```bash
go test -race ./...     # 35 tests, no network
```

- **store:** job idempotency (also under 8 concurrent callers) and cancel, a run written with its snapshot in
  one transaction (a failed run stores no rows, edited titles are updated),
  and the aggregation against hand-built snapshots. That covers every list,
  tie-breaking, a baseline before the window versus inside it, a single
  snapshot, an empty window, a window with only failures, an unknown job, and
  limits.
- **scheduler:** an injected clock and a fake collector, no sleeping. A due job
  runs and is rescheduled from its finish time, 180 missed slots collapse into
  one run, a failure is recorded and rescheduled, a cancelled job never runs, a
  shutdown mid-run leaves no trace, and an idle loop wakes up for a new job.
- **hn:** a fake API. Covered: `null`, deleted, dead and failing items, text
  posts linking to their discussion, rank gaps kept, the ranking request
  failing, and an empty list.
- **tools:** a real MCP client over in-memory transports. Covered: `every`
  validation and formatting, idempotency, cancel, `since` as a duration and as
  a timestamp, and `null` arguments (the SDK crash above). One test runs **end
  to end over Streamable HTTP with the scheduler running**: a client schedules
  a job, the background loop collects without any further calls, and
  `get_summary` sees the result.
- **agent:** a scripted fake DeepSeek against the real tools. Covered: schemas
  reach the model unchanged, the round trip, tool errors recovered from,
  unknown tools and bad arguments, the round cap, rollback on failure, and a
  custom system prompt.
