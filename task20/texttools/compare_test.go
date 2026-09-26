package texttools

import (
	"reflect"
	"strings"
	"testing"
)

const (
	wikiText = "JWST launched on 25 December 2021. https://en.wikipedia.org/wiki/JWST It cost about $10 billion."
	hnText   = "1. Webb's first images\n   https://nasa.gov/webb\n   1,520 points"
)

func TestCompare(t *testing.T) {
	reply := "## In common\n- Nothing.\n\n## Only in Wikipedia\n- Launch date.\n\n## Only in Hacker News\n- [First images](https://nasa.gov/webb) drew 1,520 points; see https://fake.example/x\n\n## Where they disagree\n- Nothing."
	f, cs := setup(t, reply)
	var out CompareOut
	res := callTool(t, cs, "compare", map[string]any{"a": wikiText, "b": hnText, "a_label": " Wikipedia ", "b_label": "Hacker News", "focus": "cost"}, &out)
	if res.IsError {
		t.Fatal(text(res))
	}
	if !strings.HasPrefix(text(res), reply) || !strings.HasSuffix(text(res), "(Note: links found in neither text: https://fake.example/x)") {
		t.Errorf("text %q", text(res))
	}
	want := []string{"In common", "Only in Wikipedia", "Only in Hacker News", "Where they disagree"}
	if !reflect.DeepEqual(out.Sections, want) || out.AChars != len(wikiText) || out.BChars != len([]rune(hnText)) {
		t.Errorf("structured %+v", out)
	}
	u := f.reqs[0].Messages[1].Content
	for _, s := range []string{`Label A is "Wikipedia", label B is "Hacker News".`, "Focus on: cost.", "<<<A: Wikipedia\n" + wikiText + "\nA>>>", "<<<B: Hacker News\n" + hnText + "\nB>>>", "at most 300 words"} {
		if !strings.Contains(u, s) {
			t.Errorf("prompt lacks %q:\n%s", s, u)
		}
	}
}

func TestCompareDefaultsAndRejects(t *testing.T) {
	f, cs := setup(t, "## In common\n- Both.")
	callTool(t, cs, "compare", map[string]any{"a": "x", "b": "y", "a_label": "Same", "b_label": "Same"}, nil)
	if u := f.reqs[0].Messages[1].Content; !strings.Contains(u, `Label A is "Same", label B is "Same (2)"`) {
		t.Errorf("equal labels must be told apart: %s", u)
	}
	callTool(t, cs, "compare", map[string]any{"a": "x", "b": "y"}, nil)
	if u := f.reqs[1].Messages[1].Content; !strings.Contains(u, `Label A is "A", label B is "B"`) {
		t.Errorf("default labels: %s", u)
	}
	for _, args := range []map[string]any{{"a": "x"}, {"a": " ", "b": "y"}, {"a": strings.Repeat("a", MaxInputChars/2+1), "b": "y"}} {
		if res := callTool(t, cs, "compare", args, nil); !res.IsError {
			t.Errorf("%v accepted", len(args))
		}
	}
	if len(f.reqs) != 2 {
		t.Errorf("rejected calls reached the model: %d", len(f.reqs))
	}
}
