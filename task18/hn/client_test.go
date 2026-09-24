package hn

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fake serves a top list and items; ids absent from items return 500.
func fake(t *testing.T, top string, items map[string]string) *Client {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/topstories.json" {
			if top == "" {
				w.WriteHeader(503)
				return
			}
			fmt.Fprint(w, top)
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/item/"), ".json")
		body, ok := items[id]
		if !ok {
			w.WriteHeader(500)
			return
		}
		fmt.Fprint(w, body)
	}))
	t.Cleanup(ts.Close)
	c := NewClient()
	c.BaseURL = ts.URL
	return c
}

func TestTop(t *testing.T) {
	c := fake(t, `[1, 2, 3, 4, 5, 6, 7]`, map[string]string{
		"1": `{"id": 1, "type": "story", "title": "Link post", "url": "https://example.com", "by": "a", "score": 10, "descendants": 3, "time": 1758700000}`,
		"2": `{"id": 2, "type": "story", "title": "Ask HN: text post", "by": "b", "score": 5, "time": 1758700000}`,
		"3": `null`,
		"4": `{"id": 4, "deleted": true}`,
		"5": `{"id": 5, "type": "story", "title": "dead", "dead": true}`,
		// 6 fails with HTTP 500
		"7": `{"id": 7, "type": "job", "title": "YC company is hiring", "url": "https://example.com/jobs", "score": 1, "time": 1758700000}`,
	})
	snap, err := c.Top(context.Background(), 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Stories) != 3 || snap.Skipped != 4 {
		t.Fatalf("stories=%d skipped=%d, want 3 and 4", len(snap.Stories), snap.Skipped)
	}
	s := snap.Stories
	if s[0].ID != 1 || s[0].Rank != 1 || s[0].Comments != 3 || s[0].URL != "https://example.com" {
		t.Errorf("link post: %+v", s[0])
	}
	if s[1].URL != "https://news.ycombinator.com/item?id=2" {
		t.Errorf("text post links to its discussion, got %q", s[1].URL)
	}
	if s[2].ID != 7 || s[2].Rank != 7 {
		t.Errorf("ranks keep their gaps: %+v", s[2])
	}
}

func TestTopLimit(t *testing.T) {
	items := map[string]string{}
	for i := 1; i <= 5; i++ {
		items[fmt.Sprint(i)] = fmt.Sprintf(`{"id": %d, "title": "t%d", "time": 1}`, i, i)
	}
	snap, err := fake(t, `[1, 2, 3, 4, 5]`, items).Top(context.Background(), 2)
	if err != nil || len(snap.Stories) != 2 || snap.Stories[1].ID != 2 {
		t.Fatalf("limit: %+v err=%v", snap, err)
	}
}

func TestTopFailures(t *testing.T) {
	if _, err := fake(t, "", nil).Top(context.Background(), 5); err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Errorf("ranking unavailable: %v", err)
	}
	if _, err := fake(t, `[1, 2]`, nil).Top(context.Background(), 5); err == nil {
		t.Error("every item failing must fail the snapshot")
	}
	if snap, err := fake(t, `[]`, nil).Top(context.Background(), 5); err != nil || len(snap.Stories) != 0 {
		t.Errorf("empty list is not an error: %+v %v", snap, err)
	}
}
