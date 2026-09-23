// Package openlibrary wraps the Open Library REST API and exposes it as MCP
// tools. It is the only code in this module that knows Open Library exists.
package openlibrary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "https://openlibrary.org"
	userAgent      = "ai-advent-task17/0.1 (atabekmur@gmail.com)"
	maxRedirects   = 3
)

// ErrNotFound is returned when Open Library has no record for a key.
var ErrNotFound = errors.New("not found")

// Client talks to Open Library over HTTP.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient() *Client {
	return &Client{BaseURL: DefaultBaseURL, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// SearchParams mirrors the search_books tool input after validation.
type SearchParams struct {
	Query, Author, Title, Subject string
	YearFrom, YearTo              int
	Limit                         int
}

// SearchDoc is one hit from /search.json, restricted to the fields we request.
type SearchDoc struct {
	Key              string   `json:"key"`
	Title            string   `json:"title"`
	AuthorName       []string `json:"author_name"`
	FirstPublishYear int      `json:"first_publish_year"`
	EditionCount     int      `json:"edition_count"`
}

type SearchResponse struct {
	NumFound int         `json:"numFound"`
	Docs     []SearchDoc `json:"docs"`
}

const searchFields = "key,title,author_name,first_publish_year,edition_count"

// Search calls /search.json. A year range is expressed as a Solr clause on q,
// which is how Open Library's own search page does it.
func (c *Client) Search(ctx context.Context, p SearchParams) (*SearchResponse, error) {
	v := url.Values{}
	q := strings.TrimSpace(p.Query)
	if p.YearFrom != 0 || p.YearTo != 0 {
		from, to := "*", "*"
		if p.YearFrom != 0 {
			from = fmt.Sprint(p.YearFrom)
		}
		if p.YearTo != 0 {
			to = fmt.Sprint(p.YearTo)
		}
		q = strings.TrimSpace(q + fmt.Sprintf(" first_publish_year:[%s TO %s]", from, to))
	}
	if q != "" {
		v.Set("q", q)
	}
	if p.Author != "" {
		v.Set("author", p.Author)
	}
	if p.Title != "" {
		v.Set("title", p.Title)
	}
	if p.Subject != "" {
		v.Set("subject", p.Subject)
	}
	v.Set("fields", searchFields)
	v.Set("limit", fmt.Sprint(p.Limit))

	var out SearchResponse
	if err := c.getJSON(ctx, "/search.json?"+v.Encode(), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Work is a normalised /works/{id}.json record.
type Work struct {
	Key            string
	Title          string
	Description    string
	Subjects       []string
	AuthorKeys     []string
	FirstPublished string
	RedirectedFrom []string // keys we passed through, oldest first
}

type rawWork struct {
	Key              string               `json:"key"`
	Type             struct{ Key string } `json:"type"`
	Location         string               `json:"location"`
	Title            string               `json:"title"`
	Description      json.RawMessage      `json:"description"`
	Subjects         []string             `json:"subjects"`
	FirstPublishDate string               `json:"first_publish_date"`
	Authors          []authorRef          `json:"authors"`
}

// authorRef decodes both author shapes Open Library uses: works nest the key
// ({"author": {"key": …}}), editions don't ({"key": …}).
type authorRef struct{ Key string }

func (a *authorRef) UnmarshalJSON(b []byte) error {
	var v struct {
		Key    string `json:"key"`
		Author struct {
			Key string `json:"key"`
		} `json:"author"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	a.Key = v.Key
	if v.Author.Key != "" {
		a.Key = v.Author.Key
	}
	return nil
}

// Work fetches a work by id (e.g. "OL59798W"), following merge redirects.
//
// An edition id ("OL7524720M") is accepted too: Open Library's search index
// occasionally files an edition under /works/, so the model will be handed
// such ids. The edition is followed to its work when it has one, and returned
// as-is when it is an orphan.
func (c *Client) Work(ctx context.Context, id string) (*Work, error) {
	key := "/works/" + id
	var passed []string
	if strings.HasSuffix(id, "M") {
		ed, err := c.edition(ctx, id)
		if err != nil {
			return nil, err
		}
		if len(ed.Works) == 0 || ed.Works[0].Key == "" {
			return ed.asWork(), nil
		}
		passed = append(passed, ed.Key)
		key = ed.Works[0].Key
	}
	for hop := 0; ; hop++ {
		var raw rawWork
		if err := c.getJSON(ctx, key+".json", &raw); err != nil {
			return nil, err
		}
		if raw.Type.Key == "/type/redirect" {
			if hop == maxRedirects {
				return nil, fmt.Errorf("%s: more than %d redirects", id, maxRedirects)
			}
			if raw.Location == "" {
				return nil, fmt.Errorf("%s: redirect without a location", key)
			}
			passed = append(passed, key)
			key = raw.Location
			continue
		}
		if raw.Type.Key == "/type/delete" {
			return nil, fmt.Errorf("%s: %w (deleted)", key, ErrNotFound)
		}
		w := &Work{
			Key:            raw.Key,
			Title:          raw.Title,
			Description:    textValue(raw.Description),
			Subjects:       raw.Subjects,
			FirstPublished: raw.FirstPublishDate,
			RedirectedFrom: passed,
		}
		w.AuthorKeys = authorKeys(raw.Authors)
		return w, nil
	}
}

type rawEdition struct {
	rawWork
	PublishDate string                 `json:"publish_date"`
	Works       []struct{ Key string } `json:"works"`
}

func (c *Client) edition(ctx context.Context, id string) (*rawEdition, error) {
	var ed rawEdition
	if err := c.getJSON(ctx, "/books/"+id+".json", &ed); err != nil {
		return nil, err
	}
	if ed.Key == "" {
		ed.Key = "/books/" + id
	}
	return &ed, nil
}

func (e *rawEdition) asWork() *Work {
	w := &Work{
		Key:            e.Key,
		Title:          e.Title,
		Description:    textValue(e.Description),
		Subjects:       e.Subjects,
		FirstPublished: e.PublishDate,
	}
	w.AuthorKeys = authorKeys(e.Authors)
	return w
}

func authorKeys(refs []authorRef) []string {
	var keys []string
	for _, a := range refs {
		if strings.HasPrefix(a.Key, "/authors/") {
			keys = append(keys, a.Key)
		}
	}
	return keys
}

// AuthorName resolves "/authors/OL79034A" to a display name.
func (c *Client) AuthorName(ctx context.Context, key string) (string, error) {
	var a struct {
		Name         string `json:"name"`
		PersonalName string `json:"personal_name"`
	}
	if err := c.getJSON(ctx, key+".json", &a); err != nil {
		return "", err
	}
	if a.Name != "" {
		return a.Name, nil
	}
	if a.PersonalName != "" {
		return a.PersonalName, nil
	}
	return "", fmt.Errorf("%s: no name", key)
}

// textValue normalises Open Library's two text shapes: a bare string, or
// {"type": "/type/text", "value": "..."}.
func textValue(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return obj.Value
	}
	return ""
}

func (c *Client) getJSON(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("open library unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("reading open library response: %w", err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%s: %w", strings.TrimSuffix(strings.SplitN(path, "?", 2)[0], ".json"), ErrNotFound)
	case resp.StatusCode >= 400:
		return fmt.Errorf("open library returned HTTP %d for %s", resp.StatusCode, strings.SplitN(path, "?", 2)[0])
	}
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("decoding open library response: %w", err)
	}
	return nil
}
