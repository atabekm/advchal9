package grade

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"task20/agent"
)

// trace builds a chain the way the agent does: each call's arguments are
// inspected against the outputs before it, then recorded with its output.
type trace struct{ c agent.Chain }

func (t *trace) call(tool string, args map[string]any, output string) *trace {
	return t.do(tool, "srv."+tool, args, true, output)
}

func (t *trace) do(tool, target string, args map[string]any, ok bool, output string) *trace {
	h := t.c.Inspect(args)
	t.c.Record(tool, target, args, h, ok, output, nil)
	return t
}

var (
	hnOut   = long("1. Webb's first images\n   https://nasa.gov/webb\n   1,520 points")
	wikiOut = long("# 1. James Webb Space Telescope\nhttps://en.wikipedia.org/wiki/JWST\n\nJWST is an infrared telescope.")
	cmpOut  = long("## In common\n- Both mention the first images.\n## Only in Wikipedia\n- Infrared.")
	sumOut  = long("Summary of the HN stories about Webb.")
)

// long pads a text past the handoff threshold, one distinct line at a time.
func long(s string) string {
	var b strings.Builder
	b.WriteString(s)
	for i := 0; b.Len() < agent.MinHandoffChars+50; i++ {
		b.WriteString("\n" + s[:min(len(s), 20)] + " line " + string(rune('a'+i%26)) + strings.Repeat("·", i%5))
	}
	return b.String()
}

func jwst() *Scenario {
	six := 6
	return &Scenario{
		Name:   "jwst",
		Prompt: "Compare what Hacker News and Wikipedia say about the James Webb telescope and save it to jwst.md",
		Steps: []Step{
			{ID: "hn", Tool: "search__hackernews"},
			{ID: "wiki", Tool: "search__wikipedia|search__wiki_article"},
			{ID: "cmp", Tool: "text__compare", From: []string{"hn", "wiki"}},
			{ID: "save", Tool: "file__save", From: []string{"cmp"}, Args: map[string]any{"filename": "jwst.md"}},
		},
		Forbid:   []string{"file__append"},
		MaxCalls: &six,
	}
}

func problems(r Result) string {
	var p []string
	for _, s := range r.Steps {
		for _, x := range s.Problems {
			p = append(p, s.Step.ID+": "+x)
		}
	}
	return strings.Join(append(p, r.Problems...), "; ")
}

func TestPass(t *testing.T) {
	var tr trace
	// Either search order is fine; the second one uses the alternative tool.
	tr.call("search__wiki_article", map[string]any{"title": "James Webb Space Telescope"}, wikiOut).
		call("search__hackernews", map[string]any{"query": "james webb"}, hnOut).
		call("text__compare", map[string]any{"a": wikiOut, "b": hnOut, "a_label": "Wikipedia"}, cmpOut).
		call("file__list", nil, "jwst-old.md · 12 bytes").
		call("file__save", map[string]any{"filename": "jwst.md", "content": cmpOut}, "Saved out/jwst.md")
	r := Grade(jwst(), &tr.c)
	if !r.Pass {
		t.Fatalf("want PASS: %s", problems(r))
	}
	calls := [4]int{r.Steps[0].Call, r.Steps[1].Call, r.Steps[2].Call, r.Steps[3].Call}
	if calls != [4]int{2, 1, 3, 5} {
		t.Errorf("matched calls %v", calls)
	}
	if d := strings.Join(r.Steps[2].Details, " "); d != "after hn, wiki ✓ from hn (exact) from wiki (exact)" {
		t.Errorf("compare details %q", d)
	}
	if d := strings.Join(r.Steps[3].Details, " "); d != `after cmp ✓ from cmp (exact) filename="jwst.md" ✓` {
		t.Errorf("save details %q", d)
	}
	if len(r.Extra) != 1 || r.Extra[0].Tool != "file__list" || r.Calls != 5 {
		t.Errorf("extra %+v calls %d", r.Extra, r.Calls)
	}
}

func TestWrongTool(t *testing.T) {
	var tr trace
	tr.call("search__wikipedia", map[string]any{"query": "hacker news webb"}, hnOut).
		call("search__wikipedia", map[string]any{"query": "james webb"}, wikiOut).
		call("text__compare", map[string]any{"a": wikiOut, "b": hnOut}, cmpOut).
		call("file__save", map[string]any{"filename": "jwst.md", "content": cmpOut}, "Saved")
	r := Grade(jwst(), &tr.c)
	if r.Pass || r.Steps[0].Problems[0] != "not called" || !strings.Contains(problems(r), "cmp: needs hn first") {
		t.Errorf("want hn missing: %s", problems(r))
	}
}

func TestWrongOrder(t *testing.T) {
	var tr trace
	// Saved before comparing: the save carries the HN list, not a comparison.
	tr.call("search__hackernews", map[string]any{"query": "webb"}, hnOut).
		call("search__wikipedia", map[string]any{"query": "webb"}, wikiOut).
		call("file__save", map[string]any{"filename": "jwst.md", "content": hnOut}, "Saved").
		call("text__compare", map[string]any{"a": wikiOut, "b": hnOut}, cmpOut)
	r := Grade(jwst(), &tr.c)
	if r.Pass || !strings.Contains(problems(r), "save: came before cmp (call 4)") {
		t.Errorf("want an order problem: %s", problems(r))
	}
}

