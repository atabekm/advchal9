# Task 32 — Code review automation: plan

A pipeline that reviews every pull request in this repository. When a PR is opened or
updated, a GitHub Actions job takes the diff and the changed files, retrieves related
documentation and code, and asks a local model for a review. The review goes back to the PR as a
comment with three sections: **potential bugs**, **architectural issues**, **recommendations**.

Everything that thinks runs on this machine: the job runs on a **self-hosted runner** on the Mac,
next to Ollama (`qwen3:8b`, `nomic-embed-text`) and the `bge-reranker-base` cross-encoder from the
Hugging Face cache. GitHub sees only what it already has, the PR and the comment.

```
 PR opened / synchronize / reopened
   │
   ▼  .github/workflows/task32-review.yml   runs-on: [self-hosted, macOS, ollama]
 checkout (full history) ─▶ devreview review --pr N --post
   │
   ├─ diff        git diff base...head → files, hunks, changed functions
   ├─ index       docs + code of main, incremental (only changed files re-embedded)
   ├─ context     per file: RAG over docs and code (hybrid + rerank)
   │              + the definitions and call sites of the changed symbols (grep, no model)
   ├─ review      qwen3:8b per file → JSON findings {kind, file, line, title, detail, source}
   │              findings checked against the diff, duplicates merged
   └─ comment     one Markdown comment, edited in place on every push
```

## Decisions

- **Self-hosted runner, guarded.** The repository is public, and a self-hosted runner executes
  whatever a workflow tells it to. The job runs only when the PR's head is in this repository
  (`github.event.pull_request.head.repo.full_name == github.repository`), so a fork's PR never
  reaches the Mac. "Require approval for all outside collaborators" stays on as a second lock.
  The runner gets a custom label `ollama`, so no other workflow lands on it by accident.
- **The CLI is the pipeline; the Action is a wrapper.** `devreview review` works the same from the
  terminal (`--base main`, `--pr N`, or `--diff file.patch`) and in the job. Tests and the
  evaluation never need GitHub. Posting is a separate flag (`--post`), done with `gh` and the
  job's `GITHUB_TOKEN` (`pull-requests: write`).
- **Code joins the index.** Task 31 indexed only documentation. Here code is the subject, so the
  index has both:
  - docs: task 31's corpus (root README, `docs/`, task READMEs/PLANs/briefs, configs, the OpenAPI
    spec, SQL schemas), chunked by Markdown heading;
  - code: `*.py` chunked by top-level function/class with Python's `ast` (methods stay inside
    their class unless the class is long), module docstring and imports as a header chunk;
    `*.js`/`*.go` packed on blank lines. Every chunk is labelled `path › symbol`.
  Tests and generated files are left out, as in task 31.
- **Context is main, subject is the diff.** The index is built from the base branch, so the
  reviewer compares the change against how the code is today, and a PR can't plant "docs" that
  justify itself. The changed files themselves go into the prompt whole (from the head) when they
  fit, otherwise the changed functions plus the hunks.
- **Two kinds of retrieval.** RAG answers "what do the docs and similar code say": the query is
  the file's path, the changed symbols' names and the hunk text, scoped to the PR's task folder
  plus the root docs (task 31's scoping), cosine + BM25 fused, reranked, best 6. Plain search
  answers "who depends on this": for every changed or removed function, its call sites in the
  repo (`git grep -w`). A renamed function with callers left behind is the kind of bug a model
  only sees if it is shown the callers.
- **One model call per file, then a merge.** An 8B model with a 16k context can't take a whole PR
  with its context. Each changed file gets its own call with its hunks, its context and a short
  PR summary (title, description, list of all changed files), so cross-file issues are still
  visible. Files that aren't code (lockfiles, generated results, binaries) are skipped and listed
  as such. Very small files may be batched together.
- **Structured output, checked.** The model answers JSON through Ollama's `format` (a JSON
  schema): a list of findings with `kind` (`bug` / `architecture` / `recommendation`), `file`,
  `line`, `severity`, `title`, `detail`, and the `[n]` of the context passage it relies on, if
  any. Then, without the model:
  - a finding for a file that isn't in the diff is dropped;
  - a `line` outside the changed hunks is moved to the nearest hunk, or cleared;
  - a citation that points at no passage is removed;
  - findings with the same file, line and kind are merged.
