# The first agent

A chat on the left, and on the right the thing it is talking to — every property
that agent holds, and every step it takes. The brief for this one is mostly
architectural: an agent has to be *a distinct entity, not just an API call*, and
the request and response logic has to live inside it. So the interesting part is
not the chat. It is what the right-hand panel proves about the left.

## Running it

Open `index.html`. No server, no build, no dependencies — same as
[task4](../task4) and [task5](../task5).

`api.deepseek.com` reflects the request origin in its CORS headers, so a page
loaded from `file://` (`Origin: null`) is allowed to call it, and it permits the
`authorization` header. Paste a key from
[platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) into
the key field; it is kept in `localStorage` and never written into this project.

> The key lives in the browser. That is fine for a local file and is exactly why
> this page must not be hosted anywhere.

If you have no key, or no credit, switch the transport to **echo** and
everything below still works — see the last section.

## Three layers, and a rule for each

```
app.js     the interface   may call the agent, may read its snapshots
                           never builds a payload, never sees fetch
   |
agent.js   the agent       persona, memory, trimming, retries, bookkeeping
                           never holds the API key
   |
api.js     the transport   provider, wire format, key, HTTP status codes
                           never hears the word "conversation"
```

The transport is handed to the agent in its constructor. The agent never
imports one, which is what makes `echoTransport` a drop-in for
`deepseekTransport` with nothing above it changing.

The agent's whole surface:

```js
agent.config              // frozen snapshot of every constructor property
agent.configure(patch)    // the only way to change one
agent.send(text, opts)    // one turn, start to finish
agent.reset()             // forget the conversation
agent.history, .stats     // frozen views
Agent.schema              // field descriptors the config tab is generated from
```

Mutations only through methods, and everything coming back out is frozen. The
interface can look at the agent as much as it likes and still cannot reach in.

## The config tab

Every row is generated from `Agent.schema`, so a property added to the agent
appears in the panel without `app.js` being edited, and the panel cannot drift
out of step with what the agent actually holds.

Edits go through `configure()`, which validates, clamps and reports back — and
the panel then redraws from *the agent's* snapshot rather than from what you
typed. Type `9` into temperature and watch it snap to `2`. Type a model that
does not exist and nothing changes at all. The reason for the round trip is that
the agent, not the form, decides what a valid configuration is.

Changes apply to the **next** turn. Change the system prompt at turn four and
the request that goes out on turn five carries the new persona, while turns one
to three are still in memory as they were — replies written by a personality
that no longer exists. That is not a bug to hide; open the debug tab and you can
watch it happen.

Three things sit under *not configurable*: the transport, its endpoint, and how
many messages are currently held. The transport is a construction-time
dependency, not a setting, which is why switching it in the top bar builds a
**new agent** and the conversation does not come along. The page says so when it
happens.

The configuration persists to `localStorage`; the conversation does not.

## The debug tab

Every line here was emitted by the agent. Nothing in it is computed by the
interface — if the panel says four messages went out, that is because `send()`
said so on its way out the door.

| event | what it tells you |
| ----- | ----------------- |
| `agent:new` | an agent was constructed, with which transport |
| `configure` | a field changed, from what to what |
| `turn:start` | your text, and how much was in memory before it |
| `memory:trim` | which messages fell off the front, and the arithmetic that decided |
| `request` | the exact JSON body, headers redacted |
| `first-token` | time to first token, and whether it was reasoning or answer |
| `retry` | the status that caused it, the attempt number, the backoff |
| `response` | finish reason, usage, cached tokens, cost, elapsed, and the reply itself |
| `turn:end` | ok or failed, total time, memory after |
| `error` / `aborted` | what failed, and what the chat was told |

Expand `payload` on a `request` row for the messages array exactly as it was
sent. The `Authorization` header shows as `Bearer sk-abc…********`: the agent
has never seen the key — it asks the transport for display headers, and the
transport redacts. Redaction is a property of the layer that owns the secret,
not a courtesy of the layer that prints it.

Filter, copy the log as JSON, clear it. The copy is a complete record — every
request that went out and every answer that came back, including the reasoning. The log is session-only and a
`New conversation` clears the chat and the agent's memory but leaves the log
alone, so you can compare before and after.

## Memory, and the budget that limits it

Each turn assembles `system prompt + as much recent history as fits + your new
message`. History is measured with a crude four-characters-per-token estimate —
it only has to be good enough to budget with, and the real counts come back in
the usage block a moment later and are shown next to it.

When the budget is exceeded the oldest exchanges fall off the front, and the
window is then advanced until it opens on a user message, so the model is never
handed a reply with nothing to reply to. Every drop is logged.

Set **history budget** to `0` and the agent becomes stateless — one system
prompt, one message, no past. Ask a follow-up and it has no idea what you are
talking about. Put the budget back and it does. That switch is the entire
difference between an agent and a loop around an API call, and it is one number
in the panel.

A failed turn is not remembered. If a request 402s, the question is not written
into history, so fixing the key and asking again produces a clean conversation
rather than one with a hole in it.

## What the numbers mean

**Reasoning is shown, not hidden.** `deepseek-v4-flash` streams a scratchpad
before it answers. That text appears dimmed above the reply, and its tokens are
counted separately in the stats bar, because they are billed as output and they
are most of the wait. Time-to-first-token counts the first token of either kind
— reporting only the first *answer* token would quietly hide the thinking.

**Cost is computed, not reported.** DeepSeek does not return a price, so the
figure comes from the
[published rates](https://api-docs.deepseek.com/quick_start/pricing) — cache
hits, cache misses and output priced separately, halved outside peak hours
(01:00–04:00 and 06:00–10:00 UTC, weekdays). It is an estimate of a fraction of
a cent, not an invoice.

**Cached tokens are worth watching.** As a conversation grows, the prefix stops
changing, and DeepSeek starts charging a fraction for it. It is the one number
that gets *better* as memory gets longer.

## The echo transport

Same contract, no network, no key, nothing spent. It replies with a description
of what it was handed: how many messages, how the roles broke down, the opening
of the system prompt, and the sampling settings that would have been used.

It exists for two reasons. It demonstrates that the transport really is
injected — swap it and the agent, the config tab and the debug tab all behave
identically. And because it reports the agent's own request back as prose, it is
the clearest way to watch memory accumulate: ask three questions and read the
message count climb.

## Layout

- `index.html`, `styles.css` — the page
- `api.js` — the transports: DeepSeek over HTTP, and the offline echo
- `agent.js` — the agent, its schema, and everything the interface is not allowed to do
- `app.js` — chat, config tab, debug tab; no payloads, no fetch
- `markdown.js` — the renderer for replies, carried over from task5
