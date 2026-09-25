# Task 19 — Composing MCP tools

Three **independent** MCP tools, each on **its own server**, and an agent that
chains them from one request: **search → summarize → save_to_file**. The
tools know nothing about each other. The chain exists only in the client, and
the client checks every handoff.

Go, [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk)
v1.8.0 over **Streamable HTTP**, DeepSeek for both the agent and the
summarizer.

```
                                        ┌─ searchserver :8771 ─┐        ┌───────────────┐
                                        │  search(query)       │──HTTPS▶│ Wikipedia API │
┌────────────┐   Streamable HTTP ×3     └──────────────────────┘        └───────────────┘
│ pipeagent  │────────────────────────▶ ┌─ sumserver :8772 ────┐
│ 3 sessions │                          │  summarize(text)     │──HTTPS▶ DeepSeek
│ 1 tool list│                          └──────────────────────┘
│ + LLM      │                          ┌─ fileserver :8773 ───┐
└─────┬──────┘                          │  save_to_file(…)     │──▶ ./out/
      │ HTTPS                           └──────────────────────┘
      ▼
  DeepSeek ── decides the order and passes each output into the next call
```

[PLAN.md](PLAN.md) has the design and what the build changed.

## Task checklist

| task item | where |
|---|---|
| several MCP tools: search, summarize, saveToFile | `search/`, `summarize/`, `savefile/`, each served by its own binary in `cmd/` |
| first tool gets the data | `search`: full-text search over English Wikipedia, returning each article's title, link and text (lead section or whole article) |
| second processes it | `summarize`: one DeepSeek call over any text, with a check that every link in the summary is in the input |
| third saves the result | `save_to_file`: writes the text byte for byte into `out/`, atomically, and returns its sha256 |
| automatic execution of the chain | one request to `pipeagent`, and the model makes all three calls in order. The agent names no tool; it merges the servers' `tools/list` into one list (`agent/router.go`) |
| correct data transfer between tools | `agent/chain.go` compares every long argument with the earlier outputs (`exact` / `whitespace` / `partial` / `joined` / `none`) and checks the saved file's sha256 against the content sent; `e2e/` runs the three real servers and asserts both |

## Tools

All three return **plain text** as their result, because text is what the
next tool accepts. Metadata goes into `structuredContent`, which the trace
shows but the model never needs to carry.

| tool | server | params | returns |
|---|---|---|---|
| `search` | searchserver | `query`, `limit` (1–10, default 5), `detail` (`intro` \| `full`), `chars` per article (200–5,000, default 2,000) | `# 1. Title`, link and text for each article; `[…]` where cut |
| `summarize` | sumserver | `text` (≤ 60,000 chars), `focus`, `max_words` (50–800, default 200), `format` (`markdown` \| `plain`) | the summary; `ungrounded_links` lists any link that isn't in the input |
| `save_to_file` | fileserver | `filename`, `content`, `overwrite` (default false) | `Saved out/x.md · 967 bytes · sha256 …` |

- **`search`** makes one MediaWiki API request for `intro`, and one more per
  article for `full`. It skips disambiguation pages and drops back matter
  (See also, References, External links…) and empty sections. Section
  headings become Markdown (`## History`). Text that is too long is cut at a
  paragraph or sentence. The result holds **content only**: counts and how
  many articles were cut go to `structuredContent`. When the text also had a
  header line and `(Shortened: …)` notes, the model treated them as metadata
  and left them out when passing the text on. There is no trailing newline,
  for the same reason.
- **`summarize`** tells its model to use only the given text. A link in the
  summary that isn't in the input is listed in `ungrounded_links` and noted at
  the end of the text. The server has its own DeepSeek key. The agent never
  sees which model summarizes.
- **`save_to_file`** accepts only a bare file name ending in `.md`, `.txt` or
  `.json`. Paths, hidden names, `..` and other extensions are rejected, with a
  message saying what is accepted. It never replaces a file unless asked,
  including when two calls race for the same name. It writes to a temp file
  and renames it.

## Checking the handoffs

The tools can't check the handoffs because they don't know about each other.
The client can, because it sees every call's arguments and every result.

