// Package search is the first tool of the pipeline: full-text search over
// Wikipedia that returns the articles' own text. The result is plain text
// that any other tool can take as input; it knows nothing about what comes
// next.
package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/mcpserve"
)

const (
	ServerName    = "searchserver"
	ServerVersion = "0.2.0"

	DefaultBaseURL = "https://en.wikipedia.org/w/api.php"
	// Wikimedia asks API clients to identify themselves.
	userAgent = "task20-searchserver/0.2 (https://github.com/atabekm/advchal9; MCP tool demo)"

	defaultLimit = 5
	maxLimit     = 10
	defaultChars = 2000
	minChars     = 200
	maxChars     = 5000
)

// Client talks to the MediaWiki API.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient() *Client {
	return &Client{BaseURL: DefaultBaseURL, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// Article is one search hit with its text, before truncation.
type Article struct {
	ID    int
	Title string
	URL   string
	Text  string
}

// Result is one search: the articles found and how many matched in total.
type Result struct {
	Query    string
	Detail   string // "intro" or "full"
	Total    int
	Articles []Article
}

type apiResponse struct {
	Error *struct {
		Info string `json:"info"`
	} `json:"error"`
	Query struct {
		SearchInfo struct {
			TotalHits int `json:"totalhits"`
		} `json:"searchinfo"`
		Pages []struct {
			PageID    int               `json:"pageid"`
			Title     string            `json:"title"`
			Index     int               `json:"index"`
			Extract   string            `json:"extract"`
			FullURL   string            `json:"fullurl"`
			PageProps map[string]string `json:"pageprops"`
			Missing   bool              `json:"missing"`
		} `json:"pages"`
	} `json:"query"`
}

// Search finds up to limit articles. With detail "intro" one request brings
// the lead sections; with "full" each article's whole text is fetched too.
// Disambiguation pages are skipped: they are lists of links, not text.
func (c *Client) Search(ctx context.Context, query string, limit int, detail string) (Result, error) {
	q := url.Values{
		"action": {"query"}, "format": {"json"}, "formatversion": {"2"},
		"generator": {"search"}, "gsrsearch": {query}, "gsrlimit": {strconv.Itoa(limit + 3)},
		"list": {"search"}, "srsearch": {query}, "srlimit": {"1"}, "srinfo": {"totalhits"}, "srprop": {""},
		"prop": {"extracts|info|pageprops"}, "inprop": {"url"}, "ppprop": {"disambiguation"},
		"exintro": {"1"}, "explaintext": {"1"}, "exsectionformat": {"wiki"}, "exlimit": {"max"},
	}
	var ar apiResponse
	if err := c.get(ctx, q, &ar); err != nil {
		return Result{}, err
	}
	pages := ar.Query.Pages
	sort.Slice(pages, func(i, j int) bool { return pages[i].Index < pages[j].Index })

	r := Result{Query: query, Detail: detail, Total: ar.Query.SearchInfo.TotalHits}
	for _, p := range pages {
		if _, dis := p.PageProps["disambiguation"]; dis || p.Missing || strings.TrimSpace(p.Extract) == "" {
			continue
		}
		r.Articles = append(r.Articles, Article{ID: p.PageID, Title: p.Title, URL: p.FullURL, Text: Clean(p.Extract)})
		if len(r.Articles) == limit {
			break
		}
	}
	if detail == "full" {
		if err := c.fillFull(ctx, r.Articles); err != nil {
			return Result{}, err
		}
	}
	return r, nil
}

// fillFull replaces each intro with the whole article. The API returns a
// full extract for one page per request, so the requests run side by side.
func (c *Client) fillFull(ctx context.Context, arts []Article) error {
	var wg sync.WaitGroup
	errs := make([]error, len(arts))
	for i := range arts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q := url.Values{
				"action": {"query"}, "format": {"json"}, "formatversion": {"2"}, "pageids": {strconv.Itoa(arts[i].ID)},
				"prop": {"extracts"}, "explaintext": {"1"}, "exsectionformat": {"wiki"},
			}
			var ar apiResponse
			if err := c.get(ctx, q, &ar); err != nil {
				errs[i] = fmt.Errorf("%s: %w", arts[i].Title, err)
				return
			}
			if len(ar.Query.Pages) == 1 && strings.TrimSpace(ar.Query.Pages[0].Extract) != "" {
				arts[i].Text = Clean(ar.Query.Pages[0].Extract)
			}
		}()
	}
	wg.Wait()
	return errors.Join(errs...)
}

func (c *Client) get(ctx context.Context, q url.Values, out *apiResponse) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("Wikipedia unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Wikipedia returned HTTP %d", resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decoding Wikipedia response: %w", err)
	}
	if out.Error != nil {
		return fmt.Errorf("Wikipedia: %s", out.Error.Info)
	}
	return nil
}

var (
	headingRE = regexp.MustCompile(`^(={2,6})\s*(.*?)\s*={2,6}$`)
	blankRE   = regexp.MustCompile(`\n{3,}`)
)

// Sections that are lists of links in the article; as plain text they are
// noise, so they are left out with everything under them.
var backMatter = map[string]bool{
	"see also": true, "references": true, "notes": true, "external links": true,
	"further reading": true, "sources": true, "bibliography": true, "citations": true,
	"notes and references": true, "footnotes": true,
}

