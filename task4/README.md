# Temperature comparison

One prompt, four temperatures, side by side. You read the three answers and
decide which setting suited the task.

An upgrade of [task1](../task1): where that asked DeepSeek one question and
printed one answer, this asks the same question four ways at once.

## Running it

Open `index.html`. That is the whole setup — no server, no build, no
dependencies.

DeepSeek sends CORS headers and reflects the origin, including the `null`
origin of a `file://` page, so the browser calls the API directly. Paste a key
from [platform.deepseek.com](https://platform.deepseek.com/api_keys) into the
key field; it is kept in `localStorage`, never on disk in this project.

> The key lives in the browser. That is fine for a local file and is exactly
> why this page must not be hosted anywhere. It also cannot be published as a
> Claude Artifact — those run under a CSP that blocks `fetch` to every external
> host, so the page could never reach the API.

## Using it

Type a prompt, press **Run** (or Cmd/Ctrl-Enter). The same prompt goes to all
four columns at once, each at its own temperature, and each column streams its
answer as it arrives — so you are never waiting on the slowest to see the
first. Each column reports its token count and elapsed time when it lands.

The temperature fields start at **0**, **0.7**, **1.2** and **1.5**, and are
editable. DeepSeek accepts anything from 0 to 2, and publishes its own
recommendations per use case: `0.0` for coding and maths, `1.0` for data
analysis, `1.3` for conversation, `1.5` for creative writing — which is why the
fourth column starts there, above the range the other three cover.

Nothing is scored. There are no metrics, no grading and no ranking — the
comparison is yours to make by reading.

One thing worth knowing while you read: **temperature 0 is not deterministic.**
Greedy decoding is deterministic in principle, but the serving stack around it
is not, so running the same prompt at 0 twice can give you two different
answers. If a column surprises you, run it again before concluding anything.

## Layout

- `index.html`, `styles.css` — the page
- `api.js` — DeepSeek calls, streaming, error handling
- `app.js` — reads the temperatures, fires one call per column, fills them as they stream
