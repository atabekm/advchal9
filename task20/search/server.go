package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/mcpserve"
)

const (
	ServerName    = "searchserver"
	ServerVersion = "0.3.0"
)

// Sources are the three backends; a nil one's tools are not offered. The
// tools overlap on purpose: a request
// about a topic, a discussion or a book each has one right tool, and the
// descriptions say which.
type Sources struct {
	Wiki    *Wiki
	HN      *HN
	Library *Library
}

func NewSources() Sources { return Sources{Wiki: NewWiki(), HN: NewHN(), Library: NewLibrary()} }

// Tools lists the tool names.
var Tools = []string{"wikipedia", "wiki_article", "hackernews", "books", "book"}

func NewServer(src Sources) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "Search · Wikipedia, Hacker News, Open Library", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Read-only search over Wikipedia articles, Hacker News stories and the Open Library book catalogue."})
	s.AddReceivingMiddleware(mcpserve.NullArgsAsEmpty)
	ro := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: mcpserve.Ptr(true)}

	if src.Wiki != nil {
		addWiki(s, src.Wiki, ro)
	}
	if src.HN != nil {
		addHN(s, src.HN, ro)
	}
	if src.Library != nil {
		addLibrary(s, src.Library, ro)
	}
	return s
}

func addWiki(s *mcp.Server, wiki *Wiki, ro *mcp.ToolAnnotations) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "wikipedia",
		Title: "Search Wikipedia",
		Description: "Full-text search over English Wikipedia for a topic, when you don't know the exact article title. " +
			"Returns the best-matching articles as plain text: for each, its title, link and text (the lead section, " +
			"or the whole article with detail 'full'), cut to at most 'chars' characters and marked […] where shortened. " +
			"For encyclopedic facts: history, definitions, background.",
		InputSchema: wikiSchema(),
		Annotations: ro,
	}, wikiHandler(wiki))

	mcp.AddTool(s, &mcp.Tool{
		Name:  "wiki_article",
		Title: "Wikipedia article by title",
		Description: "Fetch one Wikipedia article whose title you already know, e.g. a title another tool returned. " +
			"Follows redirects. Returns the title, link and the article's whole text as plain text, cut to 'chars'. " +
			"Fails for a title with no article or a disambiguation page; then search with wikipedia instead.",
		InputSchema: articleSchema(),
		Annotations: ro,
	}, articleHandler(wiki))
}

func addHN(s *mcp.Server, hn *HN, ro *mcp.ToolAnnotations) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "hackernews",
		Title: "Search Hacker News",
		Description: "Search Hacker News stories: what the tech community posted and discussed. Returns a numbered list " +
			"with each story's title, link, points, comment count, date and discussion link; not the linked pages' text. " +
			"For news, reactions and discussions, not for encyclopedic facts.",
		InputSchema: hnSchema(),
		Annotations: ro,
	}, hnHandler(hn))
}

func addLibrary(s *mcp.Server, lib *Library, ro *mcp.ToolAnnotations) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "books",
		Title: "Search books",
		Description: "Search the Open Library book catalogue by any of query, author, title or subject. Returns a " +
			"numbered list: each book's exact title, authors, first publication year, edition and reader counts, and " +
			"its work_id for the book tool. Sort 'readers' puts the most-read first.",
		InputSchema: booksSchema(),
		Annotations: ro,
	}, booksHandler(lib))

	mcp.AddTool(s, &mcp.Tool{
		Name:  "book",
		Title: "Book details",
		Description: "Fetch one Open Library work by the work_id the books tool returned: title, authors, first " +
			"publication date, link, the catalogue's description and subjects, as plain text.",
		InputSchema: bookSchema(),
		Annotations: ro,
	}, bookHandler(lib))
}

// ------------------------------------------------------------- wikipedia

const (
	defaultLimit = 5
	maxLimit     = 10
	defaultChars = 2000
	minChars     = 200
	maxChars     = 5000
)

