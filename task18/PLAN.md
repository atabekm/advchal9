# Task 18 — Scheduler and background tasks · plan

> *Build an MCP tool with delayed or periodic execution. It must persist data
> (JSON / SQLite), run on a schedule, and return an aggregated result.
> Result: an agent that runs 24/7 and periodically delivers a summary.*

[Task 17](../task17) was request → response: the server did nothing between
calls. This task adds a server that **works when nobody is asking**. It
collects Hacker News on a timer, keeps everything in SQLite, and answers with
aggregates rather than raw rows.

Scope: **periodic collection only** (option A). One-off reminders delivered by
server push (option B) are left for later. The scheduler is built around job
*kinds* so that B can be added without a rewrite.

## Shape

```
                 ┌──────────────────────── hnserver (long-running) ───────────────────────┐
┌──────────┐     │                                                                         │
│ hnagent  │ HTTP│  MCP tools ── schedule_collection · list_jobs · cancel_job · get_summary│
│ 24/7 loop│────▶│      │                                                                  │
│ + LLM    │◀────│      ▼                                                    HTTPS         │   ┌────────────┐
└────┬─────┘     │   SQLite (hn.db) ◀── scheduler goroutine ── due job? ── collect ────────┼──▶│ HN Firebase│
     │ HTTPS     │                                                                         │   │    API     │
     ▼           └─────────────────────────────────────────────────────────────────────────┘   └────────────┘
 DeepSeek
```

Two binaries, as in task 17, but with a different relationship:

- **`hnserver`** is a standalone process serving MCP over **Streamable HTTP**
  (`http://localhost:8765/mcp`). It owns the scheduler and the database, and
  keeps collecting whether or not any agent is connected. Stop it and restart
  it, and the jobs and history are still there.
- **`hnagent`** connects over HTTP, not as a parent process. It runs until you
  stop it: every `-every` it asks DeepSeek for a digest of what happened since
  the last one. The model gets the numbers by calling `get_summary`. As in
  task 17, the agent has no tool-specific code.

## Why the scheduler lives in the server

A `sleep` loop in the agent that calls a stateless tool would also "run
periodically", but then the *tool* isn't scheduled; the client is. Here the
agent only **reads** results. You can kill the agent for an hour, restart it,
and ask "what happened while I was away?", and the data will be there because
the server kept collecting.

## Data source — HN Firebase API

Checked live: keyless, about 0.5s per request.

- `GET /v0/topstories.json` returns up to 500 ids in rank order.
- `GET /v0/item/{id}.json` returns `{id, title, url, by, score, descendants, time, type}`.

One **collection** = the top-N ids + N item fetches (8 concurrent workers,
10s timeout each). A failed item is skipped and counted, not fatal. If the
ids request fails, the whole run fails and is recorded with its error.
`url` is missing for Ask HN / text posts, so we fall back to
`https://news.ycombinator.com/item?id=…`. Deleted or dead items come back as
`null` or `{deleted: true}` and are skipped.

## Persistence — SQLite

`modernc.org/sqlite` (pure Go, no cgo), WAL mode, one file (`-db hn.db`).

```sql
jobs      (id, kind, params_json, interval_sec, enabled,
           created_at, next_run_at, last_run_at, last_error)
runs      (id, job_id, started_at, finished_at, ok, error, items)
stories   (id PK, title, url, by, posted_at, first_seen_at)       -- upserted
snapshots (run_id, story_id, rank, score, comments)                -- one row per story per run
```

`kind` is `hn_top` for now, with `params_json = {"top_n": 30}`. Reminders
would add a new kind, not a new table.

Times are stored as Unix seconds in UTC and rendered as RFC 3339.

## Scheduler

One goroutine:

```
loop:
  next := earliest next_run_at among enabled jobs
  wait until next, or a wake-up signal (job added / cancelled), or shutdown
  for each due job: run it (single-flight per job), record the run,
                    next_run_at = now + interval
```

- **Missed runs are skipped, not replayed.** If the server was down for 3 hours
  with a 10-minute job, it runs once on startup and continues from there.
  Replaying 18 snapshots of "now" would be fake history.
- Scheduling is based on the **finish time**, so a slow run can't pile up
  overlapping runs.
