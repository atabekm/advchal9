# Task 33 — User support assistant: plan

A mini-service that answers support questions about a product, **Flowdesk** (a made-up team task
tracker), from two sources:

- **RAG over the knowledge base**: the FAQ and product documentation in `kb/` (sign-in, SSO,
  two-factor, billing, API keys, error codes, known issues and the changelog, integrations, ...).
- **MCP for the customer's context**: `supportmcp`, a stdio MCP server over `data/crm.json`
  (organizations, users, tickets with their messages). It gives the ticket, the user, their
  organization and their other tickets.

`POST /ask {question, ticket_id?, user_id?}` and a one-page web UI on top, plus a CLI. Everything
runs locally: `qwen3:8b` and `nomic-embed-text` in Ollama, `BAAI/bge-reranker-base` from the
Hugging Face cache.

## The point: the same question, different answers

"Why isn't authorization working?" has no single answer. The ticket decides it:

| ticket | what the CRM says | the answer should be |
| --- | --- | --- |
| locked | user `locked` after 5 failed sign-ins, error `AUTH_423_LOCKED` | wait 30 min or reset the password; an admin can unlock |
| sso | org enforces SSO (Okta), user types a password, `AUTH_403_SSO_REQUIRED` | use "Sign in with SSO" |
| desktop | desktop app 3.4.0, sign-in loop | known issue in 3.4.0–3.4.1, update to 3.4.2 |
| 2fa | TOTP codes rejected, `AUTH_401_OTP_INVALID` | phone clock drift; sync time, or use a backup code |
| suspended | org subscription `past_due` > 14 days, `AUTH_402_ORG_SUSPENDED` | the billing owner pays the invoice; who that is |
| api | integration gets 401 `API_KEY_INVALID`, key revoked | the key was revoked on a date; create a new one, `Authorization: Bearer` |
| invite | user `invited`, invite sent 9 days ago | invites expire after 7 days; ask an admin to resend |

Without a ticket the assistant gives the general troubleshooting list from the FAQ. That contrast
is the demo and the evaluation.

## Decisions

- **Context is deterministic.** With `ticket_id`, the service always calls `get_ticket`, then
  `get_user` for its author (with the organization) and `list_user_tickets`; with only `user_id`,
  the last two. All through MCP, before the model runs. The model doesn't choose whether to look:
  an 8B model skipping a tool call would answer generically, which is the failure this task is about.
- **The ticket steers retrieval.** The question alone ("authorization isn't working") retrieves
  the same passages for every ticket. The search query is the question plus the ticket's subject,
  error code, product area and client version, so `AUTH_423_LOCKED` finds the lockout section
  (BM25 is good at codes) and "desktop 3.4.0" finds the known issue.
- **The server formats facts, not raw JSON.** `get_ticket` returns readable lines (status, error
  code, client, the conversation), `get_user` the account state with what follows from it
  ("locked since …", "org requires SSO via Okta", "subscription past_due since …, 16 days"). Dates
  are compared with a fixed "today" from the data file so the demo doesn't age.
- **RAG from task 31, trimmed**: Markdown chunked at headings, path + heading path in the embedded
  text, cosine + BM25 fused by reciprocal rank, cross-encoder rerank, top 5. One SQLite index,
  re-embedded only for changed files.
- **The answer.** Written to the customer, in their language, citing docs as [n]; it may use the
  ticket facts without citation. Then one line for the support agent: the likely cause and which
  fact shows it. Citations pointing at nothing are removed (from task 31).
- **The service.** FastAPI: `GET /` (the page), `POST /ask`, `GET /tickets` and `GET /users` (for
  the page's pickers, also over MCP). One MCP session for the app's lifetime; model calls run
  one at a time in a worker thread.

## Stages

1. **Knowledge base, CRM data, MCP server**: `kb/*.md`, `data/crm.json`, `supportmcp` with
   `get_ticket`, `get_user`, `list_user_tickets`, `search_tickets`. Tests over a real MCP client
   in process.
2. **RAG**: chunking, embeddings, store, hybrid retrieval with rerank; `support index`,
   `support search`. Tests with a fake embedder.
3. **Assistant and service**: context gathering, query building, prompt, citations;
   `support ask`, `support context`, `support serve` with `POST /ask` and the web page. Tests with
   a scripted LLM and FastAPI's test client.
4. **Evaluation and README**: the auth question on every auth ticket plus product and account
   questions; checks for the expected cause and source, with and without context. Results and
   real transcripts in the README.

## Addendum: what the build changed

- The search query takes account and subscription flags always, but organization-wide ones (a
  revoked key, a disconnected integration) only without a ticket: Brightpath's broken Slack was
  leaking into Tom's lockout query.
- BM25 keeps error codes whole (`auth_423_locked`) as well as their parts; a table cut into
  chunks repeats its header in every piece.
- The prompt forbids internal ids and ends with a citation reminder; the page takes deep links
  (`/?ticket=T-1003&ask=1`), and the service loads the reranker at startup.
- `eval --ablation` reruns the context cases without their context: 10/10 with it, 3/10 without.
