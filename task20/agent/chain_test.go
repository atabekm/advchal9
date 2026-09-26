package agent

import (
	"reflect"
	"strings"
	"testing"
)

func lines(prefix string, n int) string {
	var b strings.Builder
	for i := range n {
		b.WriteString(prefix)
		b.WriteString(strings.Repeat("-", 20))
		b.WriteByte(byte('a' + i))
		b.WriteByte('\n')
	}
	return b.String()
}

func TestVerdicts(t *testing.T) {
	search := lines("search result line ", 12)
	summary := lines("summary sentence ", 10)
	c := &Chain{}
	c.Record("search", "", map[string]any{"query": "x"}, nil, true, search, nil)
	c.Record("summarize", "", map[string]any{"text": search}, nil, true, summary, nil)

	shortened := strings.Join(strings.Split(search, "\n")[:6], "\n") + "\nan extra line written by the model itself, long enough"
	for name, tc := range map[string]struct {
		arg  string
		want Handoff
	}{
		"exact latest":  {summary, Handoff{From: 2, FromTool: "summarize", Verdict: Exact}},
		"exact earlier": {search, Handoff{From: 1, FromTool: "search", Verdict: Exact}},
		"whitespace":    {"  " + strings.ReplaceAll(summary, "\n", "\n\n") + "\n", Handoff{From: 2, FromTool: "summarize", Verdict: Whitespace}},
		"partial":       {shortened, Handoff{From: 1, FromTool: "search", Verdict: Partial, Kept: 6, Of: 12, Added: 1}},
		"none":          {strings.Repeat("the model wrote this on its own. ", 10), Handoff{Verdict: None}},
	} {
		hs := c.Inspect(map[string]any{"content": tc.arg, "filename": "out.md", "n": 3.0})
		if len(hs) != 1 {
			t.Errorf("%s: want one handoff (short and non-string args skipped), got %+v", name, hs)
			continue
		}
		got := hs[0]
		if got.Arg != "content" || got.Chars != len([]rune(tc.arg)) || got.SHA256 != Hash(tc.arg) {
			t.Errorf("%s: arg/chars/hash wrong: %+v", name, got)
		}
		if (got.Diff != "") != (tc.want.Verdict == Whitespace) {
			t.Errorf("%s: diff %q", name, got.Diff)
		}
		if tc.want.Verdict == Partial && len(got.Missing) != got.Of-got.Kept {
			t.Errorf("%s: missing %d lines, want %d", name, len(got.Missing), got.Of-got.Kept)
		}
		got.Arg, got.Chars, got.SHA256, got.Diff, got.Missing = "", 0, "", "", nil
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %+v want %+v", name, got, tc.want)
		}
	}
}

func TestFailedStepIsNoSource(t *testing.T) {
	out := lines("error text ", 12)
	c := &Chain{}
	c.Record("search", "", nil, nil, false, out, nil)
	if h := c.Inspect(map[string]any{"text": out}); h[0].Verdict != None {
		t.Errorf("a failed call's output is not a source: %+v", h[0])
	}
}

func TestStoreCheckAndReport(t *testing.T) {
	summary := lines("summary ", 10)
	c := &Chain{}
	c.Record("search", "", map[string]any{"query": "q"}, nil, true, lines("hit ", 10), nil)
	h1 := c.Inspect(map[string]any{"text": c.Steps[0].Output})
	c.Record("summarize", "", map[string]any{"text": c.Steps[0].Output}, h1, true, summary, nil)
	c.Record("save_to_file", "", map[string]any{"filename": "x.md"}, nil, false, `{"error":"bad name"}`, nil)
	args := map[string]any{"filename": "y.md", "content": summary}
	h2 := c.Inspect(args)
	st := c.Record("save_to_file", "", args, h2, true, "Saved", map[string]any{"sha256": strings.ToUpper(Hash(summary)), "bytes": 1})
	if st.Store == nil || !st.Store.Match || st.Store.Arg != "content" {
		t.Fatalf("store check: %+v", st.Store)
	}
	bad := c.Record("save_to_file", "", args, nil, true, "Saved", map[string]any{"sha256": Hash("something else")})
	if bad.Store == nil || bad.Store.Match {
		t.Errorf("a different hash must not match: %+v", bad.Store)
	}

	path, counts, stores := c.Report()
	if path != "search → summarize → save_to_file → save_to_file" {
		t.Errorf("path %q (failed steps are left out)", path)
	}
	if counts[Exact] != 2 || len(counts) != 1 {
		t.Errorf("counts %v", counts)
	}
	if len(stores) != 2 || !stores[0].Match || stores[1].Match {
		t.Errorf("stores %+v", stores)
	}
}