Every string argument of 200+ characters is compared with the outputs of the
earlier calls in the same request:

| verdict | meaning |
|---|---|
| `exact` | byte-identical to the output of step N |
| `whitespace` | identical once whitespace is collapsed; the trace says where it first differs |
| `partial` | x of step N's lines present, y lines added; the dropped lines are listed |
| `joined` | lines from several earlier outputs put together, with how many from each step |
| `none` | matches no earlier output: the model wrote it itself |

If a result reports a `sha256` of what it stored, the agent compares it with
the hashes of the arguments it sent (`≡ stored = sent`). So the file on disk
is proven to match the call, and the handoff verdict shows whether the call
matched the summary.

## Run

```bash
go build -o . ./cmd/...        # four binaries
export DEEPSEEK_API_KEY=sk-…   # or a .env file here (sumserver and pipeagent both read it)

./searchserver                 # terminal 1
./sumserver                    # terminal 2
./fileserver                   # terminal 3, writes to ./out
./pipeagent                    # terminal 4, REPL
./pipeagent -q "Find Wikipedia articles about the James Webb Space Telescope, summarize them in about 150 words, and save the summary to jwst.md"
```

| flag | default | |
|---|---|---|
| `searchserver -addr` | `localhost:8771` | |
| `sumserver -addr` / `-model` | `localhost:8772` / `deepseek-flash` | |
| `fileserver -addr` / `-dir` | `localhost:8773` / `out` | |
| `pipeagent -servers` | the three URLs above | comma-separated |
| `pipeagent -q` | | run one request and exit |
| `pipeagent -model` / `-rounds` | `deepseek-flash` / `8` | |
| `pipeagent -raw` / `-plain` | | full arguments and results / raw markdown answer |