- **One comment, kept current.** The comment starts with a hidden marker
  (`<!-- devreview -->`). A new push edits that comment instead of adding another, and its header
  says which commit was reviewed. Inline line comments are out of scope: an 8B model's line
  numbers aren't reliable enough to pin on code.
- **Triggers.** `pull_request` (opened, synchronize, reopened, ready_for_review), drafts skipped,
  `concurrency` per PR with cancel-in-progress (only the latest push is reviewed), and a manual
  `workflow_dispatch` with a PR number for re-runs. All PRs in the repo are reviewed, not only
  `task32/**`: the reviewer is for the whole monorepo.

## Stages

1. **Index of docs and code.** Copy task 31's corpus, chunking, embeddings, store, BM25, reranker
   and retrieval into `devreview/` (tasks stay self-contained). Add the code corpus and the `ast`
   chunker; `devreview index [--ref main]` builds or updates `~/.cache/devreview/index.db`
   (outside the checkout, so it survives between jobs). Tests: code selection, chunk boundaries
   and labels, incremental update.
2. **Diff and context.** Diff from `git diff base...head`, from `gh pr diff N`, or from a patch
   file; parse into files and hunks; map changed lines to the enclosing function/class; skip
   non-code files; call sites with `git grep`; per-file context assembly within a token budget.
   Tests on hand-written patches and a throwaway git repo.
3. **The reviewer.** The prompt, the JSON schema, per-file calls, the checks above, the Markdown
   report; `devreview review` printing the report, and `--post` creating or editing the comment.
   Tests with a scripted LLM: invalid file/line/citation handling, merging, the comment marker.
4. **The pipeline.** `.github/workflows/task32-review.yml` at the repository root; runner setup
   documented step by step (download, `config.sh` with the `ollama` label, run as a service, the
   `PATH` the service needs to find `uv`, `ollama` and `gh`); the fork guard and concurrency. A
   real PR in this repository reviewed end to end.
5. **Evaluation and README.** About 8 seeded PRs as patch files against the current code, each
   with a known defect: an off-by-one, a renamed function with a caller left behind, a missing
   `await`/close, an exception swallowed, a SQL string built from user input, a layering
   violation (the MCP server importing the assistant), a hard-coded secret, plus one clean
   change that should produce no bugs. Measured: was the defect found (right file, right kind,
   within a few lines), false findings per PR, time per PR. Results and a real PR comment in the
   README.

Branch `task32/code-review`, one commit per stage, one PR at the end — which will also be the
pipeline's first real review.

## Open questions

- **Index on the runner.** Building it from scratch costs about 20 s for docs in task 31; with
  code it will be more. Kept in `~/.cache` and updated incrementally, so a job pays only for the
  files `main` changed since the last run.
- **Model.** `qwen3:8b` with thinking off, as in task 31. If reviews are too shallow, try thinking
  on for the per-file calls and compare in the evaluation; time per PR is the cost.

## Addendum: what the build changed

- **A verification call** after the review call: the model gets its findings next to the code and
  rejects the ones that don't hold up. It removed a false bug on a clean PR, at 15 s per PR.
- **One finding per line.** qwen3 restates a bug as an architecture issue and a recommendation on
  the same line, despite the prompt; the merge keeps the most serious kind.
- **Files with only deletions are reviewed**, the removal anchored to the line it was removed above.
- **Usages are calls, attribute access and imports**, not every occurrence of the word.
- **The evaluation scores the reason, not the line.** A finding on the defect's line with another
  reason only "located" it. The patches are generated from find/replace edits in `cases.json`, so
  they never go stale against `main`. Runs without RAG and without verification are the ablations.
- The first real PR of the pipeline is this task's own PR.