type WikiIn struct {
	Query  string `json:"query" jsonschema:"What to search for, e.g. 'async programming in Rust' or 'history of SQLite'."`
	Limit  int    `json:"limit,omitempty" jsonschema:"How many articles to return."`
	Detail string `json:"detail,omitempty" jsonschema:"'intro' for each article's lead section, 'full' for its whole text (both cut to 'chars')."`
	Chars  int    `json:"chars,omitempty" jsonschema:"Maximum characters of text per article; longer text is cut at a paragraph or sentence."`
}

type WikiOut struct {
	Query     string `json:"query"`
	Detail    string `json:"detail"`
	Total     int    `json:"total_matches" jsonschema:"How many articles match in all."`
	Returned  int    `json:"returned"`
	Truncated int    `json:"truncated" jsonschema:"How many of the returned articles were cut to 'chars' (marked […])."`
}

func wikiSchema() any {
	schema := mcpserve.Schema[WikiIn]()
	schema.Required = []string{"query"}
	schema.Properties["query"].MinLength = mcpserve.Ptr(1)
	lim := schema.Properties["limit"]
	lim.Minimum, lim.Maximum, lim.Default = mcpserve.Ptr(1.0), mcpserve.Ptr(float64(maxLimit)), json.RawMessage(strconv.Itoa(defaultLimit))
	det := schema.Properties["detail"]
	det.Enum, det.Default = []any{"intro", "full"}, json.RawMessage(`"intro"`)
	ch := schema.Properties["chars"]
	ch.Minimum, ch.Maximum, ch.Default = mcpserve.Ptr(float64(minChars)), mcpserve.Ptr(float64(maxChars)), json.RawMessage(strconv.Itoa(defaultChars))
	return schema
}

func wikiHandler(c *Wiki) mcp.ToolHandlerFor[WikiIn, WikiOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in WikiIn) (*mcp.CallToolResult, WikiOut, error) {
		in.Query = strings.TrimSpace(in.Query)
		if in.Query == "" {
			return nil, WikiOut{}, errors.New("query is empty")
		}
		if in.Limit == 0 {
			in.Limit = defaultLimit
		}
		if in.Detail == "" {
			in.Detail = "intro"
		}
		if in.Chars == 0 {
			in.Chars = defaultChars
		}
		r, err := c.Search(ctx, in.Query, in.Limit, in.Detail)
		if err != nil {
			return nil, WikiOut{}, err
		}
		text, truncated := FormatArticles(r, in.Chars)
		return mcpserve.Text(text), WikiOut{Query: r.Query, Detail: r.Detail, Total: r.Total, Returned: len(r.Articles), Truncated: truncated}, nil
	}
}

// ---------------------------------------------------------- wiki_article

const (
	// The model carries what this returns into the next call, token by
	// token; 20,000 characters made that slow, and made the model write its
	// own excerpt instead.
	defaultArticleChars = 6000
	minArticleChars     = 500
	maxArticleChars     = 12000
)

type ArticleIn struct {
	Title string `json:"title" jsonschema:"The article's title, e.g. 'The Left Hand of Darkness'."`
	Chars int    `json:"chars,omitempty" jsonschema:"Maximum characters of text; longer text is cut at a paragraph or sentence."`
}

type ArticleOut struct {
	Title          string `json:"title"`
	URL            string `json:"url"`
	RedirectedFrom string `json:"redirected_from,omitempty" jsonschema:"The title asked for, when it redirected to this article."`
	Chars          int    `json:"chars" jsonschema:"The article's full length in characters."`
	Truncated      bool   `json:"truncated"`
}

func articleSchema() any {
	schema := mcpserve.Schema[ArticleIn]()
	schema.Required = []string{"title"}
	schema.Properties["title"].MinLength = mcpserve.Ptr(1)
	ch := schema.Properties["chars"]
	ch.Minimum, ch.Maximum, ch.Default = mcpserve.Ptr(float64(minArticleChars)), mcpserve.Ptr(float64(maxArticleChars)), json.RawMessage(strconv.Itoa(defaultArticleChars))
	return schema
}

