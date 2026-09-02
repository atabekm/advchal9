# DeepSeek CLI — controlled responses

Task 1 asked DeepSeek a question. Task 2 asks **the same question** while
tightening three controls over the answer:

| Control | Stated in the prompt | Enforced by the API |
| --- | --- | --- |
| Response format | a described skeleton (bullets / json / table) | `response_format={"type":"json_object"}` (json only) |
| Response length | "Hard limit: 60 words" | `max_tokens` |
| Stop condition | "output `<END>` on its own line" | `stop=["<END>"]` |

There are no presets and no control levels. **Pass no flags and the request is
exactly task 1's**; every flag you pass is sent, and nothing else is. The
command line is the complete description of what the API receives.

That makes the two columns above independently demonstrable, which is the
interesting part — see [Instruction vs. parameter](#instruction-vs-parameter).

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env    # then paste your key into .env
```

Get a key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).

## Usage

Unconstrained — the task 1 request:

```bash
python main.py "Explain how DNS resolution works"
```

All three controls, each stated in the prompt and enforced by a parameter:

```bash
python main.py --format bullets --max-words 60 --max-tokens 150 --stop '<END>' \
  "Explain how DNS resolution works"
```

The headline command — the same prompt run both ways, with a table:

```bash
python main.py --compare --format bullets --max-words 60 --max-tokens 150 \
  --stop '<END>' "Explain how DNS resolution works"
```

`--compare` needs at least one control; it errors rather than inventing a
default set, since a built-in "strict" bundle is exactly the hidden magic this
CLI is trying not to have.

One knob at a time, to isolate a single control:

```bash
python main.py --max-words 60      "Explain how DNS resolution works"   # instruction only
python main.py --max-tokens 40     "Explain how DNS resolution works"   # parameter only
python main.py --format json       "Explain how DNS resolution works"
python main.py --stop "4." --max-tokens 300 "List five stages of DNS resolution."
```

Interactive chat, with whatever controls you launched it with:

```
$ python main.py --max-words 30
You> /controls
  length: 30 words (instruction)
You> Name three primary colors
AI > Red, blue, yellow—the traditional subtractive primaries.
You> /exit
```

Controls are fixed for the session; `/controls` prints the active set,
`/reset` clears history, `/exit` (or Ctrl-C) quits.

## Observed results

Real runs, `deepseek-chat`, prompt `"Explain how DNS resolution works"`:

```
────── comparison ────────────────────────────────────────────────
  run       tokens   words   chars    finish
  without     1214     808    5007      stop
  with         116      86     503      stop
```

1214 tokens of headed, sectioned prose becomes five bullet lines — a 10×
reduction — and `finish=stop` on both rows means the short answer is a
*complete* one, not a truncated one. `max_tokens=150` never fired: the 60-word
instruction landed the answer at 86 words on its own, with the parameter
sitting above it as an unused ceiling, which is where a ceiling belongs.

## Instruction vs. parameter

Because the flags are independent, each half of a control can be run on its
own. Same prompt, same model, one flag each:

`--max-words 60` — an instruction, nothing enforced:

```
DNS resolution translates domain names to IP addresses. Your device queries a
recursive resolver, which checks its cache. If absent, it queries root, TLD,
then authoritative servers, returning the IP.
39 tokens | 30 words | finish=stop
```

`--max-tokens 40` — a parameter, nothing shaping the answer:

```
When you type a website name like `www.wikipedia
40 tokens | 29 words | finish=length
```

That is the whole trade in two runs. The instruction produced a short,
*complete* answer but guarantees nothing — the model could have ignored it and
returned an essay, and the API would have billed for it. The parameter
guarantees the budget absolutely and cuts mid-word to honour it.

So they are not alternatives to pick between; they are two halves of one
control. Set the instruction to shape the answer, and the parameter above it as
a ceiling that only fires when something has gone wrong.

## Seeing the stop condition fire

`finish_reason` is `stop` whether the model ended on its own or the `stop`
sequence cut it, so to watch the sequence actually work, point it at something
the model is certain to write:

```bash
python main.py --stop "4." --max-tokens 300 \
  "List five stages of DNS resolution as a numbered list, one short line each."
```

```
1. User types a domain name into a browser.
2. The operating system checks its local DNS cache for a matching IP address.
3. If not cached, a recursive DNS resolver is queried (typically via the ISP).
51 tokens | 37 words | finish=stop
```

Five stages were asked for; the response ends at three, and the `4.` that
triggered the stop is excluded from the text. The server stopped generating
there — nothing after it was produced, or billed.

## Reading the metrics line

| Field | Meaning |
| --- | --- |
| `finish=stop` | the response ended on its own terms — the model finished, or a `stop` sequence matched |
| `finish=length` | `max_tokens` cut it off mid-thought |
| `tokens` | billed completion tokens, the number the controls are really there to bound |

## API constraints worth knowing

- DeepSeek rejects `response_format={"type":"json_object"}` unless the word
  "json" appears in the messages — the json format description spells it in
  lower case for exactly that reason.
- JSON mode forbids any text outside the object, so a trailing `<END>` would
  make the response invalid. `--format json` drops any `--stop` marker
  automatically.
- That leaves `max_tokens` as the only length control safe to combine with
  JSON, and it is a blunt one: a response cut at `finish=length` is *truncated
  JSON*, which no longer parses. Give `--format json` a generous budget, or
  none at all.
- `json_object` guarantees the response is valid JSON, not that it matches the
  shape described in the prompt. The keys are the model complying with an
  instruction, and nothing in the code validates them.

## When format control becomes content control

A schema is never purely presentational. An earlier version of the json shape
carried a `confidence: "low" | "medium" | "high"` field, and with
`--format json --max-words 30` a request for a lasagne recipe came back as:

```json
{"summary": "No lasagne recipe available; I only output JSON per config.",
 "points": ["JSON only", "No recipes", "Respect config"], "confidence": "high"}
```

Perfectly schema-compliant, and a refusal. The format instruction outranked the
question. Three things caused it:

1. **`confidence` implies a role.** It casts the assistant as something that
   rates its claims, so a recipe reads as out-of-scope rather than as content
   to be reshaped.
2. **`summary` + `points` presumes an explanation.** A recipe is ingredients
   and ordered steps; a schema mismatch is one plausible token away from "I
   can't do that."
3. **`--max-words 30` made the task look impossible**, and declaring it so is a
   reasonable-looking completion.

It was intermittent — the same command usually returned the recipe — which is
what makes it worth writing down: a control that fails one run in ten is harder
to catch than one that never works.

The fix was to drop `confidence` for a structural `detail: "brief" | "full"`,
and to state the scope outright: *"This describes the output format only.
Answer the question fully within it."* The schema now bends to content that
does not fit it — asked for a haiku, it puts the three lines in `points` rather
than declining.

The general lesson holds beyond this schema: **field names are instructions
too.** Every control tightened here narrows what the model believes it is for,
and format is the control where that happens most invisibly.

Also note `deepseek-reasoner` ignores several of these parameters, so the
controls are best demonstrated on the default `deepseek-chat`.

## Everything streams, including `--compare`

Every response prints as it arrives, and the metrics line follows it — there is
no flag to turn streaming off, because there is no reason to. DeepSeek puts the
`usage` block and `finish_reason` in the **final chunk of a streamed
response**, without needing `stream_options: {"include_usage": true}`:

```
stream_options={'include_usage': True}: chunks=233 with_usage=1 finish_reasons=['stop']
stream_options=None:                    chunks=200 with_usage=1 finish_reasons=['stop']
```

So a streamed run reports exactly what a buffered one does. `--compare`
streams both of its runs, which matters most there: the unconstrained answer
is often 900-1400 tokens, and buffering it meant 15-25 seconds of blank screen
before anything appeared. Streaming also makes the *time* difference between
the two runs visible, which the token counts alone do not show.

## Layout

- `main.py` — CLI: flags, `--compare`, chat loop, output
- `controls.py` — format catalog, prompt/parameter assembly
- `deepseek_client.py` — HTTP calls, error handling, response metrics

`controls.py` holds the whole difference from task 1 in one place: the system
prompt the flags build, and the request parameters they send. Everything is
`None` until you ask for it.

## Changes from task 1

- `deepseek_client.py` — `_post` forwards `max_tokens`, `stop` and
  `response_format`; `ask_full()` and the new `Stream` class both return a
  `Reply` carrying `finish_reason`, token usage and elapsed time.
- `main.py` — the control flags, `--compare`, the metrics line, `/controls` in
  chat.
- `controls.py` — new.
