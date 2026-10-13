# Task 31 — Developer assistant

A terminal assistant that answers questions about **this repository**, the whole
`ai-advent-challenge9` monorepo. It knows the project from two sources:

- **RAG over the documentation**: the root `README.md` and `docs/` (written for this task), every
  task's README, PLAN and brief, the dependency/config files, an OpenAPI spec of the task 30
  gateway, and the SQL schemas found in the code;
- **MCP for the live state**: `devmcp`, a stdio MCP server with `git_branch`, `git_status`,
  `git_log`, `git_diff`, `list_files` and `read_file`.

`/help QUESTION` puts both in front of `qwen3:8b` (Ollama, local) and returns a cited answer. No
API keys, nothing leaves the machine.

```
 /help QUESTION
   │
   ├─ MCP  git_branch, git_status ─────────────────────────────┐  always
   ├─ MCP  list_files(path) for a directory the question names ┤  when it names one
   ├─ RAG  scope by task → cosine + BM25 → rerank → 6 passages ┤
   │                                                           ▼
   └─ qwen3:8b ── may call list_files / read_file / git_log / git_diff (≤ 3 rounds) ──▶ answer [n]
```

## Run it

```bash
ollama pull qwen3:8b nomic-embed-text   # the reranker comes from the Hugging Face cache (task 23)
uv run devassist index                  # → index/index.db, ~20 s; later runs re-embed only changed files
uv run devassist                        # the assistant
uv run devassist ask "What is in task30/gateway?"        # one answer (--json: the full record)
uv run devassist eval                   # questions.json, checked
uv run pytest                           # 58 tests, no Ollama needed
```

In the assistant:

| command | |
| --- | --- |
| `/help QUESTION` | ask about the project; plain text does the same |
| `/help` | the command list |
| `/branch`, `/status` | MCP `git_branch`, `git_status` |
| `/files [PATH] [DEPTH]` | MCP `list_files` |
| `/diff [PATH] [--base B] [--stat]` | MCP `git_diff`: uncommitted, or the branch since it forked from B |
| `/log [N] [PATH]` | MCP `git_log` |
| `/sources` | the passages, git state and tool calls behind the last answer |
| `/reindex` | re-embed documentation that changed |
| `/quit` | leave (Ctrl-D too) |

`devmcp` is an ordinary MCP server, so any MCP client can use it: `uv run devmcp` (the repository
is `DEVMCP_ROOT`, else the one around the working directory).

## What is indexed

`uv run devassist files` lists it. On the current tree: 120 documents, ~775 chunks.

| kind | what | how it's chunked |
| --- | --- | --- |
| markdown | `README.md`, `docs/*.md`, each task's `README.md`, `PLAN.md`, `COMPARISON.md` | one chunk per section, cut at headings; long sections packed on paragraph boundaries, code fences kept whole |
| openapi | `docs/api/task30-gateway.openapi.yaml` | rendered to Markdown first: one section per operation, one per schema |
| text | `taskN.txt` (the brief), `pyproject.toml`, `go.mod`, `compose*.yaml`, `Dockerfile`, `Modelfile`, `.env.example` | whole, or packed on blank lines |
| schema | `CREATE TABLE` / `CREATE INDEX` statements pulled out of `*.py`, `*.go`, `*.js` | one document per source file |

Left out on purpose: `taskN/docs/` (the RAG corpora of tasks 21–29, about other subjects, not
this project), `EVAL.md` (generated reports, ~200 KB that crowd out the prose), tests, and
anything git ignores. The file list comes from `git ls-files`, plus untracked files that git
doesn't ignore.

Every chunk is embedded with its path and heading path in front:
`task30/README.md › Task 30: … › Settings`. Thirty READMEs have a "Run it" or "Settings" section,
and only the path tells them apart. Non-Markdown files get their task's README title as the
section, so a `pyproject.toml` or a schema says whose it is.

## How `/help` answers

1. **Git state, always.** `git_branch` (branch, upstream, ahead/behind, commits since `main`) and
   `git_status` are fetched over MCP before the model sees anything. "What branch am I on?" never
   depends on the model deciding to call a tool.
2. **A named directory is listed.** If the question contains a path (`task30/gateway`, `docs/`)
   that is a directory, `list_files` runs up front and the listing goes into the prompt.
3. **Retrieval.** A question that names tasks ("task 30", "tasks 16-20", "день 27") searches only
   those folders plus the repository docs. The candidates are cosine top 20 (`nomic-embed-text`)
   and BM25 top 20, merged by reciprocal rank fusion; the `bge-reranker-base` cross-encoder picks
   the best 6.
4. **Tools, when the docs can't answer.** The model is offered `list_files`, `read_file`,
   `git_log` and `git_diff` (Ollama native tool calling). Each result goes back as a tool message.
   After 3 rounds it has to answer without tools.
