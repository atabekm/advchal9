package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The Open Library client comes from task 17, which returned JSON; here the
// tools return text, so the formatting below is new.

const (
	LibraryBaseURL = "https://openlibrary.org"
	librarySite    = "https://openlibrary.org"

	maxRedirects    = 3
	maxDescription  = 3000
	maxSubjects     = 12
	maxAuthorLookup = 5
)

// ErrNotFound is returned when Open Library has no record for a key.
var ErrNotFound = errors.New("not found")

// Works end in W. Editions (M) are accepted because search sometimes files
// one under /works/; Work resolves it to its work.
var WorkIDPattern = regexp.MustCompile(`OL[0-9]+[WM]`)

// Library talks to Open Library.
type Library struct {
	BaseURL string
	HTTP    *http.Client
}

func NewLibrary() *Library {
	return &Library{BaseURL: LibraryBaseURL, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// BookQuery is what the books tool searches by; at least one field is set.
type BookQuery struct {
	Query, Author, Title, Subject string
	Sort                          string // "relevance", "readers", "editions", "new", "old"
	Limit                         int
}

// Book is one search hit.
type Book struct {
	WorkID           string
	Title            string
	Authors          []string
	FirstPublishYear int
	Editions         int
	Readers          int // people with it on a reading log: Open Library's popularity signal
}

func (b Book) URL() string { return pageURL(b.WorkID) }

type Books struct {
	Total int
	Books []Book
}

// Open Library's own names for the sorts the tool offers.
var bookSorts = map[string]string{"readers": "readinglog", "editions": "editions", "new": "new", "old": "old"}

func (c *Library) Search(ctx context.Context, q BookQuery) (Books, error) {
	v := url.Values{}
	for k, s := range map[string]string{"q": q.Query, "author": q.Author, "title": q.Title, "subject": q.Subject} {
		if s = strings.TrimSpace(s); s != "" {
			v.Set(k, s)
		}
	}
	if s := bookSorts[q.Sort]; s != "" {
		v.Set("sort", s)
	}
	v.Set("fields", "key,title,author_name,first_publish_year,edition_count,readinglog_count")
	v.Set("limit", fmt.Sprint(q.Limit))
	var raw struct {
		NumFound int `json:"numFound"`
		Docs     []struct {
			Key              string   `json:"key"`
			Title            string   `json:"title"`
			AuthorName       []string `json:"author_name"`
			FirstPublishYear int      `json:"first_publish_year"`
			EditionCount     int      `json:"edition_count"`
			ReadingLogCount  int      `json:"readinglog_count"`
		} `json:"docs"`
	}
	if err := c.getJSON(ctx, "/search.json?"+v.Encode(), &raw); err != nil {
		return Books{}, err
	}
	out := Books{Total: raw.NumFound}
	for _, d := range raw.Docs {
		out.Books = append(out.Books, Book{
			WorkID: path.Base(d.Key), Title: d.Title, Authors: d.AuthorName,
			FirstPublishYear: d.FirstPublishYear, Editions: d.EditionCount, Readers: d.ReadingLogCount,
		})
		if len(out.Books) == q.Limit {
			break
		}
	}
	return out, nil
}

// Work is one work with its author names resolved.
type Work struct {
	ID             string
	Title          string
	Authors        []string
	Description    string
	Subjects       []string
	FirstPublished string
	RedirectedFrom string // the id asked for, when it led elsewhere
}

type rawWork struct {
	Key              string                 `json:"key"`
	Type             struct{ Key string }   `json:"type"`
	Location         string                 `json:"location"`
	Title            string                 `json:"title"`
	Description      json.RawMessage        `json:"description"`
	Subjects         []string               `json:"subjects"`
	FirstPublishDate string                 `json:"first_publish_date"`
	PublishDate      string                 `json:"publish_date"`
	Authors          []authorRef            `json:"authors"`
	Works            []struct{ Key string } `json:"works"`
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

// Work fetches a work by id ("OL59798W"), following merge redirects. An
// edition id ("OL7524720M") leads to its work, or stands in for one when it
// has none.
func (c *Library) Work(ctx context.Context, id string) (Work, error) {
	key := "/works/" + id
	moved := false
	var raw rawWork
	if strings.HasSuffix(id, "M") {
		if err := c.getJSON(ctx, "/books/"+id+".json", &raw); err != nil {
			return Work{}, err
		}
		if len(raw.Works) == 0 || raw.Works[0].Key == "" {
			raw.FirstPublishDate = raw.PublishDate
			return c.finish(ctx, "/books/"+id, raw, ""), nil
		}
		key, moved = raw.Works[0].Key, true
	}
	for hop := 0; ; hop++ {
		raw = rawWork{}
		if err := c.getJSON(ctx, key+".json", &raw); err != nil {
			return Work{}, err
		}
		switch raw.Type.Key {
		case "/type/redirect":
			if hop == maxRedirects || raw.Location == "" {
				return Work{}, fmt.Errorf("%s: unfollowable redirect", id)
			}
			key, moved = raw.Location, true
			continue
		case "/type/delete":
			return Work{}, fmt.Errorf("%s: %w (deleted)", key, ErrNotFound)
		}
		from := ""
		if moved {
			from = id
		}
		return c.finish(ctx, key, raw, from), nil
	}
}

func (c *Library) finish(ctx context.Context, key string, raw rawWork, from string) Work {
	w := Work{
		ID: path.Base(key), Title: raw.Title, Description: strings.TrimSpace(textValue(raw.Description)),
		Subjects: raw.Subjects, FirstPublished: raw.FirstPublishDate, RedirectedFrom: from,
	}
	var keys []string
	for _, a := range raw.Authors {
		if strings.HasPrefix(a.Key, "/authors/") && len(keys) < maxAuthorLookup {
			keys = append(keys, a.Key)
		}
	}
	w.Authors = c.authorNames(ctx, keys)
	return w
}

// authorNames looks names up side by side. A failed lookup degrades to the
// raw key: one missing author record shouldn't sink the call.
func (c *Library) authorNames(ctx context.Context, keys []string) []string {
	names := make([]string, len(keys))
	var wg sync.WaitGroup
	for i, k := range keys {
		wg.Go(func() {
			var a struct {
				Name         string `json:"name"`
				PersonalName string `json:"personal_name"`
			}
			names[i] = k
			if c.getJSON(ctx, k+".json", &a) == nil {
				if a.Name != "" {
					names[i] = a.Name
				} else if a.PersonalName != "" {
					names[i] = a.PersonalName
				}
			}
		})
	}
	wg.Wait()
	return names
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

func (c *Library) getJSON(ctx context.Context, p string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+p, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("Open Library unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("reading Open Library response: %w", err)
	}
	bare := strings.TrimSuffix(strings.SplitN(p, "?", 2)[0], ".json")
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%s: %w", bare, ErrNotFound)
	case resp.StatusCode >= 400:
		return fmt.Errorf("Open Library returned HTTP %d for %s", resp.StatusCode, bare)
	}
	if err := json.Unmarshal(body, into); err != nil {
		return fmt.Errorf("decoding Open Library response: %w", err)
	}
	return nil
}

// pageURL links a work (…W) or an edition (…M) to its page on the site.
func pageURL(id string) string {
	if strings.HasSuffix(id, "M") {
		return librarySite + "/books/" + id
	}
	return librarySite + "/works/" + id
}

// FormatBooks is a numbered list; each entry carries the work id the book
// tool takes, and the title exactly as Open Library has it.
func FormatBooks(q BookQuery, r Books) string {
	if len(r.Books) == 0 {
		return "No books found on Open Library for " + describe(q) + "."
	}
	var parts []string
	for i, b := range r.Books {
		facts := []string{}
		if len(b.Authors) > 0 {
			facts = append(facts, strings.Join(b.Authors, ", "))
		}
		if b.FirstPublishYear != 0 {
			facts = append(facts, fmt.Sprintf("first published %d", b.FirstPublishYear))
		}
		facts = append(facts, fmt.Sprintf("%s editions", thousands(b.Editions)), fmt.Sprintf("%s readers", thousands(b.Readers)))
		parts = append(parts, fmt.Sprintf("%d. %s\n   %s\n   work_id %s · %s",
			i+1, b.Title, strings.Join(facts, " · "), b.WorkID, b.URL()))
	}
	return strings.Join(parts, "\n")
}

// FormatWork is one work as text: title, authors, date, link, description
// and subjects.
func FormatWork(w Work) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n", w.Title)
	var facts []string
	if len(w.Authors) > 0 {
		facts = append(facts, strings.Join(w.Authors, ", "))
	}
	if w.FirstPublished != "" {
		facts = append(facts, "first published "+w.FirstPublished)
	}
	if len(facts) > 0 {
		b.WriteString(strings.Join(facts, " · ") + "\n")
	}
	b.WriteString(pageURL(w.ID))
	if d := w.Description; d != "" {
		if r := []rune(d); len(r) > maxDescription {
			d = strings.TrimSpace(string(r[:maxDescription])) + " […]"
		}
		b.WriteString("\n\n" + d)
	} else {
		b.WriteString("\n\n(Open Library has no description of this work.)")
	}
	if s := w.Subjects; len(s) > 0 {
		if len(s) > maxSubjects {
			s = s[:maxSubjects]
		}
		b.WriteString("\n\nSubjects: " + strings.Join(s, ", "))
	}
	return b.String()
}

func describe(q BookQuery) string {
	var parts []string
	for _, f := range [][2]string{{"query", q.Query}, {"author", q.Author}, {"title", q.Title}, {"subject", q.Subject}} {
		if f[1] != "" {
			parts = append(parts, fmt.Sprintf("%s %q", f[0], f[1]))
		}
	}
	return strings.Join(parts, ", ")
}
