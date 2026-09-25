package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const twoHits = `{"nbHits": 1284, "hits": [
 {"objectID": "26406989", "title": "Why asynchronous Rust doesn't work", "url": "https://theta.eu.org/2021/03/08/async-rust-2.html",
  "author": "tazjin", "points": 612, "num_comments": 435, "created_at": "2021-03-08T10:00:00Z"},
 {"objectID": "123", "title": "Ask HN: How do you learn async?", "url": null,
  "author": "someone", "points": null, "num_comments": null, "created_at": "2024-01-02T03:04:05Z"},
 {"objectID": "124", "title": "", "url": "https://example.com/untitled"}
]}`

type fakeAlgolia struct {
	mu     sync.Mutex
	status int
	body   string
	paths  []string
	params []map[string]string
}

func (f *fakeAlgolia) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paths = append(f.paths, r.URL.Path)
	p := map[string]string{}
	for k := range r.URL.Query() {
		p[k] = r.URL.Query().Get(k)
	}
	f.params = append(f.params, p)
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	w.Write([]byte(f.body))
}

func newFake(t *testing.T, body string) (*fakeAlgolia, *Client) {
	f := &fakeAlgolia{body: body}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, &Client{BaseURL: srv.URL + "/api/v1", HTTP: srv.Client()}
}

func TestFormat(t *testing.T) {
	_, c := newFake(t, twoHits)
	r, err := c.Search(context.Background(), "rust async", 10, "relevance")
	if err != nil {
		t.Fatal(err)
	}
	got := Format(r)
	for _, want := range []string{
		`Hacker News search: "rust async" · 2 of 1,284 matches · by relevance`,
		"1. Why asynchronous Rust doesn't work\n   https://theta.eu.org/2021/03/08/async-rust-2.html\n" +
			"   612 points · 435 comments · 2021-03-08 · https://news.ycombinator.com/item?id=26406989",
		// no url: the discussion page stands in; null counts read as 0
		"2. Ask HN: How do you learn async?\n   https://news.ycombinator.com/item?id=123\n   0 points · 0 comments · 2024-01-02",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if strings.Contains(got, "untitled") {
		t.Errorf("a hit without a title should be skipped:\n%s", got)
	}
}

func TestNoHits(t *testing.T) {
	_, c := newFake(t, `{"nbHits":0,"hits":[]}`)
	r, err := c.Search(context.Background(), "zzzz", 5, "date")
	if err != nil {
		t.Fatal(err)
	}
	if got := Format(r); !strings.Contains(got, `No stories found for "zzzz".`) {
		t.Errorf("got\n%s", got)
	}
}

func TestHTTPError(t *testing.T) {
	f, c := newFake(t, "")
	f.status = 503
	if _, err := c.Search(context.Background(), "x", 5, "relevance"); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("want an HTTP 503 error, got %v", err)
	}
}

// The tool, through a real MCP client: defaults, the sort → endpoint mapping,
// schema bounds and the text-first result.
func TestTool(t *testing.T) {
	f, c := newFake(t, twoHits)
	cs := connect(t, NewServer(c))
	ctx := context.Background()

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "search", Arguments: map[string]any{"query": " rust async "}})
	if err != nil || res.IsError {
		t.Fatalf("call: %v %v", err, text(res))
	}
	if !strings.HasPrefix(text(res), `Hacker News search: "rust async"`) {
		t.Errorf("content should be the formatted text, got %q", text(res))
	}
	if f.paths[0] != "/api/v1/search" || f.params[0]["hitsPerPage"] != "10" || f.params[0]["tags"] != "story" {
		t.Errorf("defaults: path %s params %v", f.paths[0], f.params[0])
	}

	res, _ = cs.CallTool(ctx, &mcp.CallToolParams{Name: "search", Arguments: map[string]any{"query": "x", "sort": "date", "limit": 3}})
	if res.IsError || f.paths[1] != "/api/v1/search_by_date" || f.params[1]["hitsPerPage"] != "3" {
		t.Errorf("sort=date: path %s params %v (%s)", f.paths[1], f.params[1], text(res))
	}

	for _, args := range []map[string]any{
		{"query": "x", "limit": 31},
		{"query": "x", "sort": "points"},
		{"query": ""},
		{},
	} {
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "search", Arguments: args})
		if err == nil && !res.IsError {
			t.Errorf("%v: want a tool error, got %s", args, text(res))
		}
	}
}

func connect(t *testing.T, s *mcp.Server) *mcp.ClientSession {
	t.Helper()
	ct, st := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := s.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func text(r *mcp.CallToolResult) string {
	if r == nil {
		return ""
	}
	var b strings.Builder
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}
