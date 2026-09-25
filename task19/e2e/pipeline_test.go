// Package e2e runs the whole pipeline: the three real servers over
// Streamable HTTP, the agent's router and chain check, and a scripted model
// in place of DeepSeek. No network beyond localhost.
package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task19/agent"
	"task19/llm"
	"task19/mcpserve"
	"task19/savefile"
	"task19/search"
	"task19/summarize"
)

const wikiReply = `{"query": {"searchinfo": {"totalhits": 212}, "pages": [
 {"pageid": 1, "title": "Async/await", "index": 1, "fullurl": "https://en.wikipedia.org/wiki/Async/await",
  "extract": "In computer programming, the async/await pattern is a syntactic feature of many programming languages that allows an asynchronous, non-blocking function to be structured in a way similar to an ordinary synchronous function."},
 {"pageid": 2, "title": "Tokio (software)", "index": 2, "fullurl": "https://en.wikipedia.org/wiki/Tokio_(software)",
  "extract": "Tokio is a software library for the Rust programming language. It provides a runtime and functions that enable the use of asynchronous I/O."},
 {"pageid": 3, "title": "Futures and promises", "index": 3, "fullurl": "https://en.wikipedia.org/wiki/Futures_and_promises",
  "extract": "In computer science, futures, promises, delays, and deferreds are constructs used for synchronizing program execution."}
]}}`

// The summarizer's model answers with this, whatever it is sent.
const summaryText = `Asynchronous programming in Rust rests on three ideas:

- [Async/await](https://en.wikipedia.org/wiki/Async/await) lets non-blocking code read like ordinary sequential code.
- [Futures and promises](https://en.wikipedia.org/wiki/Futures_and_promises) stand for results that are not ready yet.
- [Tokio](https://en.wikipedia.org/wiki/Tokio_(software)) is the runtime that drives them with asynchronous I/O.`

// chatFunc builds one assistant message from the conversation so far.
type chatFunc func(msgs []llm.Message) map[string]any

