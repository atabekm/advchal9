# Model tier comparison

One prompt, three tiers of model, measured three times each. You read the three
answers and decide what the extra money bought.

An upgrade of [task4](../task4): where that held the model fixed and varied the
temperature, this holds everything fixed and varies the model — from a 4B that
costs $0.03 per million output tokens to a frontier model that costs $2.60.

## Running it

Open `index.html`. That is the whole setup — no server, no build, no
dependencies.

The Hugging Face router sends `access-control-allow-origin: *` and allows the
`authorization` header, so the browser calls it directly from a `file://` page.
Paste a token from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
into the token field; it is kept in `localStorage`, never on disk in this
project.

> The token lives in the browser. That is fine for a local file and is exactly
> why this page must not be hosted anywhere. It also cannot be published as a
> Claude Artifact — those run under a CSP that blocks `fetch` to every external
> host.

You need credits. Free Hugging Face accounts get $0.10 of Inference Providers
credit a month, which is about thirty comparisons; you can buy more without a
subscription once a payment method is on file. A full run at the default
settings costs about a third of a cent.

## The three tiers

| tier | model | provider | $/M in | $/M out |
| ---- | ----- | -------- | ------ | ------- |
| low | `Qwen/Qwen3-4B-Instruct-2507` | nscale | 0.01 | 0.03 |
| mid | `meta-llama/Llama-3.3-70B-Instruct` | novita | 0.14 | 0.40 |
| high | `deepseek-ai/DeepSeek-V4-Pro` | deepinfra | 1.30 | 2.60 |

Three labs, three providers, three size classes, and 87× between the cheapest
and dearest output token. Every dropdown holds the live router catalogue —
just over two hundred model–provider pairs, cheapest first — so any column can
be moved anywhere along that range without touching the code.

The mid rung is not an arbitrary pick. `deepseek-chat`, which tasks 1 through 4
all called, now resolves to `deepseek-v4-flash`, and V4-Pro is its expensive
sibling — so the high column is roughly "what you have been using, but the big
one", and the low column is what you could have been paying instead.

## How it measures

Nine calls per comparison: three models, three runs each, **one at a time**.
They go round-robin — low, mid, high, low, mid, high — rather than three in a
row per model, so a slow thirty seconds on the network is shared out instead of
landing on one column.

Each column reports the **median** of its three runs, with the min–max range
underneath, because a single timing is mostly noise. The small numbered tabs
switch between the runs, and the one marked with a dot is the median — the run
the numbers above actually describe, so the text you read and the figures you
read agree.

Cost comes from the provider when the provider volunteers it. deepinfra returns
an `estimated_cost` in the usage block, so those columns say **reported**;
nscale and novita do not, so those say **computed** and come from the router's
published price list. Where both were available they agreed exactly, which is
why the computed figures are trustworthy.

## Two views of every answer

Models answer in markdown, so each column has two tabs under the run numbers.

**original** is the raw text exactly as the model emitted it — every `**`, `###`
and `>` visible, in monospace. It streams live, token by token.

**formatted** renders that markdown. It is greyed out while a run is still
streaming, because half-arrived markdown renders as garbage — an unclosed fence,
a `**bo` with no partner. The moment a run lands, the column renders itself, so
in normal use you watch raw text arrive and then read a clean document without
clicking anything. Switching runs re-checks: a run still in flight falls back to
raw.

The renderer is `markdown.js`, about a hundred lines and no dependency. It
escapes `&`, `<`, `>`, `"` and `'` before doing anything else and only ever
emits tags it chose itself, so a model that writes `<script>` or an
`onerror=` attribute into its answer gets escaped text, not a tag. Links render
only for `http` and `https`; anything else is left as literal text.

Keep the raw view in mind when you judge — see below.

## Reading the numbers honestly

Five things will mislead you if nobody says them out loud.

**The token counts are not comparable.** Three models, three tokenizers. The
same prompt was 28 tokens to Qwen, 55 to Llama and 24 to DeepSeek. Nothing is
wrong; they simply count differently, and Llama's chat template is wordier.

**tok/s here is end-to-end, not generation speed.** It is completion tokens
divided by the whole request, so it includes queueing and network. The router's
own published figure, shown top-right of each column, measures generation only
— which is why ours always reads lower. The gap between the two is the queue.

**Some providers buffer.** When you see time-to-first-token almost equal to
total time, that provider sent the answer in one lump rather than streaming it.
That column's TTFT is a statement about the backend, not the model.

**Three providers means the backend is in every measurement.** You are not
timing a model, you are timing a model on a particular provider on a particular
afternoon. A slow column might be a slow model or a busy host, and this page
cannot tell you which. That is not really a flaw — nobody buys a model, they
buy a model on a provider — but it does mean the speed column is not a clean
statement about model size.

**The cost comparison prices the answers you actually got**, not equal work. A
model that rambles for 500 tokens costs more than one that answers in 300, and
the ×cheapest multiplier includes that. Which is arguably the number you want.

## Nothing is scored

There are no metrics for quality, no grading and no ranking. Three answers,
side by side, and the judgement is yours.

One more confound, and it is the reason `original` exists. **Formatting is
persuasion.** A model that scaffolds its answer with headings, bold lead-ins and
a summary blockquote reads as more thorough than one that writes four plain
paragraphs, whether or not it is. In the formatted view the most decorated
answer wins the glance; in the raw view every model is flattened to the same
monospace and you are left comparing what they actually said. When two columns
seem close, read them raw.

Worth knowing before you make it: on the run this README was written from, the
4B was the **fastest** column (3.1s median against 8.6s and 8.2s) and wrote the
**longest** answer — 2,346 characters against the frontier model's 1,302. It
also quietly answered a different question than the one asked. The expensive
column was slower, terser, and right. Length, speed and cost all point away
from quality here, which is the entire reason this page shows you the text
instead of a score.

## Layout

- `index.html`, `styles.css` — the page
- `api.js` — router calls, streaming, usage and cost, error handling
- `markdown.js` — the renderer behind the formatted view
- `models.js` — the live catalogue, pricing lookup, the dropdowns
- `app.js` — sequencing, medians, the tabs, what each column reports
