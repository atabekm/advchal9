package openlibrary

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeOL is a scripted Open Library: path → JSON body. Unknown paths 404.
// It records every query it saw so tests can assert what reached the API.
type fakeOL struct {
	mu     sync.Mutex
	routes map[string]string
	seen   []*http.Request
}

func (f *fakeOL) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.seen = append(f.seen, r)
	body, ok := f.routes[r.URL.Path]
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"notfound"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(body))
}

func (f *fakeOL) last() *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.seen[len(f.seen)-1]
}

// connect starts the real server against the fake API and returns a real MCP
// client session over in-memory transports: calls go through the same
// validation and serialisation a stdio client would see.
func connect(t *testing.T, routes map[string]string) (*mcp.ClientSession, *fakeOL) {
	t.Helper()
	fake := &fakeOL{routes: routes}
	ts := httptest.NewServer(fake)
	t.Cleanup(ts.Close)

	c := NewClient()
	c.BaseURL = ts.URL
	server := NewServer(c)

	ctx := context.Background()
	st, ct := mcp.NewInMemoryTransports()
	ss, err := server.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs, fake
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error: %v", name, err)
	}
	return res
}

func text(res *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func decode[T any](t *testing.T, res *mcp.CallToolResult) T {
	t.Helper()
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", text(res))
	}
	raw, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("structuredContent %s: %v", raw, err)
	}
	return v
}

func wantToolError(t *testing.T, res *mcp.CallToolResult, contains string) {
	t.Helper()
	if !res.IsError {
		t.Fatalf("expected isError, got %s", text(res))
	}
	if !strings.Contains(text(res), contains) {
		t.Fatalf("error %q does not mention %q", text(res), contains)
	}
}

const leGuinSearch = `{"numFound": 11, "docs": [
  {"key": "/works/OL59798W", "title": "A Wizard of Earthsea", "author_name": ["Ursula K. Le Guin"], "first_publish_year": 1968, "edition_count": 180},
  {"key": "/works/OL59800W", "title": "The Left Hand of Darkness", "author_name": ["Ursula K. Le Guin"], "first_publish_year": 1969, "edition_count": 150},
  {"key": "/works/OL59850W", "title": "Rocannon's World", "first_publish_year": 1966, "edition_count": 40}
]}`

