# The agent that remembers

[Task 6](../task6) ends its README on a line that was deliberately left standing:

> The configuration persists to `localStorage`; the conversation does not.

This is that sentence reversed. Close the tab mid-thought, open the page again,
and the conversation is where you left it — including, if you closed it at the
wrong moment, the question you never got an answer to.

## Running it

Open `index.html`. No server, no build, no dependencies — same as
[task4](../task4), [task5](../task5) and [task6](../task6).

The storage keys are namespaced `task7.*`, so this page shares nothing with
task 6 and you will need to paste a DeepSeek key again. If you have no key,
switch the transport to **echo** and every claim below still holds.

> Conversations are stored in `localStorage`, unencrypted, in whatever browser
> profile you opened the file in. That is fine for a local file and is exactly
> why this page must not be hosted anywhere.

## A fourth layer, and a rule for it

```
app.js     the interface   restores on load, replays the chat, shows the seam
                           never serialises a conversation itself
   |
agent.js   the agent       snapshot() and restore() — the only doors into memory
                           never knows where a snapshot goes
   |
store.js   the store       schema, versions, backends, quota, corruption
                           never knows what a message means
   |
api.js     the transport   unchanged from task 6
```

The load-bearing constraint is the one carried over: `app.js` still may not
reach into `agent._messages`. It was easy to honour when memory only had to
survive a click. The moment memory has to survive a *process*, the shortcut
becomes tempting — read the array, `JSON.stringify` it, done — and taking it
would quietly undo everything task 6 established. So the agent grew two doors
instead:

```js
agent.snapshot()          // { messages, config, transport }, frozen
agent.restore(snapshot)   // validates, replaces memory, refuses mid-turn
```

`store.js` on the other side has never seen a message. It handles records,
bytes, versions and things that have gone wrong, and it would behave identically
if the contents were recipes.

One detail that only shows up once messages are persisted: they now carry an
`at` stamp, so a restored conversation can tell you when it was said. That stamp
is the store's business and nobody else's, so `_assemble` maps down to bare
`{ role, content }` on the way to the wire. A field the API never asked for has
no business in the request body — open the debug tab and check.

## What survives, and what pointedly does not

| | survives a restart | why |
| --- | --- | --- |
| messages | **yes** | the brief |
| an interrupted turn | **yes** | closing the tab mid-stream is a real event |
| session titles, the list, which was last open | **yes** | otherwise a restore has nothing to restore *to* |
| provenance — model, persona, transport at the time | **recorded, not applied** | below |
| stats — turns, tokens, cost, elapsed | **no** | they measure this run |
| the turn counter | **no** | turn numbering belongs to the log |
| the debug event log | **no** | unchanged from task 6 |

The last three are the position this piece actually takes, not a corner that was
cut. The debug log records what *this* process did — and after a restart, the
first thing this process did was remember. So reopening a conversation looks
like this:

```
14:22:07  —   agent:new        Ada on deepseek-v4-flash · transport deepseek
14:22:07  —   agent:restored   6 messages back in memory · saved 2 hours ago
```

and the stats bar reads `restored · 6 messages in memory · no turns this run`
rather than the `2 turns · $0.0004` it read before you closed the tab. The
memory is visibly older than the run holding it. Persisting the counters too
would have produced a tidier-looking panel that hid the only interesting thing
about it.

Ask a follow-up and the seam closes: `turn:start` reports `t1 · 6 in memory`,
the request goes out with seven messages, and the model answers as though
nothing happened. That gap between `t1` and `6 in memory` is the whole task.

## Provenance, and why it is not applied

A session records the model, name, system prompt and transport it was held
under. On restore that is *shown*, never silently imposed:

> Restored 12 messages from 3 hours ago. This conversation was held under a
> different agent — model was deepseek-v4-pro, now deepseek-v4-flash. Nothing
> was changed for you.

Same reasoning as task 6's config tab, where edits round-trip through
`configure()` because the agent decides what a valid configuration is. A file on
disk does not get to reconfigure a live agent just by being opened. You are told
what changed and left holding the decision.

## Interrupted turns

A pending marker is written **before** the request goes out and cleared when the
turn ends — however it ends, including badly. What survives an abrupt close is
therefore exactly a turn that never finished, and reopening the page offers it
back:

> Turn 4 was interrupted 6 minutes ago — you asked *“so what would that cost at
> scale?”* and never got an answer.   `Ask it again`  `Discard`

There is deliberately no `beforeunload` cleanup. Tidying up on the way out would
erase the only evidence that the crash happened, which is the opposite of what a
crash marker is for.

A turn that *failed* — a 402, a network drop, a Stop — is not pending and is not
remembered. Task 6's rule was that a failed question never enters history; that
rule now extends to disk, and if the failure was the very first turn the empty
session is removed again rather than left as a stub.

## The sessions tab

Conversations are a list, not a single slot. New, resume, rename, delete; the
current one is marked, and one that has not had a turn yet says so instead of
pretending to be saved.

Which means `New conversation` finally means what it says. In task 6 it
destroyed the only conversation there was. Here it starts another one and leaves
the previous where it is.

**Export** writes a real `.json` file. **Import** takes one back — dropped onto
the list or picked from a dialog — through exactly the same `parse()` a stored
record goes through, so a hand-edited file is held to the same standard as one
the app wrote. An imported record keeps its content and loses its identity: it
is given a fresh id if the slot is taken, so importing can never overwrite.

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
  "pending": null
}
```

`v` is checked on every read and exists from day one. A persistence layer
without a version field is a migration bug that has been scheduled rather than
avoided; a record from a future version is refused with a reason rather than
half-parsed into something plausible.

`list()` scans keys by prefix and parses each record rather than keeping a
separate index. An index would be faster and would eventually disagree with the
records it indexes. A scan cannot drift.

## What happens when storage misbehaves

Three failures are worth more than the happy path, because they are the ones
that decide whether you can trust the thing.

**A slot that will not parse** is skipped, listed in the sessions tab with the
reason it was rejected, and offered a `Remove` button. The other conversations
open normally. It is announced in the debug log once, not once per repaint — the
log records what happened, not how often the panel was redrawn.

**Storage full** is reported and the save is refused. Nothing is deleted to make
room. Freeing space automatically would mean choosing somebody's conversation to
destroy on their behalf, so the panel shows the bytes held and you choose.

**No `localStorage` at all** — private mode, storage disabled — falls back to an
in-memory backend, and the page says plainly that nothing will survive a reload.
Everything else keeps working. That fallback is the same seam the transports
use: the store takes its backend as an argument and has no opinion about which
one it got. `backend` in the storage readout tells you which one is live.

## Switching transport now carries the conversation

Task 6 rebuilt the agent when you changed transport and lost the chat, and said
so on screen. It had to: memory lived and died with the agent object.

It no longer does. A new agent is still constructed — the transport is a
construction-time dependency, not a setting, and that has not changed — but the
conversation is handed to it on the way in. The same three sentences of
architecture, one of which stopped being a limitation the moment memory moved
out of the object.

## Layout

- `index.html`, `styles.css` — the page
- `api.js` — the transports, unchanged from task 6
- `store.js` — backends, the record schema, versioning, quota, corruption
- `agent.js` — the agent, plus the two doors into its memory
- `app.js` — chat, sessions, config, debug; no payloads, no fetch, and not one
  line that turns a conversation into text
- `markdown.js` — the renderer for replies, carried over from task 5