- `Ctrl-C` cancels any in-flight run, closes the DB cleanly and exits.
- Minimum interval is **10s**, so a demo can run fast while an accidental `1s`
  can't hammer HN.

## Tools

| tool | params | returns |
|---|---|---|
| `schedule_collection` | `every` (duration string, `30s`…`24h`), `top_n` (1–100, default 30) | the created job; if an identical job already exists, it is returned rather than duplicated |
| `list_jobs` | — | jobs with `every`, `next_run_at`, `last_run_at`, `runs`, `last_error` |
| `cancel_job` | `job_id` | the cancelled job; unknown id → `isError` |
| `get_summary` | `since` (duration `2h` or RFC 3339 time; default `24h`), `limit` (1–20, default 5) | the aggregate below |

`get_summary` is the aggregation. It works from the snapshots inside the window
and compares the first snapshot with the last:

```json
{
  "window": {"from": "…", "to": "…", "snapshots": 12, "failed_runs": 0},
  "stories_tracked": 41,
  "new_entries":  [ {"id", "title", "url", "rank", "score", "comments"} ],   // first seen in window, still on the list
  "risers":       [ {"…", "rank_from": 24, "rank_to": 3} ],
  "fallers_out":  [ {"…", "last_rank": 28} ],                              // on the list at the start, gone by the end
  "top_by_points_gained":  [ {"…", "score_from": 40, "score_to": 310} ],
  "most_discussed":        [ {"…", "comments": 512} ],
  "current_top":  [ … ]                                                     // latest snapshot, first `limit`
}
```

Empty window (no snapshots yet) is not an error: `snapshots: 0` plus a
`note` saying when the next run is due, which the model can pass on.

## The agent

Reuses task 17's DeepSeek client and tool loop (copied into this module,
because each task is its own module).

```
start ─▶ connect (retry with backoff until hnserver is up)
      ─▶ bootstrap turn: "make sure a top-stories collection is scheduled"
            model: list_jobs → (none) → schedule_collection{every: …}
      ─▶ every -every:  digest turn: "summarise HN since <last digest time>"
            model: get_summary{since: …} → writes the digest ─▶ print with timestamp
      ─▶ meanwhile stdin: a typed question is an ad-hoc turn with the same tools
```

- **Every digest is a fresh conversation** (system prompt + one user message).
  A 24/7 process can't keep an ever-growing history. What connects one
  digest to the next is the `since` timestamp, and the data lives on the
  server.
- **Bootstrapping goes through the model**, not a hardcoded call. The agent
  asks for the collection it wants, and the model decides which tools that
  takes. Running a second agent, or restarting this one, finds the existing
  job instead of creating a duplicate, thanks to `schedule_collection`'s
  idempotency.
- **Server down** → the digest prints `server unreachable, retrying` and the
  loop continues. A 24/7 agent must survive a server restart.
- Commands: `/now` (digest immediately), `/jobs`, `/quit`.
- Flags: `-server` (default `http://localhost:8765/mcp`), `-every` (default
  `1h`), `-collect` (interval requested in the bootstrap turn, default `15m`),
  `-model`.

Output is the same style as task 17: a trace of tool calls, then the digest
rendered with glamour.

```
  hnagent · deepseek-flash · hnserver 0.1.0 · 4 tools · digest every 2m

  ⚙ list_jobs {}                       ✓ 3ms · jobs[0]
  ⚙ schedule_collection {"every":"30s"} ✓ 5ms · id=1 every="30s"

  ── digest 14:02 · since 14:00 ───────────────────────────
  ⚙ get_summary {"since":"2026-09-24T14:00:00Z"}  ✓ 9ms · snapshots=4 stories_tracked=33

  **New on the front page:** …
  **Climbing fast:** …
```

## Server output

`hnserver` logs one line per run, so the video shows it working in the
background in its own terminal:

```
14:00:30  job 1 hn_top  ✓ 30 stories · 3 new · 1.4s
14:01:00  job 1 hn_top  ✓ 30 stories · 0 new · 1.2s
```

## Files