REPL commands: `/tools` (every server's tools with their parameters) ·
`/raw` · `/quit`.

Each call's arguments are shortened to keep the call on one line: the data
they carry is printed in full under the call that produced it, and the
handoff line says whether it arrived unchanged. `-raw` shows the full JSON
arguments instead.

**A server that is down** costs its tools, not the run. The agent reports it
and offers the model the tools it has. Before each request it pings every
session, replaces lost ones and tries missing servers again.

## Real runs

Unedited, with `-plain`.

**The full chain.** One request, and the model makes every call in order,
each on a different server. Under each call is the data that tool returned,
in full: the text the model now holds and carries into the next call.

```

  pipeagent · deepseek-flash · 3 MCP servers over Streamable HTTP

  ✓ searchserver  search · http://localhost:8771/mcp · protocol 2025-11-25
  ✓ sumserver     summarize · http://localhost:8772/mcp · protocol 2025-11-25
  ✓ fileserver    save_to_file · http://localhost:8773/mcp · protocol 2025-11-25
  3 tools from 3 servers, offered to the model as one list

  › Find Wikipedia articles about the James Webb Space Telescope, summarize them in about 150 words, and save the summary to jwst.md

  ⚙ 1 search @searchserver {"chars":3000,"detail":"intro","limit":5,"query":"James Webb Space Telescope"}
      ✓ 1.2s · detail="intro" query="James Webb Space Telescope" returned=5 total_matches=1447 truncated…
      │ # 1. James Webb Space Telescope
      │ https://en.wikipedia.org/wiki/James_Webb_Space_Telescope
      │ 
      │ The James Webb Space Telescope (JWST) is a space telescope designed to conduct infrared astronomy.
      │ It is the largest telescope in space, and is equipped with high-resolution and high-sensitivity
      │ instruments, allowing it to view objects too old, distant, or faint for the Hubble Space Telescope.
      │ This enables investigations across many fields of astronomy and cosmology, such as observation of
      │ the first stars and the formation of the first galaxies, and detailed atmospheric characterization
      │ of potentially habitable exoplanets.
      │ Despite Webb's mirror diameter being 2.7 times larger than that of the Hubble Space Telescope, it
      │ produces images of comparable resolution because it observes in the infrared spectrum, which has
      │ longer wavelengths than the Hubble's visible spectrum. The longer the wavelength the telescope is
      │ designed to observe, the larger the information-gathering surface (mirrors in the infrared spectrum
      │ or antenna area in the millimeter and radio ranges) required to achieve the desired resolution.
      │ The Webb was launched on 25 December 2021 on an Ariane 5 rocket from Kourou, French Guiana. In
      │ January 2022, it arrived at its destination, a solar orbit near the Sun–Earth L2 Lagrange point,
      │ about 1.5 million kilometers (930,000 mi) from Earth. The telescope's first image was released to
      │ the public on 11 July 2022.
      │ The U.S. National Aeronautics and Space Administration (NASA) led Webb's design and development and
      │ partnered with two central agencies: the European Space Agency (ESA) and the Canadian Space Agency
      │ (CSA). The NASA Goddard Space Flight Center in Maryland managed telescope development, while the
      │ Space Telescope Science Institute in Baltimore on the Homewood Campus of Johns Hopkins University
      │ operates Webb. The primary contractor for the project was Northrop Grumman.
      │ The telescope is named after James E. Webb, who was the administrator of NASA from 1961 to 1968
      │ during the Mercury, Gemini, and Apollo programs.
      │ Webb's primary mirror consists of 18 hexagonal mirror segments made of gold-plated beryllium, which
      │ together create a 6.5-meter-diameter (21 ft) mirror, compared with Hubble's 2.4 m (7 ft 10 in). This
      │ gives Webb a light-collecting area of about 25 m2 (270 sq ft), about six times that of Hubble.
      │ Unlike Hubble, which observes in the near ultraviolet, visible, and near infrared spectra (0.1–2.5
      │ μm), Webb observes a lower frequency range, from long-wavelength visible light (red) through
      │ mid-infrared (0.6–28.5 μm). The telescope must be kept extremely cold, below 50 K (−223 °C; −370
      │ °F), so that the infrared radiation emitted by the telescope itself does not interfere with the
      │ collected light. Its five-layer sunshield protects it from warming by the Sun, Earth, and Moon.
      │ Initial designs for the telescope, then named the Next Generation Space Telescope, began in 1996.
      │ Two concept studies were commissioned in 1999, for a potential launch in 2007 and a US$1 billion
      │ budget. The program saw enormous cost overruns and delays. […]
      │ 
      │ # 2. James Webb Space Telescope sunshield
      │ https://en.wikipedia.org/wiki/James_Webb_Space_Telescope_sunshield
      │ 
      │ The James Webb Space Telescope (JWST) sunshield is a passive thermal control system deployed
      │ post-launch to shield the telescope and instrumentation from the light and heat of the Sun, Earth,
      │ and Moon. By keeping the telescope and instruments in permanent shadow, it allows them to cool to
      │ their design temperature of 40 kelvins (−233 °C; −388 °F). Its intricate deployment was successfully
      │ completed on January 4, 2022, ten days after launch, when it was more than 0.8 million kilometers
      │ (500,000 mi) away from Earth.
      │ The JWST sunshield is about 21 m × 14 m (69 ft × 46 ft), roughly the size of a tennis court, and is
      │ too big to fit in any existing rocket. Therefore, it was folded up to fit within the fairing of the
      │ launch rocket and was deployed post-launch, unfolding five layers of metal-coated plastic. The first
      │ layer is the largest, and each consecutive layer decreases in size. Each layer is made of a thin (50
      │ microns for the first layer, 25 microns for the others) Kapton membrane coated with aluminum for
      │ reflectivity. The outermost Sun-facing layers have a doped-silicon coating which gives it a purple
      │ color, toughens the shield, and helps it reflect heat. The thickness of the aluminum coating is
      │ approximately 100 nanometers, and the silicon coating is even thinner at approximately 50
      │ nanometers. The sunshield segment includes the layers and its deployment mechanisms, which also
      │ includes the trim flap.
      │ 
      │ # 3. James E. Webb
      │ https://en.wikipedia.org/wiki/James_E._Webb
      │ 
      │ James Edwin Webb (October 7, 1906 – March 27, 1992) was an American government official who served
      │ as Undersecretary of State from 1949 to 1952. He was the second administrator of NASA from February
      │ 14, 1961, to October 7, 1968. Webb led NASA from the beginning of the Kennedy administration through
      │ the end of the Johnson administration, thus overseeing each of the critical first crewed missions
      │ throughout the Mercury and Gemini programs until days before the launch of the first Apollo mission.
      │ He also dealt with the Apollo 1 fire. He helped found the National Academy of Public Administration,
      │ a key locus for governmental reform studies.
      │ In 2002, the Next Generation Space Telescope was renamed the James Webb Space Telescope as a tribute
      │ to Webb.
      │ 
      │ # 4. Timeline of the James Webb Space Telescope
      │ https://en.wikipedia.org/wiki/Timeline_of_the_James_Webb_Space_Telescope
      │ 
      │ The James Webb Space Telescope (JWST) is an international 21st-century space observatory that was
      │ launched on 25 December 2021. It is intended to be the premier observatory of the 2020s, combining
      │ the largest mirror yet on a near-infrared space telescope with a suite of technologically advanced
      │ instruments from around the world.
      │ The telescope is designed to last at least five and a half years (six months calibration plus five
      │ years science operations), but with a goal of ten years. The limiting factor is expected to be fuel
      │ to maintain its halo orbit, of which there is enough for at least ten years.
      │ It was announced in December 2021 that due to the accuracy of the orbital insertion and course
      │ correction burns, the telescope had more fuel available than originally planned and could operate
      │ for "significantly" longer than the original ten year planned life span.
      │ JWST cost approximately $10 billion in its design, construction, and five years of operations (does
      │ not include extended mission funding), as well as international contributions.
      │ 
      │ # 5. Webb's First Deep Field
      │ https://en.wikipedia.org/wiki/Webb%27s_First_Deep_Field
      │ 
      │ Webb's First Deep Field is the first operational image taken by the James Webb Space Telescope
      │ (JWST). The deep-field photograph, which covers a tiny area of sky visible from the Southern
      │ Hemisphere, is centered on SMACS 0723, a galaxy cluster in the constellation of Volans. Thousands of
      │ galaxies are visible in the image, some as old as 13 billion years. It is the highest-resolution
      │ image of the early universe ever taken. Captured by the telescope's Near-Infrared Camera (NIRCam),
      │ the image combined different images taken with multiple filters. The image was revealed to the
      │ public by NASA on 11 July 2022.
  ⚙ 2 summarize @sumserver {"format":"markdown","max_words":150,"text":"# 1. James Webb Space Telescope ht…
      ⇐ text · from step 1 search · exact · 7,306 chars · sha256 72e847c6
      ✓ 6.5s · input_chars=7306 model="deepseek-flash" output_words=134 ungrounded_links[0]
      │ - The James Webb Space Telescope (JWST) is an infrared space telescope launched 25 December 2021;
      │ NASA led with ESA and CSA, and Northrop Grumman was primary contractor. It is named after James E.
      │ Webb, NASA administrator from 1961 to 1968. https://en.wikipedia.org/wiki/James_Webb_Space_Telescope
      │ - Its sunshield is a passive thermal control system, about 21 m × 14 m, with five Kapton layers,
      │ deployed 4 January 2022. https://en.wikipedia.org/wiki/James_Webb_Space_Telescope_sunshield
      │ - James E. Webb served as NASA's second administrator and dealt with the Apollo 1 fire; the
      │ telescope was renamed for him in 2002. https://en.wikipedia.org/wiki/James_E._Webb
      │ - The telescope was designed to last at least five and a half years, with a ten-year goal, and cost
      │ about $10 billion. https://en.wikipedia.org/wiki/Timeline_of_the_James_Webb_Space_Telescope
      │ - Webb's First Deep Field, centered on SMACS 0723, was the first operational image, revealed 11 July
      │ 2022. https://en.wikipedia.org/wiki/Webb%27s_First_Deep_Field
  ⚙ 3 save_to_file @fileserver {"content":"- The James Webb Space Telescope (JWST)… (1,017 chars)","filena…
      ⇐ content · from step 2 summarize · whitespace differs (trailing "\n" added) · 1,017 chars
      ✓ 2ms · bytes=1018 overwritten=false path="out/jwst.md"
      ≡ stored sha256 474edf1a… = content sent
      │ Saved out/jwst.md · 1018 bytes · sha256
      │ 474edf1a5e9ace6abeb869b6f33832cc43d55b2de5ff6ee393f03a9d7aa5c7cb

  chain search → summarize → save_to_file · 2 handoffs: 1 exact, 1 whitespace · stored = sent

  I searched Wikipedia for James Webb Space Telescope articles, found five (the telescope itself, its sunshield, James E. Webb, its timeline, and Webb's First Deep Field), and summarized them in about 150 words. The summary was saved to `out/jwst.md` (1018 bytes, sha256 474edf1a5e9ace6abeb869b6f33832cc43d55b2de5ff6ee393f03a9d7aa5c7cb).

  4 model calls · 14,366 in / 2,313 out tokens · 17.8s
```

The 7,306 characters of article text reached `summarize` byte for byte. The
summary reached the file with one newline added at the end, which the trace
names instead of hiding. The file's hash matches what was sent. (1,017 chars
and 1,018 bytes: `×` is two bytes in UTF-8.)