func TestMadeUpData(t *testing.T) {
	var tr trace
	tr.call("search__hackernews", map[string]any{"query": "webb"}, hnOut).
		call("search__wikipedia", map[string]any{"query": "webb"}, wikiOut).
		call("text__compare", map[string]any{"a": wikiOut, "b": long("The model's own idea of what HN says.")}, cmpOut).
		call("file__save", map[string]any{"filename": "jwst.md", "content": cmpOut}, "Saved")
	r := Grade(jwst(), &tr.c)
	if r.Pass || problems(r) != "cmp: carries nothing from hn (call 1)" {
		t.Errorf("want a missing handoff: %s", problems(r))
	}
}

// Data that went through another call still counts, and says how.
func TestIndirectFlow(t *testing.T) {
	var tr trace
	tr.call("search__hackernews", map[string]any{"query": "webb"}, hnOut).
		call("text__summarize", map[string]any{"text": hnOut}, sumOut).
		call("search__wikipedia", map[string]any{"query": "webb"}, wikiOut).
		call("text__compare", map[string]any{"a": wikiOut, "b": sumOut}, cmpOut).
		call("file__save", map[string]any{"filename": "jwst.md", "content": cmpOut}, "Saved")
	r := Grade(jwst(), &tr.c)
	if !r.Pass {
		t.Fatalf("want PASS: %s", problems(r))
	}
	if d := strings.Join(r.Steps[2].Details, " "); !strings.Contains(d, "from hn (via 2: exact)") {
		t.Errorf("details %q", d)
	}
}

func TestForbiddenUnknownTooManyArgs(t *testing.T) {
	var tr trace
	tr.call("search__hackernews", map[string]any{"query": "webb"}, hnOut).
		call("search__wikipedia", map[string]any{"query": "webb"}, wikiOut).
		do("search__google", "", map[string]any{"query": "webb"}, false, `{"error":"unknown tool"}`).
		call("text__compare", map[string]any{"a": wikiOut, "b": hnOut}, cmpOut).
		call("file__append", map[string]any{"filename": "jwst.md", "content": cmpOut}, "Appended").
		call("file__save", map[string]any{"filename": "JWST.md", "content": cmpOut}, "Saved").
		call("file__list", nil, "a").call("file__list", nil, "b")
	r := Grade(jwst(), &tr.c)
	for _, want := range []string{
		"call 3: search__google is not a tool any server offers",
		"call 5: file__append is forbidden here",
		"7 successful calls; at most 6 expected",
		`save: filename="JWST.md", want "jwst.md"`,
	} {
		if !strings.Contains(problems(r), want) {
			t.Errorf("missing %q in %s", want, problems(r))
		}
	}
	if r.Pass || r.Failed != 1 {
		t.Errorf("pass %v failed %d", r.Pass, r.Failed)
	}
}

// A failed call does not fill a step; its successful retry does.
func TestRetryAfterFailure(t *testing.T) {
	var tr trace
	tr.call("search__hackernews", map[string]any{"query": "webb"}, hnOut).
		call("search__wikipedia", map[string]any{"query": "webb"}, wikiOut).
		call("text__compare", map[string]any{"a": wikiOut, "b": hnOut}, cmpOut).
		do("file__save", "srv.save", map[string]any{"filename": "jwst", "content": cmpOut}, false, `{"error":"bad name"}`).
		call("file__save", map[string]any{"filename": "jwst.md", "content": cmpOut}, "Saved")
	r := Grade(jwst(), &tr.c)
	if !r.Pass || r.Steps[3].Call != 5 || r.Failed != 1 || len(r.Extra) != 1 || r.Extra[0].OK {
		t.Errorf("pass %v: %s, save call %d, extra %+v", r.Pass, problems(r), r.Steps[3].Call, r.Extra)
	}
	var only trace
	only.do("search__hackernews", "srv.hn", map[string]any{"query": "webb"}, false, `{"error":"503"}`)
	if r := Grade(jwst(), &only.c); !strings.HasPrefix(r.Steps[0].Problems[0], "called at 1 but it failed") {
		t.Errorf("%s", problems(r))
	}
}

// A short value (a title) found in an earlier output, and not in the
// prompt, is data carried from that output.
func TestValueFlow(t *testing.T) {
	sc := &Scenario{Prompt: "Find Le Guin's most-read book and read its Wikipedia article", Steps: []Step{
		{ID: "books", Tool: "search__books"},
		{ID: "art", Tool: "search__wiki_article", From: []string{"books"}},
	}}
	var tr trace
	tr.call("search__books", map[string]any{"author": "Le Guin"}, "1. A Wizard of Earthsea\n   work_id OL59798W").
		call("search__wiki_article", map[string]any{"title": "A Wizard of Earthsea"}, wikiOut)
	r := Grade(sc, &tr.c)
	if !r.Pass || r.Steps[1].Details[1] != `from books (value "A Wizard of Earthsea")` {
		t.Errorf("%s %v", problems(r), r.Steps[1].Details)
	}
	// "Le Guin" is in the prompt: it proves nothing about the books result.
	var tr2 trace
	tr2.call("search__books", map[string]any{"author": "Le Guin"}, "1. A Wizard of Earthsea by Le Guin").
		call("search__wiki_article", map[string]any{"title": "Le Guin"}, wikiOut)
	if r := Grade(sc, &tr2.c); r.Pass {
		t.Error("a value from the prompt must not count as carried data")
	}
}

