package openlibrary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"sync"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	ServerName    = "olserver"
	ServerVersion = "0.1.0"

	siteURL         = "https://openlibrary.org"
	maxDescription  = 1500
	maxSubjects     = 10
	maxAuthorLookup = 5
)

// ---------------------------------------------------------------- search_books

type SearchBooksIn struct {
	Query    string `json:"query,omitempty" jsonschema:"Free-text search across titles, authors and subjects."`
	Author   string `json:"author,omitempty" jsonschema:"Author name, e.g. 'Ursula K. Le Guin'."`
	Title    string `json:"title,omitempty" jsonschema:"Words from the book title."`
	Subject  string `json:"subject,omitempty" jsonschema:"Subject or genre, e.g. 'science fiction'."`
	YearFrom int    `json:"year_from,omitempty" jsonschema:"Earliest first-publication year, inclusive."`
	YearTo   int    `json:"year_to,omitempty" jsonschema:"Latest first-publication year, inclusive."`
	Limit    int    `json:"limit,omitempty" jsonschema:"Maximum number of books to return."`
}

type Book struct {
	WorkID           string   `json:"work_id" jsonschema:"Open Library work id; pass to get_work for details."`
	Title            string   `json:"title"`
	Authors          []string `json:"authors"`
	FirstPublishYear int      `json:"first_publish_year,omitempty"`
	EditionCount     int      `json:"edition_count"`
	URL              string   `json:"url"`
}

type SearchBooksOut struct {
	TotalFound int    `json:"total_found" jsonschema:"Total matches in Open Library, not just the ones returned."`
	Returned   int    `json:"returned"`
	Books      []Book `json:"books"`
}

// ------------------------------------------------------------------- get_work

type GetWorkIn struct {
	WorkID string `json:"work_id" jsonschema:"Open Library work id such as 'OL59798W', exactly as returned by search_books (edition ids ending in M are accepted too). '/works/OL59798W' and full URLs also work."`
}

type WorkOut struct {
	WorkID         string   `json:"work_id"`
	Title          string   `json:"title"`
	Authors        []string `json:"authors"`
	FirstPublished string   `json:"first_published,omitempty"`
	Description    string   `json:"description,omitempty"`
	Subjects       []string `json:"subjects"`
	URL            string   `json:"url"`
	RedirectedFrom string   `json:"redirected_from,omitempty" jsonschema:"The id that was asked for, when it resolved to a different record (a merged work, or an edition id resolved to its work)."`
}

// ------------------------------------------------------------------- server

// NewServer builds the MCP server with both tools registered against c.
func NewServer(c *Client) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{
		Name:    ServerName,
		Title:   "Open Library",
		Version: ServerVersion,
	}, &mcp.ServerOptions{
		Instructions: "Book lookup backed by openlibrary.org. Use search_books to find works, " +
			"then get_work with a work_id for description and subjects.",
	})

	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: ptr(true)}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "search_books",
		Title: "Search books",
		Description: "Search the Open Library catalogue. Provide at least one of query, author, " +
			"title or subject; optionally narrow by first-publication year. Returns matching " +
			"works with work_id, authors, first publication year and edition count.",
		InputSchema: searchSchema(),
		Annotations: readOnly,
	}, searchHandler(c))

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_work",
		Title: "Get work details",
		Description: "Fetch one Open Library work by id: title, author names, description, " +
			"subjects and first publication date. Follows merged-record redirects.",
		InputSchema: workSchema(),
		Annotations: readOnly,
	}, workHandler(c))

	return s
}

// The inferred schemas carry types and descriptions from struct tags; bounds,
// defaults and patterns can't be expressed as tags, so they are added here.
// They travel to the model verbatim, so they constrain it as well as us.

func searchSchema() *jsonschema.Schema {
	s := mustFor[SearchBooksIn]()
	lim := s.Properties["limit"]
	lim.Minimum, lim.Maximum = ptr(1.0), ptr(20.0)
	lim.Default = json.RawMessage("5")
	for _, k := range []string{"year_from", "year_to"} {
		s.Properties[k].Minimum, s.Properties[k].Maximum = ptr(-3000.0), ptr(2100.0)
	}
	return s
}

func workSchema() *jsonschema.Schema {
	s := mustFor[GetWorkIn]()
	s.Properties["work_id"].Pattern = workIDPattern.String()
	return s
}

