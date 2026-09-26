package search

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeAPI answers by path; unknown paths 404. It records each request.
type fakeAPI struct {
	mu     sync.Mutex
	routes map[string]string
	seen   []*http.Request
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.seen = append(f.seen, r)
	body, ok := f.routes[r.URL.Path]
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Write([]byte(body))
}

func (f *fakeAPI) find(path string) *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.seen {
		if r.URL.Path == path {
			return r
		}
	}
	return nil
}

func serve(t *testing.T, routes map[string]string) (*fakeAPI, string, *http.Client) {
	f := &fakeAPI{routes: routes}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv.URL, srv.Client()
}

const hnReply = `{"nbHits": 1284, "hits": [
 {"objectID": "31", "title": "Webb's first images", "url": "https://nasa.gov/webb", "author": "a", "points": 1520, "num_comments": 403, "created_at": "2022-07-12T14:00:00Z"},
 {"objectID": "32", "title": "  ", "url": "https://x"},
 {"objectID": "33", "title": "Ask HN: Is JWST worth it?", "url": "", "author": "b", "points": 12, "num_comments": null, "created_at": "2021-12-25T09:00:00Z"}
]}`

func TestHackerNews(t *testing.T) {
	f, base, hc := serve(t, map[string]string{"/search": hnReply, "/search_by_date": hnReply})
	cs := connect(t, NewServer(Sources{HN: &HN{BaseURL: base, HTTP: hc}}))
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "hackernews", Arguments: map[string]any{"query": "webb", "sort": "date", "limit": 3}})
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, text(res))
	}
	want := `1. Webb's first images
   https://nasa.gov/webb
   1,520 points · 403 comments · 2022-07-12 · https://news.ycombinator.com/item?id=31
2. Ask HN: Is JWST worth it?
   https://news.ycombinator.com/item?id=33
   12 points · 0 comments · 2021-12-25 · https://news.ycombinator.com/item?id=33`
	if text(res) != want {
		t.Errorf("got\n%s\nwant\n%s", text(res), want)
	}
	r := f.find("/search_by_date")
	if r == nil || r.URL.Query().Get("tags") != "story" || r.URL.Query().Get("hitsPerPage") != "3" {
		t.Errorf("sort=date should query /search_by_date for 3 stories: %v", f.seen)
	}
	if got := FormatStories(Stories{Query: "zz"}); got != `No Hacker News stories found for "zz".` {
		t.Error(got)
	}
}

const booksReply = `{"numFound": 260, "docs": [
 {"key": "/works/OL59798W", "title": "A Wizard of Earthsea", "author_name": ["Ursula K. Le Guin"], "first_publish_year": 1968, "edition_count": 87, "readinglog_count": 1072},
 {"key": "/works/OL59800W", "title": "The Left Hand of Darkness", "author_name": ["Ursula K. Le Guin"], "first_publish_year": 1969, "edition_count": 91, "readinglog_count": 692}
]}`

func TestBooks(t *testing.T) {
	f, base, hc := serve(t, map[string]string{"/search.json": booksReply})
	cs := connect(t, NewServer(Sources{Library: &Library{BaseURL: base, HTTP: hc}}))
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "books", Arguments: map[string]any{"author": "Ursula K. Le Guin", "sort": "readers", "limit": 2}})
	if err != nil || res.IsError {
		t.Fatalf("%v %s", err, text(res))
	}
	want := `1. A Wizard of Earthsea
   Ursula K. Le Guin · first published 1968 · 87 editions · 1,072 readers
   work_id OL59798W · https://openlibrary.org/works/OL59798W
2. The Left Hand of Darkness
   Ursula K. Le Guin · first published 1969 · 91 editions · 692 readers
   work_id OL59800W · https://openlibrary.org/works/OL59800W`
	if text(res) != want {
		t.Errorf("got\n%s\nwant\n%s", text(res), want)
	}
	q := f.find("/search.json").URL.Query()
	if q.Get("author") != "Ursula K. Le Guin" || q.Get("sort") != "readinglog" || q.Get("limit") != "2" || q.Has("q") {
		t.Errorf("query %v", q)
	}
	res, _ = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "books", Arguments: map[string]any{"sort": "readers"}})
	if !res.IsError || !strings.Contains(text(res), "at least one of") {
		t.Errorf("no criteria should fail: %s", text(res))
	}
}

func TestBook(t *testing.T) {
	_, base, hc := serve(t, map[string]string{
		// OL1W was merged into OL59800W.
		"/works/OL1W.json":       `{"type": {"key": "/type/redirect"}, "location": "/works/OL59800W"}`,
		"/works/OL59800W.json":   `{"key": "/works/OL59800W", "type": {"key": "/type/work"}, "title": "The Left Hand of Darkness", "first_publish_date": "1969", "description": {"type": "/type/text", "value": "A human envoy visits Gethen."}, "subjects": ["Science fiction", "Gender"], "authors": [{"author": {"key": "/authors/OL31353A"}}, {"author": {"key": "/authors/OL404A"}}]}`,
		"/authors/OL31353A.json": `{"name": "Ursula K. Le Guin"}`,
		// Edition without a work.
		"/books/OL9M.json": `{"key": "/books/OL9M", "title": "Orphan", "publish_date": "2001", "authors": [{"key": "/authors/OL31353A"}]}`,
	})
	cs := connect(t, NewServer(Sources{Library: &Library{BaseURL: base, HTTP: hc}}))
	call := func(id string) *mcp.CallToolResult {
		res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "book", Arguments: map[string]any{"work_id": id}})
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := call("OL1W")
	want := `# The Left Hand of Darkness
Ursula K. Le Guin, /authors/OL404A · first published 1969
https://openlibrary.org/works/OL59800W

A human envoy visits Gethen.

Subjects: Science fiction, Gender`
	if res.IsError || text(res) != want {
		t.Errorf("got\n%s\nwant\n%s", text(res), want)
	}
	if m, _ := res.StructuredContent.(map[string]any); m["redirected_from"] != "OL1W" || m["work_id"] != "OL59800W" {
		t.Errorf("structured %v", res.StructuredContent)
	}
	if res := call("OL9M"); res.IsError || !strings.HasPrefix(text(res), "# Orphan\nUrsula K. Le Guin · first published 2001\nhttps://openlibrary.org/books/OL9M") {
		t.Errorf("orphan edition: %s", text(res))
	}
	if res := call("OL404W"); !res.IsError || !strings.Contains(text(res), "no work with id OL404W") {
		t.Errorf("missing: %s", text(res))
	}
	if res := call("earthsea"); !res.IsError {
		t.Errorf("bad id accepted: %s", text(res))
	}
}

// All five tools are listed (the SDK sorts them by name), each saying what
// it is for.
func TestToolList(t *testing.T) {
	cs := connect(t, NewServer(NewSources()))
	var names []string
	for tool, err := range cs.Tools(context.Background(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tool.Name)
		if len(tool.Description) < 80 {
			t.Errorf("%s: description too thin to choose by: %q", tool.Name, tool.Description)
		}
	}
	want := slices.Sorted(slices.Values(Tools))
	if !slices.Equal(names, want) {
		t.Errorf("tools %v, want %v", names, want)
	}
}

// A source left out offers no tools.
func TestPartialSources(t *testing.T) {
	cs := connect(t, NewServer(Sources{HN: NewHN()}))
	var names []string
	for tool, err := range cs.Tools(context.Background(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tool.Name)
	}
	if !slices.Equal(names, []string{"hackernews"}) {
		t.Errorf("tools %v", names)
	}
}
