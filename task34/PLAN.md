# Task 34 — Project file assistant: plan

An assistant that works on a project's files: it reads, searches, analyzes and edits them. You give it
a goal ("the README is out of date after the last change, fix it"), not commands. It decides
which files to open, what to search for and what to change.

- **`filemcp`**: a stdio MCP server that sees one project root and nothing else. It has read and
  search tools, git tools, and write tools that go to a **staging overlay** instead of the disk.
- **`fileassist`**: the agent loop on top. A CLI and a one-page web UI. Each run ends with a
  report and a unified diff. `--apply` writes the diff to disk.
- **`fixture/`**: a small fixture project with planted problems, so every run starts from the same
  state and the evaluation is checked by code.
- Local models in Ollama. `qwen3:8b` is the baseline; bigger models are compared in the eval (see
  "Model"). No API keys, nothing leaves the machine.

```
 fileassist run "Update the docs for the last code change"
   │
   ├─ workspace   replay fixture/ into a temp dir as a git repo (fixed dates, authors)
   ├─ MCP         filemcp --root <workspace>
   │
   └─ model loop (≤ N steps)
        list_files / search / outline / read_file / git_log / git_diff     explore
        edit_file / write_file                                             staged, not on disk
        finish(report)
   │
   └─ results/run-…/  transcript.json, report.md, changes.diff   (+ --apply → files on disk)
```

## The fixture project: `fixture/` — "parcel", a shipping cost library

A toy Python package of roughly 10 files that is believable enough for each scenario to have
something real to find:

| file | what it holds |
| --- | --- |
| `parcel/rates.py` | `quote_price(weight_kg, zone, *, express=False)`, the API the whole project uses |
| `parcel/zones.py`, `parcel/config.py` | zone tables; settings from env vars (`PARCEL_*`) |
| `parcel/api.py`, `parcel/cli.py` | an HTTP handler and a CLI, both calling `quote_price` |
| `tests/` | tests that pass, so a fix can be checked by running them |
| `README.md`, `docs/usage.md`, `docs/configuration.md` | the docs, some of them out of date |
| `docs/adr/` | ADR template, `0001-…`, `0002-…`, an index `docs/adr/README.md` |
| `CHANGELOG.md` | Keep a Changelog format, last release `0.3.0` |
| `RULES.md` | the project's rules, written for people (and checked by the assistant) |
| `.env.example` | the documented env vars |

**Git history.** `fixture/history.toml` lists 7 commits. Each one is a directory of full files
(`fixture/01-initial/`, ..., `fixture/07-express/`) copied over the tree. `fileassist/fixture.py`
replays them into a fresh `git init` with fixed authors, dates and config, so the hashes are
identical on every build. There is a tag `v0.3.0` and a few commits after it: a
feature, a fix, a refactor. **The last commit changes the code but not the docs**: it adds
`express` to `quote_price` and a new env var `PARCEL_MAX_WEIGHT_KG`, and renames the CLI flag
`--zone` to `--to`.

**Planted problems:**
- `quote_price` is used in about 7 places: a plain import, an aliased import
  (`from parcel.rates import quote_price as qp`), a module-qualified call (`rates.quote_price`), a
  test, a docs code sample and a string in the CLI help. A plain grep finds some of them, not all.
- The README and `docs/usage.md` still show `--zone` and don't mention `express`.
  `docs/configuration.md` and `.env.example` don't have `PARCEL_MAX_WEIGHT_KG`.
- `RULES.md` has 7 rules, and the final tree breaks them 7 times: `zones.resolve_zone` has no
  docstring; `batch.py` prints; `PARCEL_MAX_WEIGHT_KG` and `PARCEL_API_PREFIX` are read but
  not documented; there's a `TODO` without an issue id in `zones.py`; `parcel.batch` is missing
  from the Modules table; `tests/test_batch.py` doesn't exist. Near misses that are allowed: the
  `print` in `cli.py`, `TODO(#14)` in `rates.py`, the private `_round_money` without a
  docstring, and float weights going *into* `quote_price` (only money must be Decimal).

The ground truth for all of this is kept in `cases.json`, which the model never sees.

## Scenarios

The named scenarios are only preset goals, plain text with no file paths. The free-form
`fileassist run "GOAL"` uses the same loop.

1. **Find usages**: "Where and how is `quote_price` used?" The output is a report of `file:line`
   and kind (definition, import, call, test, docs, string).
2. **Update docs after a code change**: "The docs are out of date after the last commit, bring
   them in line." The model reads `git_log` and `git_diff`, then the docs, then edits them. The
   output is a diff.
3. **Check the rules**: "Check the project against RULES.md." The output is a report of
   violations with `file:line` and the rule. With `--fix`: "...and fix what you can" adds a
   diff, and the fixture's tests must still pass.
4. **Changelog and ADR**:
   - "Update the changelog for the changes since the last release." The model fills the
     `[Unreleased]` section of `CHANGELOG.md` from `git_log`/`git_diff`, sorted into
     Added/Changed/Fixed.
   - "Write an ADR for the decision to …". The model creates `docs/adr/0003-<slug>.md` from the
     template with the next free number and adds it to `docs/adr/README.md`.

## Decisions

- **Writes are staged.** `write_file` and `edit_file` change an in-memory overlay in the server,
  and every later read sees the staged version. The server never writes to the disk by itself.
  `changes_diff` and `apply_changes` belong to the client and are not shown to the model. So a
  run without `--apply` changes nothing, and `--apply` writes exactly the diff that was shown.
