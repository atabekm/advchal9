# Task 32 — Automated code review

Every pull request in this repository gets a review from a local model. A GitHub Actions job on
a self-hosted runner (this Mac, next to Ollama) takes the PR's diff, looks up related
documentation and code, and posts one comment with **potential bugs**, **architectural issues**
and **recommendations**. No API keys, and nothing leaves the machine except the comment.

```
 PR opened / pushed to
   │
   ▼  .github/workflows/task32-review.yml          runs-on: [self-hosted, macOS, ollama]
 devreview index --ref origin/main                 docs + code of main, only changed files re-embedded
 devreview review --pr N --post
   │
   ├─ diff      merge-base...head → files, hunks, the definitions each hunk is in
   ├─ context   per file ─┬─ the numbered diff, the file (whole, or the changed definitions)
   │                      ├─ RAG: 3 doc + 3 code passages of main (hybrid search, reranked)
   │                      └─ git grep in the PR's head: call sites of what changed, uses of what
   │                         was removed or renamed, definitions of what the new lines call
   ├─ review    qwen3:8b, one call per file → JSON findings {kind, severity, line, code, title, ...}
   ├─ verify    qwen3:8b again: the findings next to the code, which hold up?
   ├─ checks    lines moved onto the diff or cleared, citations checked, twins merged
   └─ comment   one Markdown comment on the PR, edited in place on every push
```

## Run it

```bash
ollama pull qwen3:8b nomic-embed-text  # the reranker (bge-reranker-base) comes from the HF cache
uv run devreview index                 # ~/.cache/devreview/index.db from main: ~2 min first, seconds after
uv run devreview review                # review HEAD against main, print it
uv run devreview review --pr 30        # a GitHub PR (fetched with gh); --post comments on it
uv run devreview review --patch x.patch  # a patch applied on top of main, as a commit no branch points at
uv run devreview context --pr 30       # what the model would be shown for each file, without the model
uv run devreview eval                  # the seeded PRs of cases.json, scored
uv run pytest                          # 72 tests, no Ollama needed
```

`review` also takes `--output review.md` (the comment), `--json review.json` (everything:
findings, what was rejected and why, context, tokens, timings), `--no-rag`, `--no-verify`,
`--think` and `--model`.

## What the reviewer is shown

Per changed file, in one prompt of at most ~11k tokens (the model has 16k):

1. **The PR**: title, description, commits, the list of changed files.
2. **The diff**, every line numbered with its line in the new file, each hunk headed by the
   definition it is in (`@@ -98,7 +98,7 @@ in Retriever.search`).
3. **The file** after the change: whole up to 12k characters, else the changed definitions.
4. **Plain search in the PR's head** (`git grep -w`, inside the task folder; tasks don't import
   each other):
   - names this change removed or renamed **that are still used** somewhere, with the lines;
   - call sites of the definitions it changed;
   - the definitions of functions the added lines call (`chunk(doc, MIN_CHARS, MAX_CHARS)` comes
     with `def chunk(doc, max_chars=..., min_chars=...)`).