func articleHandler(c *Wiki) mcp.ToolHandlerFor[ArticleIn, ArticleOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in ArticleIn) (*mcp.CallToolResult, ArticleOut, error) {
		in.Title = strings.TrimSpace(in.Title)
		if in.Title == "" {
			return nil, ArticleOut{}, errors.New("title is empty")
		}
		if in.Chars == 0 {
			in.Chars = defaultArticleChars
		}
		a, err := c.Article(ctx, in.Title)
		if errors.Is(err, ErrNoArticle) {
			return nil, ArticleOut{}, fmt.Errorf("%v; search with the wikipedia tool to find the exact title", err)
		}
		if err != nil {
			return nil, ArticleOut{}, err
		}
		text, cut := Truncate(a.Text, in.Chars)
		if cut {
			text += " […]"
		}
		out := ArticleOut{Title: a.Title, URL: a.URL, RedirectedFrom: a.RedirectedFrom, Chars: len([]rune(a.Text)), Truncated: cut}
		return mcpserve.Text(fmt.Sprintf("# %s\n%s\n\n%s", a.Title, a.URL, text)), out, nil
	}
}

// ------------------------------------------------------------ hackernews

const (
	defaultStories = 10
	maxStories     = 30
)

type HNIn struct {
	Query string `json:"query" jsonschema:"What to search for, e.g. 'rust async' or 'sqlite performance'."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many stories to return."`
	Sort  string `json:"sort,omitempty" jsonschema:"'relevance' for the best matches, 'date' for the newest first."`
}

type HNOut struct {
	Query    string `json:"query"`
	Sort     string `json:"sort"`
	Total    int    `json:"total_matches" jsonschema:"How many stories match in all."`
	Returned int    `json:"returned"`
}

func hnSchema() any {
	schema := mcpserve.Schema[HNIn]()
	schema.Required = []string{"query"}
	schema.Properties["query"].MinLength = mcpserve.Ptr(1)
	lim := schema.Properties["limit"]
	lim.Minimum, lim.Maximum, lim.Default = mcpserve.Ptr(1.0), mcpserve.Ptr(float64(maxStories)), json.RawMessage(strconv.Itoa(defaultStories))
	srt := schema.Properties["sort"]
	srt.Enum, srt.Default = []any{"relevance", "date"}, json.RawMessage(`"relevance"`)
	return schema
}

func hnHandler(c *HN) mcp.ToolHandlerFor[HNIn, HNOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in HNIn) (*mcp.CallToolResult, HNOut, error) {
		in.Query = strings.TrimSpace(in.Query)
		if in.Query == "" {
			return nil, HNOut{}, errors.New("query is empty")
		}
		if in.Limit == 0 {
			in.Limit = defaultStories
		}
		if in.Sort == "" {
			in.Sort = "relevance"
		}
		r, err := c.Search(ctx, in.Query, in.Limit, in.Sort)
		if err != nil {
			return nil, HNOut{}, err
		}
		return mcpserve.Text(FormatStories(r)), HNOut{Query: r.Query, Sort: r.Sort, Total: r.Total, Returned: len(r.Hits)}, nil
	}
}

// ----------------------------------------------------------------- books

const (
	defaultBooks = 5
	maxBooks     = 20
)

type BooksIn struct {
	Query   string `json:"query,omitempty" jsonschema:"Free-text search across titles, authors and subjects."`
	Author  string `json:"author,omitempty" jsonschema:"Author name, e.g. 'Ursula K. Le Guin'."`
	Title   string `json:"title,omitempty" jsonschema:"Words from the book's title."`
	Subject string `json:"subject,omitempty" jsonschema:"Subject or genre, e.g. 'science fiction'."`
	Sort    string `json:"sort,omitempty" jsonschema:"'relevance'; 'readers' (most-read first); 'editions' (most editions first); 'new' or 'old' by first publication."`
	Limit   int    `json:"limit,omitempty" jsonschema:"Maximum number of books to return."`
}