func TestNoToolsExpected(t *testing.T) {
	zero := 0
	sc := &Scenario{Prompt: "Weather in Paris tomorrow?", MaxCalls: &zero}
	if r := Grade(sc, &agent.Chain{}); !r.Pass {
		t.Errorf("no calls should pass: %s", problems(r))
	}
	var tr trace
	tr.call("search__wikipedia", map[string]any{"query": "Paris weather"}, wikiOut)
	if r := Grade(sc, &tr.c); r.Pass || problems(r) != "1 successful calls; at most 0 expected" {
		t.Errorf("%s", problems(r))
	}
}

func TestValidateAndLoad(t *testing.T) {
	bad := []*Scenario{
		{Name: "a", Prompt: "p", Steps: []Step{{ID: "x", Tool: "t"}, {ID: "x", Tool: "t"}}},
		{Name: "b", Prompt: "p", Steps: []Step{{ID: "x", Tool: "t", After: []string{"y"}}, {ID: "y", Tool: "t"}}},
		{Name: "c", Prompt: " "},
	}
	for _, sc := range bad {
		if sc.Validate(nil) == nil {
			t.Errorf("%s: want invalid", sc.Name)
		}
	}
	known := func(s string) bool { return s == "t" }
	if err := (&Scenario{Name: "d", Prompt: "p", Forbid: []string{"u"}}).Validate(known); err == nil || !strings.Contains(err.Error(), `"u"`) {
		t.Errorf("unknown tool: %v", err)
	}

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "2-b.json"), []byte(`{"prompt": "second", "steps": []}`), 0o644)
	os.WriteFile(filepath.Join(dir, "1-a.json"), []byte(`{"name": "first", "prompt": "p", "steps": [{"id": "s", "tool": "x__y"}]}`), 0o644)
	scs, err := Load(dir)
	if err != nil || len(scs) != 2 || scs[0].Name != "first" || scs[1].Name != "2-b" {
		t.Fatalf("%v %v", scs, err)
	}
	os.WriteFile(filepath.Join(dir, "3-c.json"), []byte(`{"prompt": "p", "stepz": []}`), 0o644)
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "stepz") {
		t.Errorf("unknown field: %v", err)
	}
}

// The shipped scenarios load and are well formed.
func TestShippedScenarios(t *testing.T) {
	scs, err := Load("../scenarios")
	if err != nil {
		t.Fatal(err)
	}
	if len(scs) != 5 {
		t.Errorf("%d scenarios", len(scs))
	}
}

// Seen live: the model summarized twice, from its own text, and appended
// the second summary. The failing step is the summary; the append, which
// carries the second summary, is matched to it and passes.
func TestBestAssignment(t *testing.T) {
	sc := &Scenario{Prompt: "summarize the article and add it", Steps: []Step{
		{ID: "article", Tool: "search__wiki_article"},
		{ID: "sum", Tool: "text__summarize", From: []string{"article"}},
		{ID: "add", Tool: "file__append", From: []string{"sum"}},
	}}
	sum2 := long("Second summary, with a different focus.")
	var tr trace
	tr.call("search__wiki_article", map[string]any{"title": "X"}, wikiOut).
		call("text__summarize", map[string]any{"text": long("The model's own excerpt.")}, sumOut).
		call("text__summarize", map[string]any{"text": long("The model's own excerpt.")}, sum2).
		call("file__append", map[string]any{"filename": "a.md", "content": sum2}, "Appended")
	r := Grade(sc, &tr.c)
	if got := problems(r); got != "sum: carries nothing from article (call 1)" {
		t.Errorf("problems %q", got)
	}
	if r.Steps[1].Call != 3 || r.Steps[2].Call != 4 || !r.Steps[2].OK() {
		t.Errorf("sum → %d, add → %d ok=%v", r.Steps[1].Call, r.Steps[2].Call, r.Steps[2].OK())
	}
	// A retry that gets it right fills the step; the first try is extra.
	var tr2 trace
	tr2.call("search__wiki_article", map[string]any{"title": "X"}, wikiOut).
		call("text__summarize", map[string]any{"text": long("The model's own excerpt.")}, sumOut).
		call("text__summarize", map[string]any{"text": wikiOut}, sum2).
		call("file__append", map[string]any{"filename": "a.md", "content": sum2}, "Appended")
	if r := Grade(sc, &tr2.c); !r.Pass || r.Steps[1].Call != 3 || len(r.Extra) != 1 || r.Extra[0].Call != 2 {
		t.Errorf("retry: %s %+v", problems(r), r.Extra)
	}
}