func TestToolsAreListedWithSchemas(t *testing.T) {
	cs, _ := connect(t, nil)
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range res.Tools {
		byName[tool.Name] = tool
	}
	if len(byName) != 2 || byName["search_books"] == nil || byName["get_work"] == nil {
		t.Fatalf("tools = %v", byName)
	}

	raw, _ := json.Marshal(byName["search_books"].InputSchema)
	var schema struct {
		Properties map[string]struct {
			Type        string   `json:"type"`
			Description string   `json:"description"`
			Minimum     *float64 `json:"minimum"`
			Maximum     *float64 `json:"maximum"`
			Default     any      `json:"default"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	lim := schema.Properties["limit"]
	if lim.Type != "integer" || lim.Minimum == nil || *lim.Minimum != 1 || *lim.Maximum != 20 || lim.Default != 5.0 {
		t.Errorf("limit schema = %+v", lim)
	}
	if schema.Properties["author"].Description == "" {
		t.Error("author has no description")
	}
	if len(schema.Required) != 0 {
		t.Errorf("search_books required = %v, want none (enforced in handler)", schema.Required)
	}

	raw, _ = json.Marshal(byName["get_work"].InputSchema)
	if !strings.Contains(string(raw), `"required":["work_id"]`) || !strings.Contains(string(raw), `"pattern"`) {
		t.Errorf("get_work schema = %s", raw)
	}
	if byName["get_work"].OutputSchema == nil {
		t.Error("get_work has no output schema")
	}
}

func TestSearchBooks(t *testing.T) {
	cs, fake := connect(t, map[string]string{"/search.json": leGuinSearch})
	out := decode[SearchBooksOut](t, call(t, cs, "search_books", map[string]any{
		"author": "Ursula K. Le Guin", "year_from": 1960, "year_to": 1969, "limit": 3,
	}))

	if out.TotalFound != 11 || out.Returned != 3 || len(out.Books) != 3 {
		t.Fatalf("out = %+v", out)
	}
	b := out.Books[0]
	if b.WorkID != "OL59798W" || b.Title != "A Wizard of Earthsea" || b.FirstPublishYear != 1968 ||
		b.URL != "https://openlibrary.org/works/OL59798W" || b.Authors[0] != "Ursula K. Le Guin" {
		t.Errorf("book = %+v", b)
	}
	if out.Books[2].Authors == nil {
		t.Error("missing author_name should become [], not null")
	}

	q := fake.last().URL.Query()
	if q.Get("author") != "Ursula K. Le Guin" || q.Get("q") != "first_publish_year:[1960 TO 1969]" ||
		q.Get("limit") != "3" || q.Get("fields") == "" {
		t.Errorf("query sent = %v", q)
	}
	if ua := fake.last().Header.Get("User-Agent"); !strings.Contains(ua, "ai-advent-task17") {
		t.Errorf("User-Agent = %q", ua)
	}
}

func TestSearchDefaultsAndOpenRange(t *testing.T) {
	cs, fake := connect(t, map[string]string{"/search.json": `{"numFound": 0, "docs": []}`})
	out := decode[SearchBooksOut](t, call(t, cs, "search_books", map[string]any{
		"query": "dune", "year_from": 1990,
	}))
	q := fake.last().URL.Query()
	if q.Get("limit") != "5" {
		t.Errorf("default limit sent = %q", q.Get("limit"))
	}
	if q.Get("q") != "dune first_publish_year:[1990 TO *]" {
		t.Errorf("q = %q", q.Get("q"))
	}
	// Zero hits is an answer, not an error.
	if out.TotalFound != 0 || out.Books == nil || len(out.Books) != 0 {
		t.Errorf("empty result = %+v", out)
	}
}

func TestSearchRejectsBadInput(t *testing.T) {
	cs, fake := connect(t, map[string]string{"/search.json": leGuinSearch})

	wantToolError(t, call(t, cs, "search_books", map[string]any{}), "at least one of")
	wantToolError(t, call(t, cs, "search_books", map[string]any{"author": "   "}), "at least one of")
	wantToolError(t, call(t, cs, "search_books", map[string]any{"author": "x", "year_from": 2000, "year_to": 1990}), "after year_to")
	// Rejected by the schema before the handler runs.
	wantToolError(t, call(t, cs, "search_books", map[string]any{"author": "x", "limit": 50}), "limit")
	wantToolError(t, call(t, cs, "search_books", map[string]any{"author": "x", "limit": "five"}), "limit")
	wantToolError(t, call(t, cs, "search_books", map[string]any{"authr": "x"}), "authr")

	if len(fake.seen) != 0 {
		t.Errorf("invalid input reached the API %d times", len(fake.seen))
	}
}

func TestSearchUpstreamFailureIsToolError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()
	c := NewClient()
	c.BaseURL = ts.URL
	st, ct := mcp.NewInMemoryTransports()
	ctx := context.Background()
	ss, _ := NewServer(c).Connect(ctx, st, nil)
	defer ss.Close()
	cs, _ := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	defer cs.Close()

	wantToolError(t, call(t, cs, "search_books", map[string]any{"query": "x"}), "HTTP 503")
}

const dune = `{
  "key": "/works/OL893414W", "type": {"key": "/type/work"}, "title": "Dune",
  "description": "Set on the desert planet Arrakis.",
  "subjects": ["a","b","c","d","e","f","g","h","i","j","k","l"],
  "first_publish_date": "1965",
  "authors": [{"author": {"key": "/authors/OL79034A"}, "type": {"key": "/type/author_role"}},
              {"author": {"key": "/authors/OLMISSINGA"}}]
}`

func TestGetWork(t *testing.T) {
	cs, _ := connect(t, map[string]string{
		"/works/OL893414W.json":  dune,
		"/authors/OL79034A.json": `{"name": "Frank Herbert"}`,
	})
	for _, id := range []string{"OL893414W", "/works/OL893414W", "https://openlibrary.org/works/OL893414W/Dune"} {
		out := decode[WorkOut](t, call(t, cs, "get_work", map[string]any{"work_id": id}))
		if out.WorkID != "OL893414W" || out.Title != "Dune" || out.FirstPublished != "1965" || out.RedirectedFrom != "" {
			t.Fatalf("%s: out = %+v", id, out)
		}
		// Second author 404s: degrade to the key, keep the call.
		if len(out.Authors) != 2 || out.Authors[0] != "Frank Herbert" || out.Authors[1] != "/authors/OLMISSINGA" {
			t.Errorf("authors = %v", out.Authors)
		}
		if len(out.Subjects) != maxSubjects {
			t.Errorf("subjects = %d, want capped at %d", len(out.Subjects), maxSubjects)
		}
	}
}

func TestGetWorkFollowsRedirects(t *testing.T) {
	cs, _ := connect(t, map[string]string{
		"/works/OL1W.json":       `{"key": "/works/OL1W", "type": {"key": "/type/redirect"}, "location": "/works/OL2W"}`,
		"/works/OL2W.json":       `{"key": "/works/OL2W", "type": {"key": "/type/redirect"}, "location": "/works/OL893414W"}`,
		"/works/OL893414W.json":  dune,
		"/authors/OL79034A.json": `{"name": "Frank Herbert"}`,
	})
	out := decode[WorkOut](t, call(t, cs, "get_work", map[string]any{"work_id": "OL1W"}))
	if out.WorkID != "OL893414W" || out.RedirectedFrom != "OL1W" {
		t.Errorf("out = %+v", out)
	}
}

func TestGetWorkRedirectLoopIsBounded(t *testing.T) {
	cs, fake := connect(t, map[string]string{
		"/works/OL1W.json": `{"type": {"key": "/type/redirect"}, "location": "/works/OL2W"}`,
		"/works/OL2W.json": `{"type": {"key": "/type/redirect"}, "location": "/works/OL1W"}`,
	})
	wantToolError(t, call(t, cs, "get_work", map[string]any{"work_id": "OL1W"}), "redirects")
	if len(fake.seen) != maxRedirects+1 {
		t.Errorf("fetched %d times", len(fake.seen))
	}
}

func TestGetWorkDescriptionObjectAndTruncation(t *testing.T) {
	long := strings.Repeat("word ", 1000)
	cs, _ := connect(t, map[string]string{
		"/works/OL5W.json": `{"key": "/works/OL5W", "type": {"key": "/type/work"}, "title": "T",
			"description": {"type": "/type/text", "value": "` + long + `"}}`,
	})
	out := decode[WorkOut](t, call(t, cs, "get_work", map[string]any{"work_id": "OL5W"}))
	if !strings.HasPrefix(out.Description, "word word") || !strings.HasSuffix(out.Description, "…") ||
		len([]rune(out.Description)) > maxDescription+1 {
		t.Errorf("description (%d runes) = %.40q…", len([]rune(out.Description)), out.Description)
	}
	if out.Authors == nil || out.Subjects == nil {
		t.Error("absent lists should be [], not null")
	}
}

func TestGetWorkErrors(t *testing.T) {
	cs, _ := connect(t, nil)
	wantToolError(t, call(t, cs, "get_work", map[string]any{"work_id": "OL404W"}), "no work with id OL404W")
	wantToolError(t, call(t, cs, "get_work", map[string]any{"work_id": "Dune"}), "work_id")
	wantToolError(t, call(t, cs, "get_work", map[string]any{}), "work_id")
}

// Search sometimes files an edition under /works/ (seen live:
// "/works/OL7524720M", an orphaned Ace Double). The id and link must still work.
func TestSearchEditionKey(t *testing.T) {
	cs, _ := connect(t, map[string]string{"/search.json": `{"numFound": 1, "docs": [
		{"key": "/works/OL7524720M", "title": "Rocannon's World / The Kar-Chee Reign", "first_publish_year": 1966}]}`})
	out := decode[SearchBooksOut](t, call(t, cs, "search_books", map[string]any{"author": "le guin"}))
	if b := out.Books[0]; b.WorkID != "OL7524720M" || b.URL != "https://openlibrary.org/books/OL7524720M" {
		t.Errorf("book = %+v", b)
	}
}

func TestGetWorkEditionResolvesToWork(t *testing.T) {
	cs, _ := connect(t, map[string]string{
		"/books/OL1M.json":       `{"key": "/books/OL1M", "type": {"key": "/type/edition"}, "title": "Dune (paperback)", "works": [{"key": "/works/OL893414W"}]}`,
		"/works/OL893414W.json":  dune,
		"/authors/OL79034A.json": `{"name": "Frank Herbert"}`,
	})
	out := decode[WorkOut](t, call(t, cs, "get_work", map[string]any{"work_id": "OL1M"}))
	if out.WorkID != "OL893414W" || out.Title != "Dune" || out.RedirectedFrom != "OL1M" {
		t.Errorf("out = %+v", out)
	}
}

func TestGetWorkOrphanEdition(t *testing.T) {
	cs, _ := connect(t, map[string]string{
		// Editions list authors as {"key": …}, not {"author": {"key": …}}.
		"/books/OL7524720M.json":  `{"key": "/books/OL7524720M", "type": {"key": "/type/edition"}, "title": "Rocannon's World / The Kar-Chee Reign", "publish_date": "1966", "authors": [{"key": "/authors/OL227499A"}]}`,
		"/authors/OL227499A.json": `{"name": "Ursula K. Le Guin"}`,
	})
	out := decode[WorkOut](t, call(t, cs, "get_work", map[string]any{"work_id": "OL7524720M"}))
	if out.WorkID != "OL7524720M" || out.FirstPublished != "1966" || out.RedirectedFrom != "" ||
		out.URL != "https://openlibrary.org/books/OL7524720M" || len(out.Authors) != 1 || out.Authors[0] != "Ursula K. Le Guin" {
		t.Errorf("out = %+v", out)
	}
}