func fakeChat(t *testing.T, f chatFunc) *httptest.Server {
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		var req struct {
			Messages []llm.Message `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decoding chat request: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": f(req.Messages)}}})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func toolCall(id, name string, args map[string]any) map[string]any {
	b, _ := json.Marshal(args)
	return map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
		"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(b)},
	}}}
}

// scriptedModel chains search → summarize → save the way the real model is
// asked to: each call carries the previous tool message, passed through
// relay (identity for a faithful model).
func scriptedModel(relay func(string) string) chatFunc {
	return func(msgs []llm.Message) map[string]any {
		last := msgs[len(msgs)-1]
		replies := 0
		for _, m := range msgs {
			if m.Role == "tool" {
				replies++
			}
		}
		switch replies {
		case 0:
			return toolCall("call_1", "search", map[string]any{"query": "async programming in Rust", "limit": 3})
		case 1:
			return toolCall("call_2", "summarize", map[string]any{"text": relay(last.Content), "max_words": 100})
		case 2:
			return toolCall("call_3", "save_to_file", map[string]any{"filename": "rust-async.md", "content": relay(last.Content)})
		default:
			return map[string]any{"role": "assistant", "content": "Saved to " + last.Content}
		}
	}
}

type pipeline struct {
	dir    string
	router *agent.Router
	model  *llm.DeepSeek
}

func setup(t *testing.T, relay func(string) string) *pipeline {
	t.Helper()
	wiki := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(wikiReply))
	}))
	t.Cleanup(wiki.Close)
	sumLLM := llm.NewDeepSeek("server-key", "deepseek-flash")
	sumLLM.BaseURL = fakeChat(t, func([]llm.Message) map[string]any {
		return map[string]any{"role": "assistant", "content": summaryText}
	}).URL
	dir := t.TempDir()

	servers := []*mcp.Server{
		search.NewServer(&search.Client{BaseURL: wiki.URL, HTTP: wiki.Client()}),
		summarize.NewServer(&summarize.Summarizer{LLM: sumLLM}),
		savefile.NewServer(&savefile.Saver{Dir: dir}),
	}
	var conns []*agent.Server
	for _, s := range servers {
		hs := httptest.NewServer(mcpserve.Handler(s))
		t.Cleanup(hs.Close)
		url := hs.URL + "/mcp"
		c, err := agent.Connect(context.Background(), "e2e", url,
			&mcp.StreamableClientTransport{Endpoint: url, DisableStandaloneSSE: true, MaxRetries: -1}, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Session.Close() })
		conns = append(conns, c)
	}
	router, err := agent.NewRouter(conns)
	if err != nil {
		t.Fatal(err)
	}
	model := llm.NewDeepSeek("agent-key", "deepseek-flash")
	model.BaseURL = fakeChat(t, scriptedModel(relay)).URL
	return &pipeline{dir: dir, router: router, model: model}
}

func TestFaithfulChain(t *testing.T) {
	p := setup(t, func(s string) string { return s })
	a := agent.New(p.model, p.router, "system", agent.Observer{})
	answer, err := a.Ask(context.Background(), "find, summarize, save")
	if err != nil {
		t.Fatal(err)
	}

	path, counts, stores := a.Chain.Report()
	if path != "search → summarize → save_to_file" {
		t.Errorf("path %q", path)
	}
	if counts[agent.Exact] != 2 || len(counts) != 1 {
		t.Errorf("handoffs %v, want 2 exact", counts)
	}
	if len(stores) != 1 || !stores[0].Match || stores[0].Arg != "content" {
		t.Errorf("store check %+v", stores)
	}

	// The data really went search → summarize: the step-2 argument is the
	// search text, with every article's text in it.
	st := a.Chain.Steps
	if h := st[1].Handoffs[0]; h.From != 1 || h.Arg != "text" {
		t.Errorf("summarize handoff %+v", h)
	}
	for _, title := range []string{"# 1. Async/await", "asynchronous I/O", "synchronizing program execution"} {
		if !strings.Contains(st[0].Output, title) {
			t.Errorf("search output lacks %q", title)
		}
	}
	// … and summarize → file, byte for byte.
	got, err := os.ReadFile(filepath.Join(p.dir, "rust-async.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != summaryText || st[1].Output != summaryText {
		t.Errorf("file = %q\nwant %q", got, summaryText)
	}
	if !strings.Contains(answer, "rust-async.md") {
		t.Errorf("answer %q", answer)
	}
}

// A model that shortens what it carries is caught: both handoffs are partial,
// and the file is not the summary.
func TestShortenedHandoffIsCaught(t *testing.T) {
	halve := func(s string) string {
		l := strings.Split(s, "\n")
		return strings.Join(l[:len(l)/2+1], "\n") + "\nA line the model made up on the way."
	}
	p := setup(t, halve)
	a := agent.New(p.model, p.router, "system", agent.Observer{})
	if _, err := a.Ask(context.Background(), "find, summarize, save"); err != nil {
		t.Fatal(err)
	}
	_, counts, stores := a.Chain.Report()
	if counts[agent.Partial] != 2 || counts[agent.Exact] != 0 {
		t.Errorf("handoffs %v, want 2 partial", counts)
	}
	h := a.Chain.Steps[2].Handoffs[0]
	if h.From != 2 || h.Kept == 0 || h.Kept == h.Of || h.Added != 1 {
		t.Errorf("save handoff %+v", h)
	}
	// The server stored exactly what it was sent, so that check still passes:
	// it proves the file matches the call, while the handoff shows the call
	// did not match the summary.
	if len(stores) != 1 || !stores[0].Match {
		t.Errorf("store check %+v", stores)
	}
	got, _ := os.ReadFile(filepath.Join(p.dir, "rust-async.md"))
	if string(got) == summaryText {
		t.Error("the shortened content should have been saved as sent")
	}
}
