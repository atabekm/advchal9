package search

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The search response lists pages out of order (the API does), one of them a
// disambiguation page; the full-text response is per page.
const searchReply = `{"query": {"searchinfo": {"totalhits": 1234}, "pages": [
 {"pageid": 3, "title": "Tokio (software)", "index": 3, "fullurl": "https://en.wikipedia.org/wiki/Tokio_(software)",
  "extract": "Tokio is a runtime for Rust. \nIt was released in 2016.\n\n\n"},
 {"pageid": 1, "title": "Rust", "index": 1, "fullurl": "https://en.wikipedia.org/wiki/Rust", "pageprops": {"disambiguation": ""},
  "extract": "Rust may refer to:"},
 {"pageid": 2, "title": "Async/await", "index": 2, "fullurl": "https://en.wikipedia.org/wiki/Async/await",
  "extract": "Async/await is a syntactic feature."},
 {"pageid": 4, "title": "Empty", "index": 4, "fullurl": "https://en.wikipedia.org/wiki/Empty", "extract": "  "}
]}}`

var fullText = map[string]string{
	"2": "Async/await is a syntactic feature.\n\n== History ==\nC# had it first.\n\n== Examples ==\n\n=== Rust ===\n\n== See also ==\nCoroutine\nFutures and promises\n\n== References ==\n",
	"3": "Tokio is a runtime for Rust.",
}

type fakeWiki struct {
	mu      sync.Mutex
	status  int
	reqs    []map[string]string
	agents  []string
	errInfo string
}

func (f *fakeWiki) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := map[string]string{}
	for k := range r.URL.Query() {
		p[k] = r.URL.Query().Get(k)
	}
	f.reqs = append(f.reqs, p)
	f.agents = append(f.agents, r.UserAgent())
	switch {
	case f.status != 0:
		w.WriteHeader(f.status)
	case f.errInfo != "":
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"info": f.errInfo}})
	case p["titles"] != "":
		json.NewEncoder(w).Encode(titleReply(p["titles"]))
	case p["pageids"] != "":
		json.NewEncoder(w).Encode(map[string]any{"query": map[string]any{"pages": []any{
			map[string]any{"pageid": json.Number(p["pageids"]), "extract": fullText[p["pageids"]]},
		}}})
	default:
		w.Write([]byte(searchReply))
	}
}

func newFake(t *testing.T) (*fakeWiki, *Wiki) {
	f := &fakeWiki{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, &Wiki{BaseURL: srv.URL + "/w/api.php", HTTP: srv.Client()}
}

func TestIntro(t *testing.T) {
	f, c := newFake(t)
	r, err := c.Search(context.Background(), "rust async", 5, "intro")
	if err != nil {
		t.Fatal(err)
	}
	got, truncated := FormatArticles(r, 2000)
	want := `# 1. Async/await
https://en.wikipedia.org/wiki/Async/await

Async/await is a syntactic feature.

# 2. Tokio (software)
https://en.wikipedia.org/wiki/Tokio_(software)

Tokio is a runtime for Rust.
It was released in 2016.`
	if got != want || truncated != 0 {
		t.Errorf("got (%d truncated)\n%s\n\nwant\n%s", truncated, got, want)
	}
	if len(f.reqs) != 1 || f.reqs[0]["exintro"] != "1" || f.reqs[0]["gsrsearch"] != "rust async" || f.reqs[0]["gsrlimit"] != "8" {
		t.Errorf("intro should be one request with spare hits for skipped pages: %v", f.reqs)
	}
	if !strings.HasPrefix(f.agents[0], "task20-searchserver/") {
		t.Errorf("User-Agent %q", f.agents[0])
	}
}

func TestLimitAfterSkipping(t *testing.T) {
	_, c := newFake(t)
	r, _ := c.Search(context.Background(), "x", 1, "intro")
	if len(r.Articles) != 1 || r.Articles[0].Title != "Async/await" {
		t.Errorf("want the best non-disambiguation hit only, got %+v", r.Articles)
	}
}

func TestFull(t *testing.T) {
	f, c := newFake(t)
	r, err := c.Search(context.Background(), "x", 5, "full")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.reqs) != 3 {
		t.Errorf("full: one search + one request per article, got %d", len(f.reqs))
	}
	// Headings become Markdown, the empty section and the back matter go.
	want := "Async/await is a syntactic feature.\n\n## History\n\nC# had it first."
	if r.Articles[0].Text != want {
		t.Errorf("full text\n%q\nwant\n%q", r.Articles[0].Text, want)
	}
}

// titleReply answers a lookup by title the way the API does: a redirect,
// a missing page, a disambiguation page, or the article.
func titleReply(title string) map[string]any {
	q := map[string]any{}
	page := map[string]any{"pageid": 7, "title": title, "fullurl": "https://en.wikipedia.org/wiki/" + strings.ReplaceAll(title, " ", "_"),
		"extract": "Lead.\n\n== Plot ==\nThings happen.\n\n== References ==\nx"}
	switch title {
	case "LHoD":
		q["redirects"] = []any{map[string]any{"from": "LHoD", "to": "The Left Hand of Darkness"}}
		page["title"], page["fullurl"] = "The Left Hand of Darkness", "https://en.wikipedia.org/wiki/The_Left_Hand_of_Darkness"
	case "Nope":
		page = map[string]any{"title": title, "missing": true}
	case "Mercury":
		page["pageprops"] = map[string]any{"disambiguation": ""}
	}
	q["pages"] = []any{page}
	return map[string]any{"query": q}
}

