# Task 7 — Context persistence · plan

Task 6 ends its README on a deliberate line:

> The configuration persists to `localStorage`; the conversation does not.

Task 7 is that sentence, reversed. The brief wants messages stored, reloaded on
restart, and the conversation continued as though nothing happened.

## The idea

Task 6's architecture is three layers with a rule each. Task 7 adds a fourth and
gives it a rule of its own:

```
app.js     the interface   restores on load, replays the chat, shows the seam
                           never serialises anything itself
   |
agent.js   the agent       snapshot() and restore() — the only doors into memory
                           never knows where a snapshot goes
   |
store.js   the store       schema, versions, backends, quota, corruption
                           never knows what a message means
   |
api.js     the transport   unchanged
```

The constraint carried over from task 6 is the load-bearing one: `app.js` still
may not reach into `agent._messages`. Persistence has to go *through* the agent,
not around it, or the encapsulation the previous task spent 400 lines
establishing evaporates the moment we need to write a file.

## What persists, and what pointedly does not

| | survives a restart | why |
| --- | --- | --- |
| messages | **yes** | the brief |
| an interrupted turn | **yes** | closing the tab mid-stream is a real event; losing it silently is a lie |
| session titles, list, last-active | **yes** | otherwise "restore" has nothing to restore *to* |
| provenance (model, persona, transport at the time) | **recorded, not applied** | see below |
| stats — turns, tokens, cost, elapsed | **no** | they measure this run |
| turn counter | **no** | turn numbering belongs to the log, and the log is per-run |
| the debug event log | **no** | unchanged from task 6, and the reason is the next paragraph |

This is the piece's actual position, not an omission. The debug log records what
*this* process did — and after a restart, the first thing this process did was
remember. So the log opens with `agent:new`, then `agent:restored · 14 messages`,
and the stats bar reads `restored · 14 in memory` before a single turn has
happened. The memory is visibly older than the run that is holding it. Persisting
the stats too would have hidden exactly the thing worth showing.

Provenance is the honest middle case. A session records the model, persona and
transport it was held under. On restore that is *shown*, not silently applied — if
you saved a conversation on `deepseek-v4-pro` and reopen it on flash, the panel
says so and leaves the choice to you. Same reasoning as task 6's config tab: the
agent decides what a valid configuration is, and a stored file does not get to
overrule the live one.

## Record format

One localStorage slot per session, `task7.session.<id>`:

```json
{
  "v": 1,
  "id": "a3f9c1",
  "title": "French practice",
  "createdAt": 1757400000000,
  "updatedAt": 1757400931000,
  "provenance": { "model": "deepseek-v4-flash", "name": "Ada",
                  "transport": "deepseek", "systemPrompt": "…" },
  "messages": [ { "role": "user", "content": "…", "at": 1757400000000 } ],
  "pending": { "turn": 5, "text": "…", "startedAt": 1757400930000 }
}
```

`v` exists from day one and is checked on every read. A record from a future
version is refused with a reason rather than half-parsed — a persistence layer
without a version field is a migration bug scheduled for later.

`list()` scans keys by prefix and parses each record rather than keeping a
separate index. An index would be faster and would eventually disagree with the
records it indexes; at this scale the scan cannot drift.

## Stages

Each stage is a branch and a PR, per the usual convention.

### Stage 1 — `stage-1/session-store`

The plumbing, no UI. Verifiable from the console.

- Copy task6 → task7. Rename storage keys `task6.*` → `task7.*` so the two apps
  do not share state (the API key will need re-pasting; note it in the README).
- `store.js`:
  - `localBackend` and `memoryBackend` — the same injection trick as the
    transports, and `memoryBackend` is also the automatic fallback when
    `localStorage` throws (private browsing, storage disabled).
  - `SessionStore`: `list`, `load`, `save`, `remove`, `rename`, `markPending`,
    `clearPending`, `lastActiveId`, `setLastActiveId`, `serialise`, `parse`,
    `usage`.
  - Every read survives absence, corrupt JSON, and an unknown `v`. A corrupt slot
    is skipped from `list()` and reported, never thrown.
  - A quota failure on `save` reports and refuses. It does not free space by
    deleting somebody's conversation.
- `agent.js`: `snapshot()` → `{ messages, config, transport }`, frozen;
  `restore(snapshot)` validates, replaces `_messages`, refuses while busy, emits
  `agent:restored`. Stats and `_turn` are untouched by both.
- Messages gain an `at` timestamp — and `_assemble` must therefore map to bare
  `{ role, content }` on the way to the wire, or the extra field goes out in the
  request body.

### Stage 2 — `stage-2/restore-on-boot`

The brief is satisfied at the end of this stage.

- Boot: load the last-active session, `agent.restore()` it, replay the messages
  into the chat log (assistant turns through `renderMarkdown`; restored replies
  have no reasoning block, because reasoning was never in `_messages` — worth a
  README line).
- Autosave after every `turn:end` that succeeded. A failed turn is still not
  remembered, exactly as in task 6, and now that rule extends to disk.
- A banner marking the seam: *restored 14 messages from 2 hours ago*.
- Fix `syncStats` — task 6 prints `no turns yet` when `turns === 0`, which would
  hide a restored conversation entirely. It needs to read `restored · 14 in
  memory`.
- Hide the empty-state when a restore produced messages.

### Stage 3 — `stage-3/sessions`

- A third tab in the aside: `sessions | config | debug`, with `sessions` active
  on load (task 6 opened on `config`; task 7's subject is this one).
- List with title, message count, relative time. New, resume, rename, delete.
  Titles auto-derive from the first user message and stay editable.
- The current session's title also sits above the chat, click to rename.
- Export writes a real `.json` file through a Blob and `<a download>`; import
  takes a file or a drop onto the list, validates it through the same `parse()`
  as a stored record, and assigns a fresh id on collision.
- Storage usage readout: bytes held, sessions held.
- Provenance mismatch note on restore.
- Switching transport now **keeps** the conversation: rebuild the agent, restore
  the current session into it. Task 6 could not do this and said so; the reason
  it can now is that memory outlives the agent object. Call that out.

### Stage 4 — `stage-4/interrupted-turns`

- `markPending` before a turn goes out, `clearPending` when it ends — including
  when it ends badly. What survives an abrupt close is therefore precisely a turn
  that never finished.
- On boot, a pending record offers *retry* or *discard*: "turn 5 was interrupted —
  you asked '…' and never got an answer."
- Deliberately no `beforeunload` cleanup. Tidying up on the way out would erase
  the only evidence the crash ever happened.

### Stage 5 — `stage-5/readme`

- README in the voice of tasks 4–6: the fourth layer and its rule, the table of
  what does and does not survive and why, the seam, provenance, interrupted
  turns, and the export format.
- End-to-end verification in Chrome on the **echo transport** (no key, no spend):
  three turns → reload → the conversation is there and a follow-up resolves
  against it → close mid-stream → reload → the interrupted turn is offered back.
  Then the same against the live transport once.

## Risks

- **localStorage quota.** ~5MB. A long conversation with several sessions could
  approach it. Handled by reporting rather than silently pruning; the usage
  readout makes it visible before it bites.
- **`crypto.randomUUID` on `file://`.** Should be available (a `file://` origin is
  potentially trustworthy) but needs checking on the actual page, with a
  `Math.random` fallback behind it.
- **Replaying long conversations on boot** rebuilds a lot of DOM at once. Fine at
  demo scale; if it drags, render the last N and expand upward.
- **Scope.** Stages 3 and 4 are the ones that could sprawl. Stage 2 is the brief;
  everything after it is there because persistence is only interesting once you
  can see it.