5. **Citations are checked.** A `[n]` that points at no passage is deleted. The sources under the
   answer are the passages the answer actually cites.

## Results

`uv run devassist eval`: 15 questions in [`questions.json`](questions.json) about structure,
conventions, the API spec, data schemas and the live git state, plus one in Russian and one the
docs can't answer. Each answer is checked for the facts it must contain (`{branch}` and the last
commit's subject are filled in from git), retrieval for an expected source among the 6 passages,
and tool use for the tools the question needs. qwen3:8b, M1 Pro.

```
passed          14/15
retrieval hit   10/10 (expected source among the passages)
answer checks   14/15
tool use        15/15
mean time       15.6s
```

| id | question | retrieval | answer | tools used | time |
| --- | --- | --- | --- | --- | --- |
| branch | What branch am I on, and which task is it for? | — | ✓ | — | 16.0s |
| branch-convention | What is the naming convention for git branches in this repo? | hit | ✓ | — | 12.5s |
| browser-tests | How do I run the tests of the browser JavaScript tasks? | hit | ✓ | — | 15.4s |
| embeddings | Which embedding model does the RAG pipeline use, and where does it run? | hit | ✗ ollama | — | 14.4s |
| mcp-stack | Which language and MCP SDK are tasks 16-20 written in? | hit | ✓ | — | 10.1s |
| queue-full | What HTTP status and error code does the task 30 gateway return when its queue is full? | hit | ✓ | — | 13.5s |
| api-fields | Which fields does a chat completion request to the task 30 gateway accept? | hit | ✓ | — | 20.2s |
| chat-schema | Which tables does the task 25 chat keep in SQLite? | hit | ✓ | — | 15.6s |
| deps | Which Python version and which dependencies does task 27 need? | hit | ✓ | — | 16.6s |
| idk-threshold | In task 23, when does the agent refuse to answer without calling the LLM? | hit | ✓ | — | 14.6s |
| dir-listing | What is in task30/gateway? | — | ✓ | list_files (named path) | 18.1s |
| branch-diff | Which files has this branch changed compared to main? | — | ✓ | git_diff | 28.3s |
| last-commits | What were the last two commits? | — | ✓ | git_log | 14.5s |
| ru-model | Какая модель используется в задаче 30 и через что она запущена? | hit | ✓ | — | 12.3s |
| not-documented | How do I deploy task 12 to Kubernetes? | — | ✓ | — | 11.9s |

The one failure is a made-up fact, not a retrieval miss: the passages named `nomic-embed-text`
without saying where it runs, and the answer said "in the Python environment". Full record:
[`results/eval-20261013T224157.json`](results/eval-20261013T224157.json).

### A session

Unedited (`uv run devassist`, input piped in, so no colours):

```
devassist · branch: task31/dev-assistant · 120 documents indexed · model qwen3:8b
/help QUESTION (or just type it) · /help for commands · /quit
> branch: task31/dev-assistant
upstream: none (not pushed)
commits since main: 3
repository: /Users/atabek/Projects/AI/ai-advent-challenge9

> To run the tests of the browser tasks, use the command `node test.js` as specified in the conventions [3]. This command is applicable for tasks 4–15, which are implemented in browser JS and do not require a build step.

sources
  [3] docs/conventions.md › Conventions › Secrets
branch task31/dev-assistant · 1 model call · 3093+52 tokens · 20.7s

> The task 25 chat keeps the following tables in SQLite:

- `sessions`: to store session information such as ID, title, and timestamps.
- `messages`: to store messages with details like session ID, turn number, role, text, and data.
- `memory`: to store the task memory for each session.
- `memory_log`: to log changes to the memory over time.

These tables are defined in the `store.py` file within the `rag/` directory of the task 25 folder [1].

sources
  [1] task25/rag/store.py › Task 25 — Mini-chat with RAG, sources and task memory · data schema (SQL)
branch task31/dev-assistant · scope task25 · 1 model call · 3122+109 tokens · 15.4s

> The `task30/gateway` directory contains the following files:

- `__init__.py`: Likely an initialization file for the gateway package.
- `app.py`: The main API implementation, handling the OpenAI-compatible HTTP API and SSE streaming.
- `config.py`: Contains configuration settings for the gateway, such as API keys and model settings.
- `limits.py`: Implements the token-bucket rate limiter and the slot gate with its queue.
- `ollama.py`: Handles communication with Ollama's native `/api/chat` endpoint, including streaming and thinking off.
- `serve.py`: Likely contains the code to run the gateway server, possibly with settings for the server.

These files together form the gateway that serves the OpenAI-compatible API and manages the local LLM service.

looked at
  list_files('task30/gateway')  (path in the question)
branch task31/dev-assistant · scope task30 · 1 model call · 3089+162 tokens · 18.4s

> The last two commits on this branch were:

1. **bc08ce3** (2026-10-13): "Task 31: the assistant: /help over docs, git state and MCP tools" — This commit likely involved enhancing the assistant's `/help` functionality to provide information about documentation, the git state, and MCP tools.

2. **104d9ea** (2026-10-13): "Task 31: devmcp, an MCP server with the repository's git state" — This commit likely involved setting up an MCP server that provides the repository's git state.

looked at
  git_log(n=2, path='.')  → bc08ce3 2026-10-13 Atabek  Task 31: the assistant: /help over docs, git state an
branch task31/dev-assistant · 2 model calls · 5960+163 tokens · 17.7s
```

