package texttools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/llm"
)

// fakeLLM answers every chat request with reply and remembers the requests.
type fakeLLM struct {
	mu    sync.Mutex
	reply string
	reqs  []chatReq
}

type chatReq struct {
	Messages       []llm.Message   `json:"messages"`
	Tools          json.RawMessage `json:"tools"`
	ResponseFormat json.RawMessage `json:"response_format"`
}

func (f *fakeLLM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var req chatReq
	json.NewDecoder(r.Body).Decode(&req)
	f.reqs = append(f.reqs, req)
	json.NewEncoder(w).Encode(map[string]any{
		"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": f.reply}}},
	})
}

func setup(t *testing.T, reply string) (*fakeLLM, *mcp.ClientSession) {
	t.Helper()
	f := &fakeLLM{reply: reply}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d := llm.NewDeepSeek("test-key", "deepseek-flash")
	d.BaseURL = srv.URL
	s := NewServer(&Engine{LLM: d})

	ct, st := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := s.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return f, cs
}

func call(t *testing.T, cs *mcp.ClientSession, args map[string]any) (*mcp.CallToolResult, SummarizeOut) {
	t.Helper()
	var out SummarizeOut
	return callTool(t, cs, "summarize", args, &out), out
}

func callTool(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any, out any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if b, err := json.Marshal(res.StructuredContent); err == nil && out != nil {
		json.Unmarshal(b, out)
	}
	return res
}

const source = "1. Why asynchronous Rust doesn't work\n   https://theta.eu.org/2021/03/08/async-rust-2.html\n   612 points"

func TestSummary(t *testing.T) {
	reply := "- [Why async Rust doesn't work](https://theta.eu.org/2021/03/08/async-rust-2.html) drew 612 points."
	f, cs := setup(t, "  "+reply+"\n")
	res, out := call(t, cs, map[string]any{"text": source, "focus": "criticism", "max_words": 120})
	if res.IsError {
		t.Fatalf("tool error: %s", text(res))
	}
	if text(res) != reply {
		t.Errorf("content should be the trimmed summary alone, got %q", text(res))
	}
	if out.OutputWords != len(strings.Fields(reply)) || out.InputChars != len([]rune(source)) || out.Model != "deepseek-flash" {
		t.Errorf("structured: %+v", out)
	}
	if len(out.UngroundedLinks) != 0 {
		t.Errorf("a copied link is grounded: %v", out.UngroundedLinks)
	}

	req := f.reqs[0]
	if len(req.Tools) != 0 && string(req.Tools) != "null" {
		t.Errorf("the summary call must not offer tools: %s", req.Tools)
	}
	if req.Messages[0].Role != "system" || !strings.Contains(req.Messages[0].Content, "Use only the text") {
		t.Errorf("system prompt: %+v", req.Messages[0])
	}
	u := req.Messages[1].Content
	for _, want := range []string{"at most 120 words", "Focus on: criticism.", "<<<TEXT\n" + source + "\nTEXT>>>"} {
		if !strings.Contains(u, want) {
			t.Errorf("user prompt lacks %q:\n%s", want, u)
		}
	}
}

func TestDefaultsAndPlain(t *testing.T) {
	f, cs := setup(t, "ok")
	call(t, cs, map[string]any{"text": "some text"})
	call(t, cs, map[string]any{"text": "some text", "format": "plain"})
	if u := f.reqs[0].Messages[1].Content; !strings.Contains(u, "at most 200 words") || !strings.Contains(u, "Write Markdown") {
		t.Errorf("defaults: %s", u)
	}
	if u := f.reqs[1].Messages[1].Content; !strings.Contains(u, "no Markdown") {
		t.Errorf("plain: %s", u)
	}
}

func TestInventedLinkIsFlagged(t *testing.T) {
	_, cs := setup(t, "See https://theta.eu.org/2021/03/08/async-rust-2.html and https://made-up.example/rust.")
	res, out := call(t, cs, map[string]any{"text": source})
	if !reflect.DeepEqual(out.UngroundedLinks, []string{"https://made-up.example/rust"}) {
		t.Errorf("ungrounded = %v", out.UngroundedLinks)
	}
	if !strings.HasSuffix(text(res), "(Note: links not found in the input text: https://made-up.example/rust)") {
		t.Errorf("the note should close the text: %q", text(res))
	}
}

func TestRejected(t *testing.T) {
	f, cs := setup(t, "never")
	for name, args := range map[string]map[string]any{
		"empty":      {"text": "   "},
		"missing":    {},
		"too long":   {"text": strings.Repeat("é", MaxInputChars+1)},
		"few words":  {"text": "x", "max_words": 10},
		"many words": {"text": "x", "max_words": 801},
		"format":     {"text": "x", "format": "html"},
	} {
		res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "summarize", Arguments: args})
		if err == nil && !res.IsError {
			t.Errorf("%s: want a tool error, got %q", name, text(res))
		}
	}
	if len(f.reqs) != 0 {
		t.Errorf("rejected input must not reach the model (%d calls)", len(f.reqs))
	}
}

func TestEmptyReply(t *testing.T) {
	_, cs := setup(t, "  \n")
	if res, _ := call(t, cs, map[string]any{"text": "x"}); !res.IsError {
		t.Errorf("an empty summary is an error, got %q", text(res))
	}
}

func TestUngrounded(t *testing.T) {
	src := "a https://a.example/x_(y) b https://b.example/path?q=1"
	for summary, want := range map[string][]string{
		"[a](https://a.example/x_) and https://b.example/path?q=1.": {},
		"**https://c.example/new**, again https://c.example/new":    {"https://c.example/new"},
		"no links at all": {},
	} {
		if got := Ungrounded(summary, src); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %v want %v", summary, got, want)
		}
	}
}

func text(r *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}
