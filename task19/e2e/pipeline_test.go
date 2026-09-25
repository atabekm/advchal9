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

const algoliaReply = `{"nbHits": 3, "hits": [
 {"objectID": "1", "title": "Why asynchronous Rust doesn't work", "url": "https://theta.eu.org/async-rust-2.html", "points": 612, "num_comments": 435, "created_at": "2021-03-08T10:00:00Z"},
 {"objectID": "2", "title": "Futurelock: A subtle risk in async Rust", "url": "https://rfd.shared.oxide.computer/rfd/0609", "points": 449, "num_comments": 230, "created_at": "2025-10-01T10:00:00Z"},
 {"objectID": "3", "title": "Async Rust never left the MVP state", "url": "https://tweedegolf.nl/mvp", "points": 390, "num_comments": 301, "created_at": "2025-06-01T10:00:00Z"}
]}`

// The summarizer's model answers with this, whatever it is sent.
const summaryText = `Three widely discussed critiques of **async Rust**:

- [Why asynchronous Rust doesn't work](https://theta.eu.org/async-rust-2.html) argues the model is fundamentally awkward (612 points).
- [Futurelock](https://rfd.shared.oxide.computer/rfd/0609) describes a subtle deadlock risk.
- [Async Rust never left the MVP state](https://tweedegolf.nl/mvp) says the feature stalled after launch.`

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
			return toolCall("call_1", "search", map[string]any{"query": "rust async", "limit": 3})
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
	algolia := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(algoliaReply))
	}))
	t.Cleanup(algolia.Close)
	sumLLM := llm.NewDeepSeek("server-key", "deepseek-flash")
	sumLLM.BaseURL = fakeChat(t, func([]llm.Message) map[string]any {
		return map[string]any{"role": "assistant", "content": summaryText}
	}).URL
	dir := t.TempDir()

	servers := []*mcp.Server{
		search.NewServer(&search.Client{BaseURL: algolia.URL, HTTP: algolia.Client()}),
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
	// search text, and it names every story.
	st := a.Chain.Steps
	if h := st[1].Handoffs[0]; h.From != 1 || h.Arg != "text" {
		t.Errorf("summarize handoff %+v", h)
	}
	for _, title := range []string{"Why asynchronous Rust doesn't work", "Futurelock", "never left the MVP"} {
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
