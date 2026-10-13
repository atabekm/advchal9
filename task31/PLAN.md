# Task 31 — Developer assistant: plan

A terminal assistant that answers questions about **this repository** (`ai-advent-challenge9`, the
whole monorepo of task folders). It knows the project from two sources:

- **RAG over the documentation**: the root `README.md` and `docs/`, every task's `README.md`,
  `PLAN.md` and `COMPARISON.md`, the task specs (`taskNN.txt`) and the "schemas": `pyproject.toml`,
  `go.mod`, compose files, Dockerfiles, and the task 30 gateway's OpenAPI spec.
- **MCP for the live state**: a small MCP server (Python SDK, stdio) with `git_branch`,
  `git_status`, `git_log`, `list_files` and `git_diff`.

Everything runs locally: `qwen3:8b` and `nomic-embed-text` in Ollama, `BAAI/bge-reranker-base`
from the Hugging Face cache.

## Decisions

- **What is indexed.** Not `taskNN/docs/`: those folders are the RAG corpora of tasks 21–29
  (PDFs about other subjects), not documentation of this project. Not `EVAL.md`: generated run
  reports, ~200 KB that would crowd out the prose. Not code: the file tree comes from MCP.
- **Chunking.** Markdown is cut at headings (one chunk per section, long ones packed on
  paragraph boundaries). Every chunk's embedded text starts with `path › heading path`, because
  thirty READMEs share headings like "Setup" and "Results"; without the path they are
  indistinguishable.
- **Scoping by task.** "task 30", "task30/" or "day 30" in a question restricts retrieval to that
  task's files plus the root docs. In a monorepo that is the strongest signal there is.
- **Retrieval.** Cosine top 20 → cross-encoder rerank → best 6. Unchanged files are not
  re-embedded (sha256 per file).
- **Git context is not optional.** Every `/help` fetches `git_branch` and `git_status` through
  MCP and puts them at the top of the prompt, so the branch is always known, whether or not the
  model decides to call a tool.
- **Tool calls on top.** The model may call `list_files`, `git_diff`, `git_log` (Ollama native
  tool calling, at most 3 rounds) for questions the docs can't answer: "what's in task30/gateway?",
  "what changed on this branch?". A failed or malformed call is reported back to the model as an
  error, and after the last round it must answer.

## Stages

1. **Docs and index**: root `README.md` and `docs/`, corpus selection, Markdown chunker,
   embeddings, SQLite store, `devassist index`. Tests for selection and chunking.
2. **MCP server**: `devmcp` with the git/file tools, and the stdio client the assistant uses.
   Tests against a temporary git repo.
3. **The assistant**: retrieval + rerank + git context + tool loop; a REPL with `/help`,
   `/branch`, `/status`, `/files`, `/diff`, `/log`, `/sources`, `/reindex`, `/quit`, and a
   one-shot `devassist ask`.
4. **Evaluation and README**: about 12 questions about structure, conventions and git state;
   retrieval hit rate and answer checks; real transcripts in the README.

## Addendum: what the build changed

- Retrieval is hybrid: cosine top 20 and BM25 top 20, fused by reciprocal rank, then reranked.
  Cosine alone missed the conventions table for "how do I run the browser tasks' tests".
- A directory named in the question is listed through MCP before the model runs, next to the
  git state: qwen3 didn't call `list_files` for "what's in X" on its own.
- `read_file` joined the tools. `git_log`/`git_diff` refuse a path that doesn't exist and say
  how to retry; the prompt tells the model to correct its arguments and call again.
