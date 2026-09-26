// Package search is one MCP server over three read-only sources: Wikipedia,
// Hacker News and Open Library. Every tool returns plain text that any other
// tool can take as input; none knows what comes next.
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
)

const (
	WikiBaseURL = "https://en.wikipedia.org/w/api.php"
	// Wikimedia and Open Library ask API clients to identify themselves.
	userAgent = "task20-searchserver/0.3 (https://github.com/atabekm/advchal9; MCP tool demo)"
)

// Wiki talks to the MediaWiki API.
type Wiki struct {
	BaseURL string
	HTTP    *http.Client
}

func NewWiki() *Wiki {
	return &Wiki{BaseURL: WikiBaseURL, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

// Article is one search hit with its text, before truncation.
type Article struct {
	ID             int
	Title          string
	URL            string
	Text           string
	RedirectedFrom string // Article: the title asked for, when it redirected
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
		Normalized []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"normalized"`
		Redirects []struct {
			From string `json:"from"`
			To   string `json:"to"`
		} `json:"redirects"`
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
func (c *Wiki) Search(ctx context.Context, query string, limit int, detail string) (Result, error) {
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
func (c *Wiki) fillFull(ctx context.Context, arts []Article) error {
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

// ErrNoArticle is returned by Article for a title Wikipedia has no page for.
var ErrNoArticle = errors.New("no article")

// Article fetches one article by its title, whole, following redirects
// ("JWST" → "James Webb Space Telescope"). A disambiguation page is an
// error: it is a list of other titles, not an article.
func (c *Wiki) Article(ctx context.Context, title string) (Article, error) {
	q := url.Values{
		"action": {"query"}, "format": {"json"}, "formatversion": {"2"}, "titles": {title}, "redirects": {"1"},
		"prop": {"extracts|info|pageprops"}, "inprop": {"url"}, "ppprop": {"disambiguation"},
		"explaintext": {"1"}, "exsectionformat": {"wiki"},
	}
	var ar apiResponse
	if err := c.get(ctx, q, &ar); err != nil {
		return Article{}, err
	}
	if len(ar.Query.Pages) == 0 || ar.Query.Pages[0].Missing || strings.TrimSpace(ar.Query.Pages[0].Extract) == "" {
		return Article{}, fmt.Errorf("%w titled %q", ErrNoArticle, title)
	}
	p := ar.Query.Pages[0]
	if _, dis := p.PageProps["disambiguation"]; dis {
		return Article{}, fmt.Errorf("%q is a disambiguation page, not an article; use a more specific title", p.Title)
	}
	a := Article{ID: p.PageID, Title: p.Title, URL: p.FullURL, Text: Clean(p.Extract)}
	if len(ar.Query.Redirects) > 0 {
		a.RedirectedFrom = ar.Query.Redirects[0].From
	}
	return a, nil
}

func (c *Wiki) get(ctx context.Context, q url.Values, out *apiResponse) error {
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

// FormatArticles renders a result as the text the tool returns: each article with
// its title, link and text, cut to chars characters. The text holds content
// only. Counts and what was shortened go to the structured output: a model
// carrying the text on treats a header or a note as metadata and drops it.
func FormatArticles(r Result, chars int) (string, int) {
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

func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
