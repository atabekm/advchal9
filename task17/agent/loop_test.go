package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task17/openlibrary"
)

// fakeLLM replays scripted assistant messages and records every request.
type fakeLLM struct {
	mu       sync.Mutex
	script   []Message
	requests []chatRequest
	status   int // non-zero: fail every request with this code
}

func (f *fakeLLM) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, req)
	if f.status != 0 {
		w.WriteHeader(f.status)
		fmt.Fprint(w, `{"error": {"message": "boom"}}`)
		return
	}
	if len(f.script) == 0 {
		w.WriteHeader(500)
		fmt.Fprint(w, `{"error": {"message": "script exhausted"}}`)
		return
	}
	msg := f.script[0]
	f.script = f.script[1:]
	json.NewEncoder(w).Encode(map[string]any{
		"choices": []any{map[string]any{"message": msg}},
		"usage":   map[string]int{"prompt_tokens": 100, "completion_tokens": 10},
	})
}

func toolCall(id, name, args string) Message {
	return Message{Role: "assistant", ToolCalls: []ToolCall{{ID: id, Type: "function", Function: FunctionCall{Name: name, Arguments: args}}}}
}

func answer(s string) Message { return Message{Role: "assistant", Content: s} }

type rig struct {
	agent  *Agent
	llm    *fakeLLM
	events []string
}

