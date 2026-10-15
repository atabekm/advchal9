# Architecture

There is no single application in this repository: it is a sequence of small projects, one per
day, and each one usually starts as a copy of the previous one. This page describes the arcs and
the components that recur, so you know which task to open for a given piece.

## The arcs

1. **Calling a model (tasks 1–5).** Python CLIs against the DeepSeek API (`deepseek_client.py`,
   `main.py`), then static browser pages (`index.html`, `api.js`, `app.js`) that call the API
   straight from a `file://` page with a key pasted into the UI.
2. **Agents and memory (tasks 6–15).** Still browser JS with no build and no server. An `agent.js`
   owns the conversation; `store.js` persists it to `localStorage`; `tokens.js` counts tokens;
   `memory.js`, `facts.js`, `branch.js` (task 10), `layers.js` and `router.js` (task 11),
   `profile.js` (task 12), `machine.js` (task 13), `invariant.js` (task 14) and `lifecycle.js`
   (task 15) add one mechanism each. Every task from 11 on has a `test.js` run with `node test.js`.
3. **MCP (tasks 16–20).** Go, on the official `modelcontextprotocol/go-sdk`. Task 16 is a client
   (`mcpls`), 17–20 are servers under `cmd/` plus an agent that lets DeepSeek call their tools:
   Open Library (17), a Hacker News scheduler with SQLite (18), a three-server pipeline (19) and
   orchestration across three servers with graded scenarios (20).
4. **RAG (tasks 21–25).** Python with `uv`. `indexer/` turns PDFs in `docs/` into chunks and
   `nomic-embed-text` vectors in `index/index.db`; `rag/` retrieves, reranks
   (`BAAI/bge-reranker-base`), rewrites queries, answers with citations and verified quotes, or
   says "I don't know". Task 25 adds a chat with history and task memory (`chat/`, `web/`).
5. **Local models (tasks 26–30).** Ollama on the Mac's GPU. Task 26 runs `qwen3:8b`; task 27
   moves the task 25 chat onto it (`rag/llm.py`, `LocalLLM`); task 29 tunes it for the answer
   step (a `Modelfile`, the `qwen3-rag` model); task 30 serves `qwen3:4b-instruct` behind a
   FastAPI gateway (`gateway/`) with API keys, rate limits, a context limit and a queue, in
   Docker, published through a Cloudflare Tunnel.
6. **Developer assistant (task 31).** The RAG pieces again, pointed at this repository's own
   documentation, with an MCP server for the git state.
7. **Code review (task 32).** The same index extended to the repository's code (chunked at
   definitions), and a GitHub Actions workflow (`.github/workflows/task32-review.yml`) on a
   self-hosted runner that reviews every pull request with qwen3:8b and comments on it.

## Shared components

| Component | Where it lives | Used by |
| --- | --- | --- |
| DeepSeek client | `deepseek_client.py` (1–3), `api.js` (4–15), `llm/` (19–20), `rag/llm.py` (22–25) | tasks 1–25 |
| Local LLM client (Ollama `/api/chat`) | `task27/rag/llm.py` | 27, 29, 31 |
| Embeddings (`nomic-embed-text`, with `search_document:` / `search_query:` prefixes) | `indexer/embed.py` | 21–29, 31 |
| SQLite vector store (unit vectors, cosine = dot product) | `indexer/store.py` | 21–29, 31 |
| Structure-based chunking (cut at headings) | `indexer/chunk_struct.py` | 21–29, 31 |
| Cross-encoder reranker | `rag/rerank.py` | 23–29, 31 |
| MCP servers over stdio | `cmd/*server` (Go, 17–20), `devmcp/` (Python, 31) | 16–20, 31 |

## Models

- **DeepSeek** (`deepseek-chat`, `deepseek-reasoner`): tasks 1–25, through the cloud API.
- **qwen3:8b** in Ollama: tasks 26, 27, 29, 31, 32. **qwen3:4b-instruct**: task 30.
- **nomic-embed-text** (768-dim) in Ollama: every embedding since task 21.
- **BAAI/bge-reranker-base** from the Hugging Face cache: reranking since task 23.