Two things the eval doesn't catch are visible here. The browser-tests answer is right but cites
`[3]`, the "Secrets" section, when the fact is in "Toolchains" of the same file. It also says
tasks 4–15 have tests, when only 11–15 have a `test.js`. The commit summaries add "likely
involved…" paraphrases of the subjects.

## What testing changed

Each of these came from running a real question and reading the answer:

- **BM25 next to the embeddings.** "How do I run the tests of the browser tasks?" never retrieved
  the conventions table that says `node test.js`: it wasn't in the cosine top 20. Keyword search
  finds it; the two lists are fused before reranking.
- **List a named directory up front.** Asked "what modules are in `task31/devassist`?", qwen3
  didn't call `list_files`. It listed the modules the docs happened to mention, and described
  one as "likely" doing something. Listing the directory before the model runs fixed it.
- **Say what the git state isn't.** For "which files has this branch changed compared to main?"
  the model read the uncommitted files from `git status` and called them the branch's changes.
  The prompt now labels that block "uncommitted changes only (not the branch's commits)", and a
  reminder after the question says to call a tool when the answer depends on the live
  repository. Now it calls `git_diff(base="main", stat=true)`.
- **Errors that say how to retry.** Asked for "the last two commits on this branch", the model
  passed the branch name as `git_log`'s `path`, got "no commits", and reported that the branch
  had none. `git_log` and `git_diff` now return an error for a path that doesn't exist, with the
  fix in the message. The system prompt says to correct the arguments and call again, and the
  model now does: `git_log(path='task31/dev-assistant')` → error → `git_log(n=2)` → the answer.
- **The reranker reads the path.** Tried scoring only section + text, or text only: the expected
  source fell out of the top 6 for 1 and 2 more questions out of 10. The label stays.

## Limits

- An 8B model fills gaps. When the passages name `nomic-embed-text` but not where it runs, it
  said "in the Python environment" (it's Ollama). The citations show which passage a claim came
  from, but a sentence with no citation can still be a guess.
- Aggregate questions ("which tasks use X?") get 6 passages, not every task. The answer lists
  what those passages mention.
- A question has to say which task it means. "What tables does the task 18 store have?" gets its
  SQL schema first; "…the HN scheduler store…" ranks it 18th, because nothing in the schema
  says "HN". Non-Markdown chunks carry their task's title for this reason, but the title
  ("Scheduler and background tasks") doesn't say "HN" either.
- Retrieval inside one task is weaker than across tasks. Every chunk's label starts with the
  task's title, so for task 30 the reranker scores most of its chunks above 0.6.
- The documentation describes the repository as it was written. The code itself is reached only
  through `read_file`, when the model thinks to call it.

## Files

- [`devassist/corpus.py`](devassist/corpus.py): which files are documentation, schema extraction
- [`devassist/chunk.py`](devassist/chunk.py): Markdown/OpenAPI/text chunking
- [`devassist/embed.py`](devassist/embed.py), [`store.py`](devassist/store.py), [`index.py`](devassist/index.py): embeddings (from task 27), SQLite, incremental build
- [`devassist/lexical.py`](devassist/lexical.py), [`rerank.py`](devassist/rerank.py), [`retrieve.py`](devassist/retrieve.py): BM25, cross-encoder, scoped hybrid retrieval
- [`devmcp/server.py`](devmcp/server.py): the MCP server
- [`devassist/tools.py`](devassist/tools.py): the MCP client (stdio), MCP → Ollama tool specs
- [`devassist/llm.py`](devassist/llm.py): Ollama `/api/chat` with tools
- [`devassist/assistant.py`](devassist/assistant.py): `/help`: the prompt, the tool loop, citation checks
- [`devassist/repl.py`](devassist/repl.py), [`cli.py`](devassist/cli.py): the commands
- [`devassist/evaluate.py`](devassist/evaluate.py), [`questions.json`](questions.json), `results/`: the evaluation
- [`tests/`](tests): chunking, corpus selection, incremental index, scoped search (fake embedder); every MCP tool on a throwaway repo, in process over a real MCP client; the tool loop, citations and REPL commands with a scripted LLM