// newRig wires the real olserver (against a fake Open Library) to the agent
// over in-memory MCP transports, with a scripted fake DeepSeek.
func newRig(t *testing.T, script ...Message) *rig {
	t.Helper()
	ol := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search.json":
			fmt.Fprint(w, `{"numFound": 11, "docs": [{"key": "/works/OL59798W", "title": "A Wizard of Earthsea", "author_name": ["Ursula K. Le Guin"], "first_publish_year": 1968, "edition_count": 180}]}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error": "notfound"}`)
		}
	}))
	t.Cleanup(ol.Close)
	olc := openlibrary.NewClient()
	olc.BaseURL = ol.URL

	ctx := context.Background()
	st, ct := mcp.NewInMemoryTransports()
	ss, err := openlibrary.NewServer(olc).Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })

	r := &rig{llm: &fakeLLM{script: script}}
	var mcpMethods []string
	obs := Observer{
		MCP:        func(s Step) { mcpMethods = append(mcpMethods, s.Method) },
		ToolCall:   func(name string, args json.RawMessage) { r.events = append(r.events, "call "+name+" "+string(args)) },
		ToolResult: func(name string, o ToolOutcome) { r.events = append(r.events, "result "+name+" "+o.ForModel) },
		RoundCap:   func(n int) { r.events = append(r.events, fmt.Sprintf("cap %d", n)) },
	}
	session, tools, err := Connect(ctx, ct, obs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	if !contains(mcpMethods, "tools/list") {
		t.Fatalf("handshake trace = %v, want tools/list", mcpMethods)
	}

	llmSrv := httptest.NewServer(r.llm)
	t.Cleanup(llmSrv.Close)
	ds := NewDeepSeek("test-key", "deepseek-flash")
	ds.BaseURL = llmSrv.URL
	r.agent = New(ds, session, tools, obs)
	return r
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func TestToolsForwardedToModelFromTheHandshake(t *testing.T) {
	r := newRig(t, answer("hi"))
	if _, err := r.agent.Ask(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	req := r.llm.requests[0]
	if len(req.Tools) != 2 {
		t.Fatalf("tools sent = %d", len(req.Tools))
	}
	byName := map[string]FunctionTool{}
	for _, ft := range req.Tools {
		byName[ft.Function.Name] = ft
	}
	params, _ := json.Marshal(byName["search_books"].Function.Parameters)
	// Server-declared bounds and defaults must reach the model verbatim.
	for _, want := range []string{`"limit"`, `"maximum":20`, `"default":5`, `"year_from"`} {
		if !strings.Contains(string(params), want) {
			t.Errorf("search_books parameters lack %s: %s", want, params)
		}
	}
	if byName["get_work"].Type != "function" || byName["get_work"].Function.Description == "" {
		t.Errorf("get_work = %+v", byName["get_work"])
	}
	if req.Messages[0].Role != "system" || req.Model != "deepseek-flash" {
		t.Errorf("request = %+v", req)
	}
}

func TestToolCallRoundTrip(t *testing.T) {
	r := newRig(t,
		toolCall("call_1", "search_books", `{"author":"Ursula K. Le Guin","year_from":1960,"year_to":1969}`),
		answer("She published A Wizard of Earthsea in 1968."),
	)
	got, err := r.agent.Ask(context.Background(), "Le Guin in the 60s?")
	if err != nil {
		t.Fatal(err)
	}
	if got != "She published A Wizard of Earthsea in 1968." {
		t.Errorf("answer = %q", got)
	}
	if len(r.llm.requests) != 2 {
		t.Fatalf("model calls = %d", len(r.llm.requests))
	}
	// The second request must carry the assistant's tool call and our result.
	msgs := r.llm.requests[1].Messages
	last := msgs[len(msgs)-1]
	if last.Role != "tool" || last.ToolCallID != "call_1" {
		t.Fatalf("last message = %+v", last)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(last.Content), &result); err != nil {
		t.Fatalf("tool content is not JSON: %s", last.Content)
	}
	if result["total_found"] != 11.0 || !strings.Contains(last.Content, "OL59798W") {
		t.Errorf("tool content = %s", last.Content)
	}
	if prev := msgs[len(msgs)-2]; prev.Role != "assistant" || len(prev.ToolCalls) != 1 {
		t.Errorf("assistant tool-call message missing: %+v", prev)
	}
	if r.agent.Calls != 2 || r.agent.Usage.PromptTokens != 200 {
		t.Errorf("calls=%d usage=%+v", r.agent.Calls, r.agent.Usage)
	}
}

func TestToolErrorIsForwardedForRecovery(t *testing.T) {
	r := newRig(t,
		toolCall("c1", "search_books", `{}`),
		toolCall("c2", "search_books", `{"author":"Le Guin"}`),
		answer("done"),
	)
	if _, err := r.agent.Ask(context.Background(), "books?"); err != nil {
		t.Fatal(err)
	}
	msgs := r.llm.requests[1].Messages
	errMsg := msgs[len(msgs)-1]
	var e map[string]string
	if json.Unmarshal([]byte(errMsg.Content), &e) != nil || !strings.Contains(e["error"], "at least one of") {
		t.Errorf("tool error sent to model = %s", errMsg.Content)
	}
	msgs = r.llm.requests[2].Messages
	if !strings.Contains(msgs[len(msgs)-1].Content, "total_found") {
		t.Errorf("retry result = %s", msgs[len(msgs)-1].Content)
	}
}

func TestUnknownToolAndBadArguments(t *testing.T) {
	r := newRig(t,
		Message{Role: "assistant", ToolCalls: []ToolCall{
			{ID: "a", Type: "function", Function: FunctionCall{Name: "delete_library", Arguments: `{}`}},
			{ID: "b", Type: "function", Function: FunctionCall{Name: "search_books", Arguments: `{"author": `}},
		}},
		answer("sorry"),
	)
	if _, err := r.agent.Ask(context.Background(), "x"); err != nil {
		t.Fatal(err)
	}
	msgs := r.llm.requests[1].Messages
	a, b := msgs[len(msgs)-2], msgs[len(msgs)-1]
	if a.ToolCallID != "a" || !strings.Contains(a.Content, `unknown tool`) {
		t.Errorf("unknown tool reply = %+v", a)
	}
	if b.ToolCallID != "b" || !strings.Contains(b.Content, "not a JSON object") {
		t.Errorf("bad args reply = %+v", b)
	}
}

func TestRoundCapWithholdsTools(t *testing.T) {
	loop := toolCall("x", "search_books", `{"query":"dune"}`)
	r := newRig(t, loop, loop, answer("best effort"))
	r.agent.MaxRounds = 2
	got, err := r.agent.Ask(context.Background(), "x")
	if err != nil {
		t.Fatal(err)
	}
	if got != "best effort" || len(r.llm.requests) != 3 {
		t.Fatalf("answer=%q requests=%d", got, len(r.llm.requests))
	}
	if len(r.llm.requests[1].Tools) == 0 || len(r.llm.requests[2].Tools) != 0 {
		t.Error("tools should be offered for rounds 1–2 and withheld on the final request")
	}
	if !contains(r.events, "cap 2") {
		t.Errorf("events = %v", r.events)
	}
}

func TestRoundCapWhenModelIgnoresIt(t *testing.T) {
	loop := toolCall("x", "search_books", `{"query":"dune"}`)
	r := newRig(t, loop, loop)
	r.agent.MaxRounds = 1
	got, err := r.agent.Ask(context.Background(), "x")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "tool budget") {
		t.Errorf("answer = %q", got)
	}
	// History stays valid: every tool call has a reply.
	h := r.agent.History()
	if last := h[len(h)-1]; last.Role != "tool" || last.ToolCallID != "x" {
		t.Errorf("last = %+v", last)
	}
}

func TestHistoryPersistsAndFailureRollsBack(t *testing.T) {
	r := newRig(t, answer("first"), answer("second"))
	r.agent.Ask(context.Background(), "q1")
	r.agent.Ask(context.Background(), "q2")
	msgs := r.llm.requests[1].Messages
	if len(msgs) != 4 || msgs[2].Content != "first" || msgs[3].Content != "q2" {
		t.Fatalf("second request messages = %+v", msgs)
	}

	before := len(r.agent.History())
	r.llm.status = 401
	_, err := r.agent.Ask(context.Background(), "q3")
	if err == nil || !strings.Contains(err.Error(), "DEEPSEEK_API_KEY") {
		t.Errorf("err = %v", err)
	}
	if len(r.agent.History()) != before {
		t.Errorf("failed turn left %d messages behind", len(r.agent.History())-before)
	}

	r.agent.Reset()
	if r.agent.Turns() != 0 || len(r.agent.History()) != 1 {
		t.Errorf("reset history = %+v", r.agent.History())
	}
}

func TestReasoningContentIsRoundTripped(t *testing.T) {
	tc := toolCall("r1", "search_books", `{"query":"dune"}`)
	tc.ReasoningContent = "I should search."
	r := newRig(t, tc, answer("ok"))
	r.agent.Ask(context.Background(), "x")
	for _, m := range r.llm.requests[1].Messages {
		if m.Role == "assistant" && m.ReasoningContent == "I should search." {
			return
		}
	}
	t.Error("reasoning_content was dropped from the tool-calling turn")
}

func TestSummarize(t *testing.T) {
	res := &mcp.CallToolResult{StructuredContent: map[string]any{
		"total_found": 11.0, "returned": 5.0, "books": []any{1, 2, 3, 4, 5},
	}}
	if got := Summarize(res, 100); got != "returned=5 total_found=11 books[5]" {
		t.Errorf("summary = %q", got)
	}
	res = &mcp.CallToolResult{StructuredContent: map[string]any{
		"title": "Dune", "work_id": "OL893414W", "description": "long…", "url": "https://x", "subjects": []any{"a"},
	}}
	if got := Summarize(res, 100); got != `title="Dune" work_id="OL893414W" subjects[1]` {
		t.Errorf("summary = %q", got)
	}
	errRes := &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "no work\nwith id"}}}
	if got := Summarize(errRes, 100); got != "no work with id" {
		t.Errorf("error summary = %q", got)
	}
}