What the servers logged, each in its own terminal:

```
22:00:41  ✓ summarize {"format":"markdown","max_words":150,"text":"# 1. James Webb Space Telescope https://… (7,306 chars)"} · 6.5s · - The James Webb Space Telescope (JWST) is an infrared space telescop…
22:00:43  ✓ save_to_file {"content":"- The James Webb Space Telescope (JWST)… (1,017 chars)","filename":"jwst.md"} · 1ms · Saved out/jwst.md · 1018 bytes · sha256 474edf1a5e9ace6abeb869b6f3383…
```

**When the model builds the input itself.** Wikipedia has no article on async
Rust, so for this request the model searched five times and put the
`summarize` input together from pieces of four results. The trace shows where
every line came from. The data lines are left out here.

```
  › Find Wikipedia articles about async programming in Rust, summarize them in about 150 words, and save the summary to rust-async.md

  ⚙ 1 search @searchserver {"chars":3000,"limit":5,"query":"async programming in Rust"}
      ✓ 850ms · detail="intro" query="async programming in Rust" returned=5 total_matches=37 truncated=0
  ⚙ 2 search @searchserver {"chars":5000,"detail":"full","limit":1,"query":"Async/await Rust coroutine fut…
      ✓ 1.6s · detail="full" query="Async/await Rust coroutine futures" returned=1 total_matches=4 trunc…
  ⚙ 3 search @searchserver {"chars":5000,"detail":"full","limit":1,"query":"Tokio software Rust asynchrono…
      ✓ 1.6s · detail="full" query="Tokio software Rust asynchronous runtime" returned=1 total_matches=5…
  ⚙ 4 search @searchserver {"chars":5000,"detail":"full","limit":1,"query":"Rust programming language asyn…
      ✓ 890ms · detail="full" returned=0 total_matches=0 truncated=0
  ⚙ 5 search @searchserver {"chars":5000,"detail":"full","limit":1,"query":"Rust (programming language)"}
      ✓ 2.1s · detail="full" query="Rust (programming language)" returned=1 total_matches=2636 truncated…
  ⚙ 6 summarize @sumserver {"focus":"async programming in Rust","format":"markdown","max_words":160,"text"…
      ⇐ text · joined from steps 1 search (1 lines), 2 search (3 lines), 3 search (1 lines), 5 search (1 lines) · 5 added · 2,925 chars
      ✓ 9.7s · input_chars=2925 model="deepseek-flash" output_words=151 ungrounded_links[0]
  ⚙ 7 save_to_file @fileserver {"content":"# Async Programming in Rust A summary o… (1,274 chars)","filena…
      ⇐ content · from step 6 summarize · partial: 2 of 3 lines kept, 3 added · 1,274 chars
      ✓ 6ms · bytes=1274 overwritten=false path="out/rust-async.md"
      ≡ stored sha256 798bdc5f… = content sent

  chain search → search → search → search → search → summarize → save_to_file · 2 handoffs: 1 partial, 1 joined · stored = sent

  I searched Wikipedia and found three relevant articles — **Async/await**, **Rust (programming language)**, and **Tokio (software)** — then summarized them in about 150 words, focused on async in Rust. The summary was saved to `out/rust-async.md` (1274 bytes, sha256 `798bdc5faa581621747bfbdcd8c099fb6ff0ecf8543c212fc4a4d5a7b5a327ca`).

  7 model calls · 33,991 in / 2,093 out tokens · 30.3s
```