type BooksOut struct {
	Total    int      `json:"total_found" jsonschema:"Total matches in Open Library, not just the ones returned."`
	Returned int      `json:"returned"`
	WorkIDs  []string `json:"work_ids"`
}

func booksSchema() any {
	schema := mcpserve.Schema[BooksIn]()
	lim := schema.Properties["limit"]
	lim.Minimum, lim.Maximum, lim.Default = mcpserve.Ptr(1.0), mcpserve.Ptr(float64(maxBooks)), json.RawMessage(strconv.Itoa(defaultBooks))
	srt := schema.Properties["sort"]
	srt.Enum, srt.Default = []any{"relevance", "readers", "editions", "new", "old"}, json.RawMessage(`"relevance"`)
	return schema
}

func booksHandler(c *Library) mcp.ToolHandlerFor[BooksIn, BooksOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in BooksIn) (*mcp.CallToolResult, BooksOut, error) {
		q := BookQuery{
			Query: strings.TrimSpace(in.Query), Author: strings.TrimSpace(in.Author), Title: strings.TrimSpace(in.Title),
			Subject: strings.TrimSpace(in.Subject), Sort: in.Sort, Limit: in.Limit,
		}
		if q.Query == "" && q.Author == "" && q.Title == "" && q.Subject == "" {
			return nil, BooksOut{}, errors.New("provide at least one of query, author, title or subject")
		}
		if q.Limit == 0 {
			q.Limit = defaultBooks
		}
		r, err := c.Search(ctx, q)
		if err != nil {
			return nil, BooksOut{}, err
		}
		out := BooksOut{Total: r.Total, Returned: len(r.Books), WorkIDs: []string{}}
		for _, b := range r.Books {
			out.WorkIDs = append(out.WorkIDs, b.WorkID)
		}
		return mcpserve.Text(FormatBooks(q, r)), out, nil
	}
}

// ------------------------------------------------------------------ book

type BookIn struct {
	WorkID string `json:"work_id" jsonschema:"Open Library work id such as 'OL59798W', as the books tool returned it."`
}

type BookOut struct {
	WorkID         string   `json:"work_id"`
	Title          string   `json:"title"`
	Authors        []string `json:"authors"`
	FirstPublished string   `json:"first_published,omitempty"`
	Subjects       int      `json:"subjects"`
	RedirectedFrom string   `json:"redirected_from,omitempty" jsonschema:"The id asked for, when it led to a different record."`
}

func bookSchema() any {
	schema := mcpserve.Schema[BookIn]()
	schema.Required = []string{"work_id"}
	schema.Properties["work_id"].Pattern = WorkIDPattern.String()
	return schema
}

func bookHandler(c *Library) mcp.ToolHandlerFor[BookIn, BookOut] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in BookIn) (*mcp.CallToolResult, BookOut, error) {
		id := WorkIDPattern.FindString(in.WorkID)
		if id == "" {
			return nil, BookOut{}, fmt.Errorf("%q is not an Open Library work id (expected e.g. OL59798W)", in.WorkID)
		}
		w, err := c.Work(ctx, id)
		if errors.Is(err, ErrNotFound) {
			return nil, BookOut{}, fmt.Errorf("no work with id %s", id)
		}
		if err != nil {
			return nil, BookOut{}, err
		}
		authors := w.Authors
		if authors == nil {
			authors = []string{}
		}
		out := BookOut{WorkID: w.ID, Title: w.Title, Authors: authors, FirstPublished: w.FirstPublished, Subjects: len(w.Subjects), RedirectedFrom: w.RedirectedFrom}
		return mcpserve.Text(FormatWork(w)), out, nil
	}
}