5. **RAG over `main`**: 3 documentation passages (the task's README and PLAN, `docs/`, configs)
   and 3 code passages from the same task, not from the changed files. The query is the path, the
   changed definitions and the added lines; cosine (nomic-embed-text) and BM25 are fused, then
   `bge-reranker-base` picks the best.

The index has both halves: 439 documents, 2,810 chunks. Documentation is task 31's selection,
cut at headings. Code (`*.py`, `*.js`, `*.go`, no tests, no vendored or minified files) is cut at
definitions: Python with `ast` (top-level functions and classes; a long class by method), JS and
Go at top-level declarations. Each code chunk keeps its line range, so a passage reads
`task31/devassist/index.py:33-64 › build`. It is built from a git ref, not the working tree: the
pipeline indexes `main` while the PR's branch is checked out.

## The answer, and what happens to it

The model answers JSON constrained by a schema (Ollama's `format`), so it always parses. Each
finding has a kind (`bug`, `architecture`, `recommendation`), a severity, the line, **the code
on that line, copied**, a title, a detail, and the passages it relies on. Then:

- **Verification.** A second call gets the diff and the file again with the findings numbered,
  and for each one gives a reason and then `real: true/false`. Rejected findings are dropped
  (and kept in the JSON with the reason).
- **Lines are checked**, without the model. A line the diff doesn't show is moved to the line
  whose code matches the quoted code, or to the nearest shown line within 3, or cleared.
- **Citations are checked**: a passage number that doesn't exist is removed.
- **Duplicates are merged**: one finding per line (the most serious kind wins), one per similar title.
- At most 5 findings per file, at most 20 files per PR (the most changed code first, tests last;
  the others are listed as not reviewed). Lockfiles, docs, data and binaries are skipped and
  listed.

The comment links every finding to its line at the reviewed commit, and ends with a collapsed
"what the reviewer looked at" (per file: what changed, which usages and definitions it was shown,
which passages, tokens and seconds).

## Results

`uv run devreview eval`: 11 seeded pull requests ([`cases.json`](cases.json)), each a small edit to
real code of tasks 30 and 31 on `main`, reviewed exactly like a PR. Nine plant one defect; two are
clean changes that should get no bug. A defect is **found** when a finding in that file names the
reason (keywords; bug or architecture, the label matters less than the catch), **located** when a
finding is on its lines with some other reason. Any other bug or architecture finding is
**noise**. qwen3:8b, thinking off, M1 Pro.

| | found | located | noise per PR | clean PRs quiet | time per PR |
| --- | --- | --- | --- | --- | --- |
| **full: RAG + search + verification** | **8/9** | 8/9 | 0.2 | 1/2 | 44 s |
| without the verification call | 8/9 | 9/9 | 0.3 | 0/2 | 30 s |
| without RAG (search still on) | 7/9 | 9/9 | 0.1 | 2/2 | 23 s |

The full run, finding by finding
([`results/eval-20261014T214255.json`](results/eval-20261014T214255.json)):

| case | seeded defect | verdict | the finding | other findings |
| --- | --- | --- | --- | --- |
| off-by-one | returns k - 1 passages instead of k | found | high bug L101: Returning k-1 passages instead of k | — |
| renamed-caller | `mentioned_tasks` renamed, `cli.py` and `assistant.py` still import it | found | high architecture L55: Function renamed but still used in other modules | — |
| slot-leak | the gateway's slot is released only on error; every successful request leaks one | **missed** | — | — |
| swallowed-error | a connection error returns no vectors; the index silently gets fewer embeddings | found | high bug L65: Returning empty list on connection error hides error details | — |
| sql-injection | SQL built with an f-string from a file path | found | high bug L73: SQL injection vulnerability in delete_file | — |
| cross-task-import | imports task 27's code at runtime; the conventions say tasks copy, never share | found | medium architecture L14: Importing task27's embedder may break module isolation | medium bug: … may cause import errors |
| hardcoded-secret | an API key as the default of `API_KEYS` | found | medium bug L59: Default API key may expose a secret in production | — |
| missing-await | `call_tool` not awaited: `res` is a coroutine | found | high bug L50: Removed await may cause async function to hang | — |
| swapped-args | `chunk(doc, max_chars, min_chars)` called as `chunk(doc, MIN_CHARS, MAX_CHARS)` | found | medium bug L52: … passes `MIN_CHARS` as the first argument and `MAX_CHARS` as the second | — |
| clean-message | (a reworded error message) | — | | — |
| clean-property | (a `Gate.free` property) | — | | medium bug: Gate.free returns incorrect value |

Read by hand, the counts flatter the run without RAG. Its keywords match, but three of its reasons
are wrong or vague: renamed-caller is "`tasks_in` is not defined when called" (it is; the old name
is the problem), slot-leak is "returns an error before releasing the slot" (the reverse of the
code), and cross-task-import is "sys.path can cause import conflicts" (true, but not the rule the
repository's conventions state). With RAG, renamed-caller and cross-task-import get the right
reason, citing `cli.py` and the task's README. Without it the reviewer is quieter and twice as
fast, but more often right for the wrong reason.

What the verification call did in the full run: it rejected 2 findings. One was a false bug on a
clean PR ("the error message may be misleading"). The other was the only finding on slot-leak,
"OllamaError is not handled properly", which was vague, and the verifier rejected it for the wrong
reason ("the error is returned within the except block"). It cost 15 s per PR.

### A comment

Two seeded defects in one PR (`renamed-caller` + `swapped-args`), `devreview review --patch`,
the Markdown as it would be posted (the "looked at" part shortened):

> **Automated review**
>
> Commit `5579455` · 2 files reviewed, 0 skipped · `qwen3:8b` on a self-hosted runner · 1m 44s
>
> **Potential bugs (1)**
> - **🟠 medium** `task31/devassist/index.py:52`: **Chunking parameters may be out of sync with constants**
>   The parameters passed to `chunk` are using MIN_CHARS and MAX_CHARS directly, but these
>   constants may have changed. […]
>   <sub>based on: `task31/devassist/chunk.py:1-50 › (module), Chunk`</sub>
>
> **Architectural issues (1)**
> - **🟠 medium** `task31/devassist/retrieve.py:55`: **Function name mismatch with existing usage**
>   The function is now named `tasks_in` but is still being used as `mentioned_tasks` in multiple
>   files. […]
>   <sub>based on: `task31/devassist/cli.py:57-101 › cmd_search, cmd_chat, cmd_ask, cmd_eval`</sub>
>
> <details><summary>What the reviewer looked at</summary> … `task31/devassist/retrieve.py`
> (7680+369 tokens, 55s): changed `tasks_in`, `Retriever.search`; removed `mentioned_tasks`; still
> used after removal: `mentioned_tasks` (6); call sites of … </details>

The rename is caught. The swapped arguments are located but explained wrongly ("out of sync
with constants"), although the same edit reviewed alone got the right reason: a different PR
title and file list are enough to change an 8B model's answer.

## What testing changed

- **"Found" has to mean the right reason.** The first scoring counted any finding near the
  defect's lines, and gave 9/9. Several of those findings were on the right line for the wrong
  reason ("`tasks_in` is used before being defined"). Scoring now asks for the reason, keeps the
  line as "located", and the README's verdicts were checked by reading every finding.
- **One finding per line.** qwen3 restated almost every bug as an "architecture" issue on the
  same line ("Inconsistent with parameterized query usage" next to "SQL injection"), and the rename
  again as a recommendation ("update the references"). A prompt rule ("report each problem once")
  didn't stop it, so the merge does: one finding per line, the most serious kind. Noise per PR
  went from 0.8 to 0.2.
- **A verification call.** On a clean PR, the model reported "`max_concurrent` is not defined" in
  a class whose `__init__` sets it, in a file it had been shown whole. A second call that has to
  give a reason for each finding against the code rejects some of these, though not all (the
  same PR still gets "Gate.free returns incorrect value").
- **Callers and definitions by plain search, not RAG.** "Who still uses the old name" and "what
  does `chunk` take" have exact answers. `git grep` in the PR's head gives them, scoped to the task
  folder, and filtered to calls, attribute access and imports. The bare word matched docstrings
  and local variables (`sources`).
- **Files with only deletions are reviewed.** Removing a `release()` is a change worth reviewing;
  they were skipped at first. A removal is anchored to the line it was removed above.
- **The diff from git, the patch as a commit.** The evaluation's edits become a patch, the patch
  a commit object (`git apply --cached` into a temporary index, `git commit-tree`), so a seeded
  PR is reviewed by the same code path as a real one, without touching the working tree.

## Limits

- **An 8B model's reasons are unstable.** The same edit gets the right reason alone and a wrong
  one next to another file. Findings are suggestions; the comment says so.
- **Logic it has to simulate is missed.** The slot leak needs following `try`/`finally` across a
  streaming and a non-streaming path; none of the three final runs explained it correctly.
- **RAG passages are often generic.** For task 31 the doc passages are mostly its README's
  "Files" and "A session" sections. They help the reasons above, and they also give the model
  something to build an "architecture" finding on.
- **Severity is the model's.** "may cause the async function to hang" is high; a hard-coded
  secret is medium.
- **Search is by name, within a task folder.** A method called through another name, or code
  calling across tasks, isn't found. In this repository tasks don't import each other.
- **Big PRs are slow**: about 45 s per code file, and at most 20 files are reviewed.
- The saved runs predate the last merge rule (a recommendation on a bug's line); it changes only
  the recommendation counts.

## The pipeline

[`.github/workflows/task32-review.yml`](../.github/workflows/task32-review.yml), at the repository
root:

- **Triggers**: `pull_request` (opened, synchronize, reopened, ready_for_review) and a manual
  `workflow_dispatch` with a PR number. Drafts are skipped.
- **Fork guard**: the job runs only if the PR's head is in this repository. The repository is
  public; a fork's PR must never get to run code on the Mac.
- **Concurrency**: one group per PR with `cancel-in-progress`, so a new push cancels the review of
  the previous one.
- **Steps**: checkout of the PR's head with full history; a check that Ollama is up and both
  models are pulled; `devreview index --ref origin/main`; `devreview review --pr N --post`, the
  comment also goes to the job summary, and `review.md`/`review.json` are uploaded as an artifact.
- **Permissions**: `contents: read`, `pull-requests: write`; `gh` uses the job's `GITHUB_TOKEN`.

## The runner

The job needs Ollama, so it runs on a self-hosted runner on the machine that has it. The runner
connects out to GitHub and waits for jobs; nothing has to be opened in the firewall. Jobs queue on
GitHub while the Mac is off and start when it is back.

1. **Register it.** GitHub → the repository → Settings → Actions → Runners → *New self-hosted
   runner* → macOS, ARM64. Run the download commands it shows, then configure with the
   `ollama` label the workflow asks for:

   ```bash
   mkdir ~/actions-runner && cd ~/actions-runner
   curl -o runner.tar.gz -L <the URL from the page>
   tar xzf runner.tar.gz
   ./config.sh --url https://github.com/atabekm/advchal9 --token <TOKEN> \
       --name mac-ollama --labels ollama --unattended
   ```

   The token is on that page, or: `gh api -X POST repos/atabekm/advchal9/actions/runners/registration-token --jq .token`.

2. **Check its PATH.** `config.sh` saves the shell's `PATH` to `.path`, and jobs run with it. It
   must contain the folders of `uv` and `gh` (`/opt/homebrew/bin`) and `ollama`
   (`/usr/local/bin`): `cat .path`. If not, `echo "$PATH" > .path`.

3. **Run it**: `./run.sh` in a terminal, or as a LaunchAgent that starts at login:
   `./svc.sh install && ./svc.sh start`. Either way it runs as you, so it sees Ollama on
   `localhost:11434`, the Hugging Face cache (the reranker) and `~/.cache/devreview/index.db`.

4. **Keep forks out.** The workflow's job runs only when the PR's branch is in this repository
   (`head.repo.full_name == github.repository`); as a second lock, Settings → Actions → General →
   *Approval for running fork pull request workflows* → *Require approval for all external
   contributors*.

To remove it: `./svc.sh stop && ./svc.sh uninstall && ./config.sh remove --token <TOKEN>`.

## Files

- [`devreview/corpus.py`](devreview/corpus.py): what is indexed (docs and code), read from the working tree or a git ref
- [`devreview/chunk.py`](devreview/chunk.py): Markdown/OpenAPI/text chunking (task 31), code chunking at definitions
- [`devreview/embed.py`](devreview/embed.py), [`store.py`](devreview/store.py), [`index.py`](devreview/index.py): embeddings, SQLite, the incremental build
- [`devreview/lexical.py`](devreview/lexical.py), [`rerank.py`](devreview/rerank.py), [`retrieve.py`](devreview/retrieve.py): BM25, the cross-encoder, hybrid retrieval filtered by task, kind and file
- [`devreview/diff.py`](devreview/diff.py): the change (local refs, a GitHub PR, a patch), the unified-diff parser, definitions and what a change touched
- [`devreview/context.py`](devreview/context.py): the numbered diff, the code view, usages, definitions, passages
- [`devreview/llm.py`](devreview/llm.py): Ollama `/api/chat` with a JSON schema
- [`devreview/review.py`](devreview/review.py): the prompts, the per-file call, verification, the checks
- [`devreview/report.py`](devreview/report.py), [`github.py`](devreview/github.py): the comment, and posting it through `gh api`
- [`devreview/evaluate.py`](devreview/evaluate.py), [`cases.json`](cases.json), `results/`: the evaluation
- [`devreview/cli.py`](devreview/cli.py): the commands
- [`tests/`](tests): chunking and the index on a throwaway repository; diff parsing, definitions, usages and patches; the reviewer, the checks, the comment and posting with a scripted model; the evaluation's scoring