**When the text gets long, and one server is down.** With `fileserver` stopped,
the chain ends where the tools end, and the model says what it couldn't do.
Given 5 full articles (about 22,000 characters), the model also passed on its
own excerpt instead of the whole text. The handoff shows how much it dropped:

```
  ✗ http://localhost:8773/mcp unreachable (connect: connection refused) — its tools are missing
  ✓ searchserver  search · http://localhost:8771/mcp · protocol 2025-11-25
  ✓ sumserver     summarize · http://localhost:8772/mcp · protocol 2025-11-25
  2 tools from 2 servers, offered to the model as one list

  › Find Wikipedia articles about the Rosetta Stone, summarize them in about 80 words and save the summary to rosetta.md

  ⚙ 1 search @searchserver {"chars":5000,"detail":"full","limit":5,"query":"Rosetta Stone"}
      ✓ 1.6s · detail="full" query="Rosetta Stone" returned=5 total_matches=2156 truncated=4
  ⚙ 2 summarize @sumserver {"focus":"the artifact, its discovery, deciphermen… (64 chars)","max_words":80,…
      ⇐ text · from step 1 search · partial: 8 of 101 lines kept, 1 added · 6,349 chars
        dropped: # 1. Rosetta Stone
        dropped: https://en.wikipedia.org/wiki/Rosetta_Stone
        dropped: ## Description
        … and 90 more
      ✓ 3.6s · input_chars=6349 model="deepseek-flash" output_words=56 ungrounded_links[0]

  chain search → summarize · 1 handoff: 1 partial

  The summary is ready (~80 words, above), but I have no file-writing tool available in this session — only `search` and `summarize` — so I could not create `rosetta.md`. If you have a filesystem or shell tool you can enable, the text above is what should go into `rosetta.md`.

  3 model calls · 15,485 in / 2,180 out tokens · 16.2s
```

