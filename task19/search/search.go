// Package search is the first tool of the pipeline: full-text search over
// Hacker News stories through the Algolia HN API. It returns plain text that
// any other tool can take as input; it knows nothing about what comes next.
package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task19/mcpserve"
)

const (
	ServerName    = "searchserver"
	ServerVersion = "0.1.0"

	DefaultBaseURL = "https://hn.algolia.com/api/v1"
	defaultLimit   = 10
	maxLimit       = 30
)

// Client talks to the Algolia HN API.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient() *Client {
	return &Client{BaseURL: DefaultBaseURL, HTTP: &http.Client{Timeout: 10 * time.Second}}
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

// Result is one search: the stories returned and how many matched in total.
type Result struct {
	Query  string
	Sort   string
	Total  int
	Hits   []Story
	Source string // the request URL, for the log
}

type apiResponse struct {
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
func (c *Client) Search(ctx context.Context, query string, limit int, sort string) (Result, error) {
	endpoint := "/search"
	if sort == "date" {
		endpoint = "/search_by_date"
	}
	q := url.Values{"query": {query}, "tags": {"story"}, "hitsPerPage": {strconv.Itoa(limit)}}
	u := c.BaseURL + endpoint + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return Result{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("HN search unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Result{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("HN search returned HTTP %d", resp.StatusCode)
	}
	var ar apiResponse
	if err := json.Unmarshal(body, &ar); err != nil {
		return Result{}, fmt.Errorf("decoding HN search response: %w", err)
	}

	r := Result{Query: query, Sort: sort, Total: ar.NbHits, Source: u}
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

// Format renders a result as the compact text the tool returns. Ask HN and
// other text posts have no url; the discussion link stands in for it.
func Format(r Result) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Hacker News search: %q · %d of %s matches · by %s\n", r.Query, len(r.Hits), thousands(r.Total), r.Sort)
	if len(r.Hits) == 0 {
		fmt.Fprintf(&b, "\nNo stories found for %q.", r.Query)
		return b.String()
	}
	for i, s := range r.Hits {
		link := s.URL
		if link == "" {
			link = s.Discussion()
		}
		date := "unknown date"
		if !s.CreatedAt.IsZero() {
			date = s.CreatedAt.Format("2006-01-02")
		}
		fmt.Fprintf(&b, "\n%d. %s\n   %s\n   %s points · %s comments · %s · %s\n",
			i+1, s.Title, link, thousands(s.Points), thousands(s.Comments), date, s.Discussion())
	}
	// No trailing newline: a model passing this on tends to drop it, and the
	// handoff would then differ from the original by that one byte.
	return strings.TrimRight(b.String(), "\n")
}

// ------------------------------------------------------------------- tool

type In struct {
	Query string `json:"query" jsonschema:"What to search for, e.g. 'rust async' or 'sqlite performance'."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many stories to return."`
	Sort  string `json:"sort,omitempty" jsonschema:"'relevance' for the best matches, 'date' for the newest first."`
}

type Out struct {
	Query    string `json:"query"`
	Sort     string `json:"sort"`
	Total    int    `json:"total_matches" jsonschema:"How many stories match in all."`
	Returned int    `json:"returned"`
}

func NewServer(c *Client) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "Hacker News search", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Full-text search over Hacker News stories."})
	s.AddReceivingMiddleware(mcpserve.NullArgsAsEmpty)

	schema := mcpserve.Schema[In]()
	schema.Required = []string{"query"}
	schema.Properties["query"].MinLength = mcpserve.Ptr(1)
	lim := schema.Properties["limit"]
	lim.Minimum, lim.Maximum, lim.Default = mcpserve.Ptr(1.0), mcpserve.Ptr(float64(maxLimit)), json.RawMessage("10")
	srt := schema.Properties["sort"]
	srt.Enum, srt.Default = []any{"relevance", "date"}, json.RawMessage(`"relevance"`)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "search",
		Title: "Search Hacker News",
		Description: "Search Hacker News stories by text. Returns a plain-text numbered list: title, link, " +
			"points, comments, date and discussion link for each story.",
		InputSchema: schema,
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: mcpserve.Ptr(true)},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, Out, error) {
		in.Query = strings.TrimSpace(in.Query)
		if in.Query == "" {
			return nil, Out{}, errors.New("query is empty")
		}
		if in.Limit == 0 {
			in.Limit = defaultLimit
		}
		if in.Sort == "" {
			in.Sort = "relevance"
		}
		r, err := c.Search(ctx, in.Query, in.Limit, in.Sort)
		if err != nil {
			return nil, Out{}, err
		}
		return mcpserve.Text(Format(r)), Out{Query: r.Query, Sort: r.Sort, Total: r.Total, Returned: len(r.Hits)}, nil
	})
	return s
}

func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
