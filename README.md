# AI Advent Challenge — season 9

One folder per day of the challenge. Each `taskN/` is self-contained: its own dependencies, its
own README describing what was built and what was measured, and the original brief as
`taskN.txt` (in Russian). Most tasks build on the one before, and the README says how.

More detail in [`docs/`](docs/):
- [`docs/architecture.md`](docs/architecture.md): how the project evolved, and the components
  the later tasks share.
- [`docs/api/`](docs/api/): API specifications (the task 30 gateway, OpenAPI).
- [`docs/conventions.md`](docs/conventions.md): layout, toolchains, running and testing each kind
  of task, git workflow, secrets.

## Tasks

| Task | What it is | Stack |
| --- | --- | --- |
| [1](task1) | DeepSeek CLI: one question, one answer | Python, DeepSeek API |
| [2](task2) | The same question with format, length and stop controls | Python, DeepSeek API |
| [3](task3) | One problem solved four ways (direct, step by step, meta-prompt, expert panel) | Python, DeepSeek API |
| [4](task4) | One prompt at several temperatures, side by side | browser JS, DeepSeek API |
| [5](task5) | One prompt on three tiers of model | browser JS |
| [6](task6) | The first agent: a distinct entity that owns the request/response logic | browser JS |
| [7](task7) | The agent that remembers: conversation persisted across reloads | browser JS |
| [8](task8) | The agent that counts: tokens per request, per history, per answer | browser JS |
| [9](task9) | Context compression: last N messages verbatim, the rest summarised | browser JS |
| [10](task10) | Context strategies without a summary: window, facts, branches | browser JS |
| [11](task11) | A memory model: short-term, working and long-term layers | browser JS |
| [12](task12) | Personalisation: a user profile on top of the memory model | browser JS |
| [13](task13) | A task state machine the model cannot narrate its way around | browser JS |
| [14](task14) | Invariants the conversation cannot argue with | browser JS |
| [15](task15) | Controlled state transitions | browser JS |
| [16](task16) | `mcpls`: connect to an MCP server and list its tools | Go, MCP go-sdk |
| [17](task17) | First MCP tool: an Open Library server and a REPL agent | Go, MCP, DeepSeek |
| [18](task18) | Scheduled MCP tool: Hacker News collected on a schedule into SQLite | Go, MCP, DeepSeek |
| [19](task19) | Composing MCP tools: search → summarize → save_to_file | Go, MCP, DeepSeek |
| [20](task20) | MCP orchestration: three servers, twelve tools, graded scenarios | Go, MCP, DeepSeek |
| [21](task21) | Document indexing: PDFs → chunks (two strategies) → embeddings in SQLite | Python, Ollama embeddings |
| [22](task22) | First RAG query: plain vs RAG answers | Python, DeepSeek |
| [23](task23) | Reranking, filtering and query rewriting | Python, bge-reranker |
| [24](task24) | Citations, sources and "I don't know" | Python, DeepSeek |
| [25](task25) | Mini-chat with RAG, sources and task memory (web + CLI) | Python, FastAPI, DeepSeek |
| [26](task26) | A local LLM: `qwen3:8b` in Ollama | Python, Ollama |
| [27](task27) | Task 25's RAG chat moved to the local model | Python, Ollama |
| 28 | Local LLM + RAG (brief only, not done separately: task 27 covers it) | — |
| [29](task29) | Optimising the local model for the RAG answer step | Python, Ollama |
| [30](task30) | The local LLM as a private service: gateway, keys, limits, tunnel | Python, FastAPI, Docker, Ollama |
| [31](task31) | Developer assistant: RAG over these docs + git over MCP | Python, MCP, Ollama |
| [32](task32) | Automated code review of every PR: diff + RAG over docs and code, on a self-hosted runner | Python, GitHub Actions, Ollama |