This is the cost of letting the model carry the data: the larger the text, the
more likely it is to be cut on the way. The tools can't prevent that. The
check makes it visible.

## Tests

```bash
go test ./...
```

No network. The fakes are `httptest` servers for the Wikipedia API and DeepSeek.

- **search**: result order, skipped disambiguation and empty pages, `intro`
  in one request and `full` with one more per article, cleaning (headings,
  back matter, empty sections, blank lines), truncation at a paragraph or
  sentence, the User-Agent, API errors, and schema bounds through a real MCP
  client.
- **summarize**: prompt contents, defaults, rejected input never reaching the
  model, an empty reply, and grounding (an invented link is flagged, a copied
  one isn't).
- **savefile**: byte-exact writes (CRLF, emoji, no newline added), the sha256,
  overwrite rules, 13 rejected names with nothing written outside the
  directory, and 8 concurrent writers of the same name, of which exactly one
  succeeds.
- **agent**: each verdict (including `joined` and the dropped lines of
  `partial`), failed calls not counting as sources, the store
  check, the report, where whitespace differs, and the router's merge,
  routing and name collision.
- **e2e**: the three real servers over Streamable HTTP, with a scripted model
  that relays each output. When it relays faithfully, the test expects
  2 × `exact`, `stored = sent`, and the file equal to the summary. When it
  drops half the lines and adds one, it expects 2 × `partial`, caught.

## Layout

```
cmd/searchserver  cmd/sumserver  cmd/fileserver   one tool each
cmd/pipeagent                                     multi-server client, trace, REPL
search/  summarize/  savefile/                    the tools; none imports another
mcpserve/                                         shared server plumbing, no state
llm/                                              DeepSeek client (agent and sumserver)
agent/                                            loop, router, chain check
e2e/                                              whole-pipeline tests
```
