package texttools

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const apollo = `Apollo 11 landed on July 20, 1969. Neil Armstrong stepped out first,
followed by Buzz Aldrin. Michael Collins stayed in orbit.
Apollo 13 (1970) was commanded by Jim Lovell.`

func TestExtractMarkdown(t *testing.T) {
	reply := `{"columns": ["person", "year"], "items": [
	 {"values": ["Neil Armstrong", "1969"], "quote": "Neil Armstrong stepped out   first,"},
	 {"values": ["Buzz Aldrin"], "quote": "followed by buzz aldrin"},
	 {"values": ["Neil Armstrong", "1969"], "quote": "Neil Armstrong stepped out first"},
	 {"values": ["Yuri Gagarin", "1961"], "quote": "Gagarin flew in 1961"},
	 {"values": ["Jim | Lovell", "1970"], "quote": "Apollo 13 (1970) was commanded by Jim Lovell."}
	]}`
	f, cs := setup(t, reply)
	var out ExtractOut
	res := callTool(t, cs, "extract", map[string]any{"text": apollo, "what": "people and the year each is mentioned with"}, &out)
	if res.IsError {
		t.Fatal(text(res))
	}
	want := `| person | year |
| --- | --- |
| Neil Armstrong | 1969 |
| Buzz Aldrin |  |
| Jim \| Lovell | 1970 |

(Note: 1 item(s) dropped because their source is not in the text.)`
	if text(res) != want {
		t.Errorf("got\n%s\nwant\n%s", text(res), want)
	}
	if out.Items != 3 || !reflect.DeepEqual(out.Dropped, []string{"Gagarin flew in 1961"}) || !reflect.DeepEqual(out.Columns, []string{"person", "year"}) {
		t.Errorf("structured %+v", out)
	}
	req := f.reqs[0]
	if string(req.ResponseFormat) != `{"type":"json_object"}` {
		t.Errorf("extract must ask for JSON mode: %s", req.ResponseFormat)
	}
	if u := req.Messages[1].Content; !strings.Contains(u, "Extract: people and the year each is mentioned with.") || !strings.Contains(u, "<<<TEXT\n"+apollo+"\nTEXT>>>") {
		t.Errorf("prompt:\n%s", u)
	}
}

func TestExtractJSON(t *testing.T) {
	reply := `{"columns": ["who", "yr"], "items": [{"values": ["Michael Collins", ""], "quote": "Michael Collins stayed in orbit."}]}`
	f, cs := setup(t, reply)
	res := callTool(t, cs, "extract", map[string]any{"text": apollo, "what": "astronauts", "columns": []string{"astronaut", "year"}, "format": "json"}, nil)
	want := `[
  {"astronaut": "Michael Collins", "year": "", "quote": "Michael Collins stayed in orbit."}
]`
	if res.IsError || text(res) != want {
		t.Errorf("got\n%s", text(res))
	}
	var v []map[string]string
	if err := json.Unmarshal([]byte(text(res)), &v); err != nil || v[0]["astronaut"] != "Michael Collins" {
		t.Errorf("not valid JSON: %v", err)
	}
	if u := f.reqs[0].Messages[1].Content; !strings.Contains(u, "Use exactly these columns: astronaut, year.") {
		t.Errorf("columns not asked for: %s", u)
	}
}

func TestExtractBadAnswers(t *testing.T) {
	for reply, want := range map[string]string{
		"not json":                     "not the JSON asked for",
		`{"columns": [], "items": []}`: "empty answer",
	} {
		_, cs := setup(t, reply)
		if res := callTool(t, cs, "extract", map[string]any{"text": apollo, "what": "x"}, nil); !res.IsError || !strings.Contains(text(res), want) {
			t.Errorf("%q: %s", reply, text(res))
		}
	}
	_, cs := setup(t, `{"columns": ["a"], "items": []}`)
	if res := callTool(t, cs, "extract", map[string]any{"text": apollo, "what": "x"}, nil); res.IsError || text(res) != "Nothing matching was found in the text." {
		t.Errorf("no items: %s", text(res))
	}
	if res := callTool(t, cs, "extract", map[string]any{"text": apollo}, nil); !res.IsError {
		t.Errorf("what is required: %s", text(res))
	}
}

func TestGroundLimit(t *testing.T) {
	rows := []Row{{Values: []string{"a", "b", "c"}, Quote: "one"}, {Values: nil, Quote: ""}}
	kept, dropped := Ground(rows, 2, "One two")
	if len(kept) != 1 || !reflect.DeepEqual(kept[0].Values, []string{"a", "b"}) || !reflect.DeepEqual(dropped, []string{""}) {
		t.Errorf("kept %+v dropped %q", kept, dropped)
	}
}
