package search

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const HNBaseURL = "https://hn.algolia.com/api/v1"

// HN talks to the Algolia Hacker News API.
type HN struct {
	BaseURL string
	HTTP    *http.Client
}

func NewHN() *HN {
	return &HN{BaseURL: HNBaseURL, HTTP: &http.Client{Timeout: 10 * time.Second}}
}

// Story is one hit, reduced to what the text result shows.
type Story struct {
	ID        string
	Title     string
	URL       string
	Author    string
	Points    int
	Comments  int
	CreatedAt time.Time
}

func (s Story) Discussion() string { return "https://news.ycombinator.com/item?id=" + s.ID }

// Stories is one search: the stories returned and how many matched in total.
type Stories struct {
	Query string
	Sort  string
	Total int
	Hits  []Story
}

type hnResponse struct {
	NbHits int `json:"nbHits"`
	Hits   []struct {
		ObjectID    string `json:"objectID"`
		Title       string `json:"title"`
		URL         string `json:"url"`
		Author      string `json:"author"`
		Points      *int   `json:"points"`
		NumComments *int   `json:"num_comments"`
		CreatedAt   string `json:"created_at"`
	} `json:"hits"`
}

// Search runs one query. sort is "relevance" or "date" (newest first).
func (c *HN) Search(ctx context.Context, query string, limit int, sort string) (Stories, error) {
	endpoint := "/search"
	if sort == "date" {
		endpoint = "/search_by_date"
	}
	q := url.Values{"query": {query}, "tags": {"story"}, "hitsPerPage": {strconv.Itoa(limit)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+endpoint+"?"+q.Encode(), nil)
	if err != nil {
		return Stories{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Stories{}, fmt.Errorf("HN search unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Stories{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Stories{}, fmt.Errorf("HN search returned HTTP %d", resp.StatusCode)
	}
	var ar hnResponse
	if err := json.Unmarshal(body, &ar); err != nil {
		return Stories{}, fmt.Errorf("decoding HN search response: %w", err)
	}

	r := Stories{Query: query, Sort: sort, Total: ar.NbHits}
	for _, h := range ar.Hits {
		if strings.TrimSpace(h.Title) == "" {
			continue
		}
		s := Story{ID: h.ObjectID, Title: strings.TrimSpace(h.Title), URL: h.URL, Author: h.Author}
		if h.Points != nil {
			s.Points = *h.Points
		}
		if h.NumComments != nil {
			s.Comments = *h.NumComments
		}
		s.CreatedAt, _ = time.Parse(time.RFC3339, h.CreatedAt)
		r.Hits = append(r.Hits, s)
	}
	return r, nil
}

// FormatStories renders stories as a numbered list, content only: counts go
// to the structured output. Ask HN and other text posts have no url; the
// discussion link stands in for it.
func FormatStories(r Stories) string {
	if len(r.Hits) == 0 {
		return fmt.Sprintf("No Hacker News stories found for %q.", r.Query)
	}
	var parts []string
	for i, s := range r.Hits {
		link := s.URL
		if link == "" {
			link = s.Discussion()
		}
		date := "unknown date"
		if !s.CreatedAt.IsZero() {
			date = s.CreatedAt.Format("2006-01-02")
		}
		parts = append(parts, fmt.Sprintf("%d. %s\n   %s\n   %s points · %s comments · %s · %s",
			i+1, s.Title, link, thousands(s.Points), thousands(s.Comments), date, s.Discussion()))
	}
	return strings.Join(parts, "\n")
}
