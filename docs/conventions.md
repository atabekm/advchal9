# Conventions

## Layout

- One folder per task, `taskN/`, at the repository root. Nothing is shared between folders at
  runtime: a task that reuses code copies it.
- Each task has `taskN.txt` (the original brief, in Russian) and a `README.md`. Larger tasks also
  have `PLAN.md` (the plan written before coding, divided into stages) and, for the RAG tasks,
  `EVAL.md` (generated evaluation reports) and `questions.json` (the evaluation set).
- In tasks 21–29, `docs/` inside the task folder is the **corpus** the RAG system answers from,
  not documentation of the task. `index/` holds the generated SQLite index and is not committed.
- Repository-level documentation is the root `README.md` (the task index) and this `docs/` folder.

## Toolchains

| Tasks | Language | Run | Test |
| --- | --- | --- | --- |
| 1–3 | Python 3, `requirements.txt` | `python main.py` in a venv | — |
| 4–15 | Browser JS, no build | open `index.html` | `node test.js` (11–15) |
| 16–20 | Go modules (`go.mod`) | `go build ./cmd/...`, run the binaries | `go test ./...` |
| 21–31 | Python ≥ 3.13 with `uv` (`pyproject.toml`, `uv.lock`) | `uv run <script>` (scripts in `[project.scripts]`) | `uv run pytest` |

Local models run in Ollama on `localhost:11434` (`OLLAMA_HOST` overrides it). Pull what a task
needs first, e.g. `ollama pull qwen3:8b nomic-embed-text`.

## Secrets

API keys live in a `.env` file in the task folder (`DEEPSEEK_API_KEY=...`), which is gitignored;
`.env.example` shows the variables when a task has one. The browser tasks (4–15) take the key in
the UI and keep it in `localStorage`. Task 30 reads its gateway keys from `API_KEYS` in `.env`.

## Git workflow

- `main` is the integration branch. Work for a task happens on one branch named
  `taskN/<short-name>`, e.g. `task30/private-llm-service`, `task31/dev-assistant`.
- When the plan has stages, each stage is one commit on that branch, and one pull request is
  opened at the end. The PR is merged into `main` on GitHub, usually by the repository owner.
- Before starting the next task: switch to `main`, pull, and delete the merged branch locally.
- Commit messages start with the task: `Task 30: gateway in front of a local LLM: ...`.