// Clean turns an extract into tidy text: trailing spaces gone, wiki section
// markers ("== History ==") as Markdown headings, empty sections and back
// matter dropped, at most one blank line in a row.
func Clean(s string) string {
	var out []string
	skipBelow := 0 // inside back matter: skip until a heading at this level or higher
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		l = strings.TrimRight(l, " \t")
		m := headingRE.FindStringSubmatch(l)
		if m == nil {
			if skipBelow == 0 {
				out = append(out, l)
			}
			continue
		}
		level := len(m[1])
		if skipBelow > 0 && level > skipBelow {
			continue
		}
		skipBelow = 0
		out = dropEmptySection(out, level)
		if backMatter[strings.ToLower(m[2])] {
			skipBelow = level
			continue
		}
		out = append(out, "", strings.Repeat("#", level)+" "+m[2], "")
	}
	out = dropEmptySection(out, 1)
	return strings.TrimSpace(blankRE.ReplaceAllString(strings.Join(out, "\n"), "\n\n"))
}

// dropEmptySection removes trailing blank lines, then any trailing headings
// at level or deeper: sections that ended up with no text.
func dropEmptySection(out []string, level int) []string {
	for {
		for len(out) > 0 && out[len(out)-1] == "" {
			out = out[:len(out)-1]
		}
		if len(out) == 0 || headingLevel(out[len(out)-1]) < level {
			return out
		}
		out = out[:len(out)-1]
	}
}

func headingLevel(l string) int {
	n := 0
	for n < len(l) && l[n] == '#' {
		n++
	}
	if n == 0 || n >= len(l) || l[n] != ' ' {
		return 0
	}
	return n
}

// Truncate cuts text to at most max characters at a paragraph or sentence
// boundary where one is close enough, and says how much was left out.
func Truncate(text string, max int) (string, bool) {
	r := []rune(text)
	if len(r) <= max {
		return text, false
	}
	cut := string(r[:max])
	if i := strings.LastIndex(cut, "\n\n"); i > max/2 {
		cut = cut[:i]
	} else if i := strings.LastIndex(cut, ". "); i > max/2 {
		cut = cut[:i+1]
	}
	cut = strings.TrimRight(cut, " \n")
	// A heading left with nothing under it is dropped.
	if ls := strings.Split(cut, "\n"); headingLevel(ls[len(ls)-1]) > 0 {
		cut = strings.TrimRight(strings.Join(ls[:len(ls)-1], "\n"), " \n")
	}
	return cut, true
}

// Format renders a result as the text the tool returns: each article with
// its title, link and text, cut to chars characters. The text holds content
// only. Counts and what was shortened go to the structured output: a model
// carrying the text on treats a header or a note as metadata and drops it.
func Format(r Result, chars int) (string, int) {
	if len(r.Articles) == 0 {
		return fmt.Sprintf("No Wikipedia articles found for %q.", r.Query), 0
	}
	var parts []string
	truncated := 0
	for i, a := range r.Articles {
		text, cut := Truncate(a.Text, chars)
		if cut {
			truncated++
			text += " […]"
		}
		parts = append(parts, fmt.Sprintf("# %d. %s\n%s\n\n%s", i+1, a.Title, a.URL, text))
	}
	return strings.Join(parts, "\n\n"), truncated
}

// ------------------------------------------------------------------- tool

type In struct {
	Query  string `json:"query" jsonschema:"What to search for, e.g. 'async programming in Rust' or 'history of SQLite'."`
	Limit  int    `json:"limit,omitempty" jsonschema:"How many articles to return."`
	Detail string `json:"detail,omitempty" jsonschema:"'intro' for each article's lead section, 'full' for its whole text (both cut to 'chars')."`
	Chars  int    `json:"chars,omitempty" jsonschema:"Maximum characters of text per article; longer text is cut at a paragraph or sentence."`
}

type Out struct {
	Query     string `json:"query"`
	Detail    string `json:"detail"`
	Total     int    `json:"total_matches" jsonschema:"How many articles match in all."`
	Returned  int    `json:"returned"`
	Truncated int    `json:"truncated" jsonschema:"How many of the returned articles were cut to 'chars' (marked […])."`
}

func NewServer(c *Client) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "Wikipedia search", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Full-text search over English Wikipedia, returning the articles' text."})
	s.AddReceivingMiddleware(mcpserve.NullArgsAsEmpty)

	schema := mcpserve.Schema[In]()
	schema.Required = []string{"query"}
	schema.Properties["query"].MinLength = mcpserve.Ptr(1)
	lim := schema.Properties["limit"]
	lim.Minimum, lim.Maximum, lim.Default = mcpserve.Ptr(1.0), mcpserve.Ptr(float64(maxLimit)), json.RawMessage(strconv.Itoa(defaultLimit))
	det := schema.Properties["detail"]
	det.Enum, det.Default = []any{"intro", "full"}, json.RawMessage(`"intro"`)
	ch := schema.Properties["chars"]
	ch.Minimum, ch.Maximum, ch.Default = mcpserve.Ptr(float64(minChars)), mcpserve.Ptr(float64(maxChars)), json.RawMessage(strconv.Itoa(defaultChars))

	mcp.AddTool(s, &mcp.Tool{
		Name:  "search",
		Title: "Search Wikipedia",
		Description: "Search English Wikipedia and return the best-matching articles as plain text: for each, " +
			"its title, link and text (the lead section, or the whole article with detail 'full'), " +
			"cut to at most 'chars' characters and marked […] where shortened.",
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
		if in.Detail == "" {
			in.Detail = "intro"
		}
		if in.Chars == 0 {
			in.Chars = defaultChars
		}
		r, err := c.Search(ctx, in.Query, in.Limit, in.Detail)
		if err != nil {
			return nil, Out{}, err
		}
		text, truncated := Format(r, in.Chars)
		return mcpserve.Text(text), Out{Query: r.Query, Detail: r.Detail, Total: r.Total, Returned: len(r.Articles), Truncated: truncated}, nil
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