// Works end in W. Editions (M) are accepted because search sometimes returns
// them under /works/; get_work resolves them to their work.
var workIDPattern = regexp.MustCompile(`OL[0-9]+[WM]`)

func searchHandler(c *Client) mcp.ToolHandlerFor[SearchBooksIn, SearchBooksOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in SearchBooksIn) (*mcp.CallToolResult, SearchBooksOut, error) {
		var zero SearchBooksOut
		in.Query, in.Author = strings.TrimSpace(in.Query), strings.TrimSpace(in.Author)
		in.Title, in.Subject = strings.TrimSpace(in.Title), strings.TrimSpace(in.Subject)
		if in.Query == "" && in.Author == "" && in.Title == "" && in.Subject == "" {
			return nil, zero, errors.New("provide at least one of query, author, title or subject")
		}
		if in.YearFrom != 0 && in.YearTo != 0 && in.YearFrom > in.YearTo {
			return nil, zero, fmt.Errorf("year_from (%d) is after year_to (%d)", in.YearFrom, in.YearTo)
		}
		if in.Limit == 0 {
			in.Limit = 5
		}
		resp, err := c.Search(ctx, SearchParams{
			Query: in.Query, Author: in.Author, Title: in.Title, Subject: in.Subject,
			YearFrom: in.YearFrom, YearTo: in.YearTo, Limit: in.Limit,
		})
		if err != nil {
			return nil, zero, err
		}
		out := SearchBooksOut{TotalFound: resp.NumFound, Books: []Book{}}
		for _, d := range resp.Docs {
			id := path.Base(d.Key)
			authors := d.AuthorName
			if authors == nil {
				authors = []string{}
			}
			out.Books = append(out.Books, Book{
				WorkID:           id,
				Title:            d.Title,
				Authors:          authors,
				FirstPublishYear: d.FirstPublishYear,
				EditionCount:     d.EditionCount,
				URL:              pageURL(id),
			})
			if len(out.Books) == in.Limit {
				break
			}
		}
		out.Returned = len(out.Books)
		return nil, out, nil
	}
}

func workHandler(c *Client) mcp.ToolHandlerFor[GetWorkIn, WorkOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in GetWorkIn) (*mcp.CallToolResult, WorkOut, error) {
		var zero WorkOut
		id := workIDPattern.FindString(in.WorkID)
		if id == "" {
			return nil, zero, fmt.Errorf("%q is not an Open Library work id (expected e.g. OL59798W)", in.WorkID)
		}
		w, err := c.Work(ctx, id)
		if errors.Is(err, ErrNotFound) {
			return nil, zero, fmt.Errorf("no work with id %s", id)
		}
		if err != nil {
			return nil, zero, err
		}
		gotID := path.Base(w.Key)
		out := WorkOut{
			WorkID:         gotID,
			Title:          w.Title,
			Authors:        resolveAuthors(ctx, c, w.AuthorKeys),
			FirstPublished: w.FirstPublished,
			Description:    truncate(strings.TrimSpace(w.Description), maxDescription),
			Subjects:       w.Subjects,
			URL:            pageURL(gotID),
		}
		if len(out.Subjects) > maxSubjects {
			out.Subjects = out.Subjects[:maxSubjects]
		}
		if out.Subjects == nil {
			out.Subjects = []string{}
		}
		if len(w.RedirectedFrom) > 0 {
			out.RedirectedFrom = id
		}
		return nil, out, nil
	}
}

// resolveAuthors looks names up concurrently. A failed lookup degrades to the
// raw key: one missing author record shouldn't sink the whole call.
func resolveAuthors(ctx context.Context, c *Client, keys []string) []string {
	if len(keys) > maxAuthorLookup {
		keys = keys[:maxAuthorLookup]
	}
	names := make([]string, len(keys))
	var wg sync.WaitGroup
	for i, k := range keys {
		wg.Go(func() {
			if n, err := c.AuthorName(ctx, k); err == nil {
				names[i] = n
			} else {
				names[i] = k
			}
		})
	}
	wg.Wait()
	return names
}

// pageURL links a work (…W) or an edition (…M) to its page on the site.
func pageURL(id string) string {
	if strings.HasSuffix(id, "M") {
		return siteURL + "/books/" + id
	}
	return siteURL + "/works/" + id
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n])) + "…"
}

func mustFor[T any]() *jsonschema.Schema {
	s, err := jsonschema.For[T](nil)
	if err != nil {
		panic(err)
	}
	return s
}

func ptr[T any](v T) *T { return &v }