- **Edits are replacements, not rewrites.** `edit_file(path, old, new)` requires `old` to match
  exactly once. If it matches zero or several times, it returns an error with nearby lines, and
  after an edit it returns the changed region. `write_file` is for new files only, or for files
  the model has already read in the session. Rewriting a whole file is the classic way a model
  loses half of it.
- **The server is a jail.** Paths are resolved inside the root and `..` and symlinks out of it
  are rejected. It doesn't touch `.git/` and can't delete files. Reads are size-limited and
  paged with `start`/`end`. `search` is a regex with a glob filter and a result cap, and returns
  `file:line: text` with one line of context. `outline(path)` lists the definitions in a Python
  file (via `ast`), and the headings in a Markdown file.
- **Git tools are read-only**: `git_log(since?, path?)`, `git_diff(ref?)` and `git_show(ref)`,
  run inside the root.
- **The loop.** The system prompt names the tools and one rule: search → read → change → verify.
  Read a file before changing it, and re-read the changed region after an edit. Each scenario
  adds a short checklist. The model ends with `finish(report)`. Limits: a step budget (~25 tool
  calls), repeated identical calls are detected and answered "you already did this", and if
  there is no `finish` by the end of the budget, the run stops with the diff so far.
- **Reproducible.** The same fixture build every time, temperature 0 and a fixed seed, and the
  model name and version in every transcript. Each eval case runs 3 times and the pass count is
  reported, because local models still vary from run to run.

## Model

We compare a bigger model against the 8B, staying in one family so that size is the only thing
that changes:

| model | download | why |
| --- | --- | --- |
| `qwen3:8b` | installed | baseline, already used in tasks 31–33 |
| `qwen3:8b-q8_0` | installed | the same model at 8-bit precision. Shows whether precision alone helps, with no download |
| `qwen3:14b` | 9.3 GB | the same family, a bigger dense model |
| `gpt-oss:20b` | ~14 GB | *fallback, only if the 14B still struggles*: a MoE (~3.6B active), a different family, strong at tool calls |

The model is a setting (`--model`, `FILEASSIST_MODEL`). Stage 2 pulls `qwen3:14b` and runs a
quick tool-calling smoke test on all three. Stage 4 runs the full eval and picks the default from
the results.

**After the smoke test (stage 2→3):** the 14B did struggle. With thinking off it misplaced
inserts, and with thinking on it was right on a small goal but took 3–7 minutes per run. On
`update-docs` it covered only one of the four files. So `gpt-oss:20b` was pulled. At reasoning
level `low` it got the small goal right in 45 s and touched all four files in `update-docs` in
about a minute. Level `medium` was ten times slower and no better. It is now the default
(`--think` takes a level for it). The qwen models stay in the eval for comparison, with one pass
each.

## Interface

- **CLI**: `fileassist usages SYMBOL`, `update-docs`, `check [--fix]`, `changelog`,
  `adr "DECISION"`, `run "GOAL"`. Common flags: `--root DIR` (default: a fresh fixture
  workspace), `--model`, `--apply`, `--steps`. It prints each tool call as it happens, then the
  report and the coloured diff. `fileassist fixture DIR` builds the fixture somewhere you can
  look at it.
- **Web**: `fileassist serve`, a FastAPI app with a one-page UI. Pick a scenario or type a goal,
  watch the tool calls stream in (SSE), then see the report and the diff side by side with
  **Apply** / **Discard** buttons. Each run gets its own fresh fixture workspace, and runs go
  one at a time.

## Evaluation: `cases.json`, `fileassist eval`

Each case is a goal plus checks done by code on the result:
- `report_mentions`: the expected `file:line` locations and violations (recall), and nothing that
  isn't there (precision for usages).
- `diff_touches` / `diff_not_touches`: the right files changed and nothing else did.
- `diff_contains` / `diff_lacks`: for example `--to` and `PARCEL_MAX_WEIGHT_KG` appear in the
  docs, and `--zone` is gone.
- `file_exists`: e.g. `docs/adr/0003-*.md`, plus the index updated.
- `tests_pass`: the fixture's pytest suite still passes after the diff is applied (`check --fix`).
- `steps`: tool calls used, plus whether the model read before editing.

About 10 cases cover the 4 scenarios, plus a couple of variants (another symbol, a goal worded
vaguely). Each runs 3× per model. The output is a table of models × cases (passes out of 3,
median steps, time), saved in `results/` and shown in the README.

## Stages

One branch `task34/file-assistant`, a commit per stage, one PR at the end.

1. **Fixture and MCP server**: `fixture/` with `history.toml`, `fixture.py` (deterministic git
   build), `filemcp` with the read, search, outline, git and staged-write tools, the jail and
   the overlay. Tests over a real MCP client in process.
2. **Agent loop and CLI**: Ollama chat client with tool calls, the loop with its limits and
   repeat detection, transcripts, diff output and `--apply`, `fileassist run`. Tests with a
   scripted LLM. Pull the bigger models and run the tool-calling smoke test.
3. **Scenarios**: the preset goals and checklists for usages, update-docs, check/fix, changelog
   and ADR. Tune the prompts on real runs.
4. **Evaluation**: `cases.json`, the checks, `fileassist eval` over the models, pick the default.
5. **Web UI and README**: `fileassist serve` with SSE, diff view and apply/discard. The README
   gets the eval table and real transcripts.