func TestArticle(t *testing.T) {
	f, c := newFake(t)
	a, err := c.Article(context.Background(), "LHoD")
	if err != nil {
		t.Fatal(err)
	}
	if a.Title != "The Left Hand of Darkness" || a.RedirectedFrom != "LHoD" || a.Text != "Lead.\n\n## Plot\n\nThings happen." {
		t.Errorf("%+v", a)
	}
	if r := f.reqs[0]; r["redirects"] != "1" || r["exintro"] != "" {
		t.Errorf("want the whole article, redirects followed: %v", r)
	}
	if _, err := c.Article(context.Background(), "Nope"); !errors.Is(err, ErrNoArticle) {
		t.Errorf("missing: %v", err)
	}
	if _, err := c.Article(context.Background(), "Mercury"); err == nil || !strings.Contains(err.Error(), "disambiguation") {
		t.Errorf("disambiguation: %v", err)
	}
}

func TestArticleTool(t *testing.T) {
	_, c := newFake(t)
	cs := connect(t, NewServer(Sources{Wiki: c}))
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "wiki_article", Arguments: map[string]any{"title": "LHoD"}})
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, text(res))
	}
	want := "# The Left Hand of Darkness\nhttps://en.wikipedia.org/wiki/The_Left_Hand_of_Darkness\n\nLead.\n\n## Plot\n\nThings happen."
	if text(res) != want {
		t.Errorf("got\n%s", text(res))
	}
	res, _ = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "wiki_article", Arguments: map[string]any{"title": "Nope"}})
	if !res.IsError || !strings.Contains(text(res), "search with the wikipedia tool") {
		t.Errorf("a missing title should point to search: %s", text(res))
	}
}

func TestClean(t *testing.T) {
	for in, want := range map[string]string{
		"a  \nb\t\n\n\n\nc\n":                      "a\nb\n\nc",
		"x\n== A ==\n=== A1 ===\ntext\n== B ==\n":  "x\n\n## A\n\n### A1\n\ntext",
		"x\n== A ==\n=== A1 ===\n== B ==\ny":       "x\n\n## B\n\ny",
		"x\n== External links ==\n=== More ===\nz": "x",
		"x\n== Notes ==\nn\n== Legacy ==\nl":       "x\n\n## Legacy\n\nl",
	} {
		if got := Clean(in); got != want {
			t.Errorf("Clean(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestTruncate(t *testing.T) {
	para := strings.Repeat("word ", 30) + "end."
	text := para + "\n\n" + para + "\n\n## Next\n\n" + para
	for _, tc := range []struct {
		max  int
		want string
		cut  bool
	}{
		{10000, text, false},
		{len(para)*2 + 20, para + "\n\n" + para, true},                            // at the paragraph, heading dropped
		{len(para) + 40, para, true},                                              // at the paragraph
		{80, strings.TrimSpace(strings.Repeat("word ", 16)), true},                // no boundary: hard cut
		{len("One. Two three four five. Six"), "One. Two three four five.", true}, // at the sentence
	} {
		src := text
		if strings.HasPrefix(tc.want, "One.") {
			src = "One. Two three four five. Six seven eight."
		}
		got, cut := Truncate(src, tc.max)
		if got != tc.want || cut != tc.cut {
			t.Errorf("Truncate(max %d)\n got %q (%v)\nwant %q (%v)", tc.max, got, cut, tc.want, tc.cut)
		}
	}
}

func TestFormatTruncated(t *testing.T) {
	r := Result{Query: "q", Detail: "full", Total: 1, Articles: []Article{{Title: "T", URL: "u", Text: strings.Repeat("abc. ", 100)}}}
	got, n := FormatArticles(r, 200)
	if n != 1 || !strings.HasPrefix(got, "# 1. T\nu\n\nabc. ") || !strings.HasSuffix(got, "abc. […]") || len([]rune(got)) > 200+20 {
		t.Errorf("%d truncated\n%s", n, got)
	}
}

func TestNoHits(t *testing.T) {
	got, _ := FormatArticles(Result{Query: "zzzz", Detail: "intro"}, 2000)
	if got != `No Wikipedia articles found for "zzzz".` {
		t.Errorf("got\n%s", got)
	}
}

func TestErrors(t *testing.T) {
	f, c := newFake(t)
	f.status = 503
	if _, err := c.Search(context.Background(), "x", 5, "intro"); err == nil || !strings.Contains(err.Error(), "503") {
		t.Errorf("want HTTP 503, got %v", err)
	}
	f.status, f.errInfo = 0, "Search request is longer than the maximum allowed length."
	if _, err := c.Search(context.Background(), "x", 5, "intro"); err == nil || !strings.Contains(err.Error(), "maximum allowed length") {
		t.Errorf("want the API's error, got %v", err)
	}
}

// The tool, through a real MCP client: defaults, text-first result, bounds.
func TestTool(t *testing.T) {
	f, c := newFake(t)
	cs := connect(t, NewServer(Sources{Wiki: c}))
	ctx := context.Background()

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "wikipedia", Arguments: map[string]any{"query": " rust async "}})
	if err != nil || res.IsError {
		t.Fatalf("call: %v %v", err, text(res))
	}
	if !strings.HasPrefix(text(res), "# 1. Async/await\nhttps://en.wikipedia.org/wiki/Async/await\n\n") {
		t.Errorf("content should be the formatted text, got %q", text(res))
	}
	if f.reqs[0]["gsrlimit"] != "8" {
		t.Errorf("default limit 5 (+3 spare), got %v", f.reqs[0]["gsrlimit"])
	}

	for _, args := range []map[string]any{
		{"query": "x", "limit": 11},
		{"query": "x", "chars": 100},
		{"query": "x", "chars": 5001},
		{"query": "x", "detail": "summary"},
		{"query": ""},
		{},
	} {
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "wikipedia", Arguments: args})
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