```
task18/
  go.mod                         module task18 · go-sdk v1.8.0 · modernc.org/sqlite
  cmd/hnserver/main.go           flags, open DB, start scheduler, HTTP MCP handler, graceful shutdown
  cmd/hnagent/main.go            flags, key, connect/retry, ticker + stdin loop, rendering
  hn/client.go                   HN API: top ids, items (concurrent)
  store/store.go                 schema, jobs CRUD, runs, snapshot insert
  store/summary.go               the aggregation queries
  scheduler/scheduler.go         due-job loop, wake-up, single-flight, shutdown
  tools/tools.go                 In/Out types, schemas, handlers
  agent/…                        DeepSeek client + tool loop (from task 17)
  *_test.go
  README.md
```

## Tests

No network in tests.

- **store**: aggregation against hand-built snapshots. Check new entries,
  risers, stories that fell off, points gained, an empty window, and a window
  that cuts through the history.
- **scheduler**: an injected clock and a fake collector. Check that a due job
  runs, that missed runs collapse into one, that cancel stops the job, that
  adding a job wakes the loop, and that a failing run is recorded and
  rescheduled.
- **hn**: `httptest` fake. Check null and deleted items, a missing `url`, and
  that one failed item doesn't fail the run.
- **tools**: through a real MCP client over in-memory transports. Check
  `every` validation (`5s` rejected, garbage rejected), that
  `schedule_collection` is idempotent, an unknown `cancel_job` id, and
  `since` given as a duration and as a timestamp.
- **HTTP**: one end-to-end test with `httptest.Server` +
  `StreamableClientTransport`, so the real transport is exercised.

## Sequence

1. Module, `hn/client.go` against the live API
2. `store` schema + summary queries + tests
3. `scheduler` + tests
4. Tools + `hnserver` over HTTP; poke it by hand
5. `hnagent`: connect/retry, bootstrap, digest loop, stdin
6. Live demo run (30s collection, 2m digests, server restart mid-run);
   README with the transcript

## Branch

Single branch `task18/hn-scheduler`, one PR (same as tasks 16–17).

## Addendum — what the build changed

- **go-sdk crashes on `"arguments": null`.** v1.8.0 decodes `null` into a nil
  map, then panics writing schema defaults into it, and the panic takes down the
  whole process. For a server meant to run 24/7, a single argument-less
  `get_summary` from any client was enough to kill it. A receiving middleware
  (`nullArgsAsEmpty`) rewrites `null`/absent arguments to `{}` before the SDK
  sees them. The defaults stay in the schemas because the model benefits from
  them.
- **Changes are measured from a baseline.** The baseline is the last snapshot
  *before* the window, or the window's first snapshot if there is none. This
  makes "since the last digest" mean "compared with what the last digest saw".
  A story that entered and left inside the window is reported as
  `came_and_went` rather than disappearing silently.
- **Times are local, with an offset.** The first live run returned UTC, so the
  model wrote "11:27Z" in a terminal showing 21:27. Server and agent share a
  machine, so the tools now return RFC 3339 in the server's zone
  (`21:27:09+10:00`), and the model writes what the clock shows.
- **`/now` restarts the digest schedule.** Otherwise the regular digest that
  followed seconds later covered an empty window. Seen live.
- **A failed digest retries after `min(30s, -every)`** instead of waiting for
  the next slot. With hourly digests, a ten-second server restart would
  otherwise cost an hour. The window still starts at the last digest that
  succeeded, so nothing is skipped.
- **Handshake steps are held back until the handshake succeeds.** When the
  agent starts before the server, each attempt printed two ✗ lines with the
  SDK's full error chain. Now each attempt prints one line with the root cause
  (`connect: connection refused`).
- **No standalone SSE stream.** In scope A the server never pushes, so the
  client sets `DisableStandaloneSSE` and `MaxRetries: -1`. A dead session then
  fails fast on the pre-turn `ping` and is replaced, instead of retrying in the
  background.
- **Over HTTP the SDK negotiates protocol `2025-11-25`** (stdio in task 17 got
  `2026-07-28`). The trace prints whatever was negotiated.
- **The agent names no tool, not even in prompts.** The digest prompt asks for
  "the server's aggregated summary starting exactly at …", and the model finds
  `get_summary` itself. `grep -rn "get_summary\|schedule_collection\|list_jobs\|cancel_job" agent cmd/hnagent`
  matches only tests.
- **`EnsureJob` runs in a transaction.** A separate SELECT and INSERT let two
  agents bootstrapping at the same moment each create "the" job. It was found
  in review, and a test with 8 concurrent callers now covers it.