func TestFirstDiff(t *testing.T) {
	for _, tc := range [][3]string{
		{"a\nb\n", "a\nb", `trailing "\n" dropped`},
		{"a\nb", "a\nb\n\n", `trailing "\n\n" added`},
		{"one\ntwo  three", "one\ntwo three", `line 2: output "e\ntwo  three", argument "e\ntwo three"`},
		{"x", "x", "identical"},
	} {
		if got := FirstDiff(tc[0], tc[1]); got != tc[2] {
			t.Errorf("FirstDiff(%q, %q) = %s, want %s", tc[0], tc[1], got, tc[2])
		}
	}
}

func TestJoined(t *testing.T) {
	a, b := lines("first search ", 6), lines("second search ", 4)
	c := &Chain{}
	c.Record("search", "", nil, nil, true, a, nil)
	c.Record("search", "", nil, nil, true, b, nil)
	arg := strings.Join(strings.Split(a, "\n")[:3], "\n") + "\n" + b + "a line the model wrote itself, and long enough to count\n"
	h := c.Inspect(map[string]any{"text": arg})[0]
	want := []Source{{Step: 1, Tool: "search", Lines: 3}, {Step: 2, Tool: "search", Lines: 4}}
	if h.Verdict != Joined || h.Added != 1 || !reflect.DeepEqual(h.Sources, want) {
		t.Errorf("got %+v", h)
	}
	if s := h.String(); !strings.Contains(s, "joined from steps 1 search (3 lines), 2 search (4 lines) · 1 added") {
		t.Errorf("String() = %s", s)
	}
}

// Seen live: the model rewrote a list before passing it on, so that no line
// matched; most of its words still came from that output.
func TestReworded(t *testing.T) {
	var c Chain
	list := "1. Webb's first images exceed expectations\n   https://cosmosmagazine.com/webb\n   840 points · 265 comments · 2022-03-18\n" +
		"2. The James Webb Space Telescope is finding too many early galaxies\n   https://skyandtelescope.org/early\n   764 points · 526 comments · 2023-01-12"
	c.Record("hn", "", nil, nil, true, list, nil)
	c.Record("wiki", "", nil, nil, true, "The James Webb Space Telescope is an infrared observatory launched in 2021 by NASA.", nil)
	arg := "Hacker News stories: Webb's first images exceed expectations (840 points, 265 comments, 2022-03-18, cosmosmagazine.com/webb); " +
		"The James Webb Space Telescope is finding too many early galaxies (764 points, 526 comments, 2023-01-12, skyandtelescope.org/early)." +
		strings.Repeat(" ", MinHandoffChars)
	h := c.Inspect(map[string]any{"a": arg})[0]
	if h.Verdict != Reworded || h.From != 1 || h.Overlap < 60 {
		t.Errorf("%+v", h)
	}
	if !strings.Contains(h.String(), "reworded: no line kept as is") {
		t.Error(h.String())
	}
	// Words from nowhere stay "none".
	own := strings.Repeat("Completely unrelated prose about gardening and tomatoes. ", 6)
	if h := c.Inspect(map[string]any{"a": own})[0]; h.Verdict != None {
		t.Errorf("%+v", h)
	}
}
