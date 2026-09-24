package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task18/store"
	"task18/tools"
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

// newRig wires the real hnserver tools (on a temp database) to the agent over
// in-memory MCP transports, with a scripted fake DeepSeek.
func newRig(t *testing.T, script ...Message) *rig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hn.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	ctx := context.Background()
	sT, cT := mcp.NewInMemoryTransports()
	ss, err := tools.NewServer(tools.Deps{Store: st}).Connect(ctx, sT, nil)
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
	session, tl, err := Connect(ctx, "test", cT, obs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	if !slices.Contains(mcpMethods, "tools/list") {
		t.Fatalf("handshake trace = %v, want tools/list", mcpMethods)
	}

	llmSrv := httptest.NewServer(r.llm)
	t.Cleanup(llmSrv.Close)
	ds := NewDeepSeek("test-key", "deepseek-flash")
	ds.BaseURL = llmSrv.URL
	r.agent = New(ds, session, tl, obs)
	return r
}

func TestToolsForwardedToModelFromTheHandshake(t *testing.T) {
	r := newRig(t, answer("hi"))
	if _, err := r.agent.Ask(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	req := r.llm.requests[0]
	byName := map[string]FunctionTool{}
	for _, ft := range req.Tools {
		byName[ft.Function.Name] = ft
	}
	if len(byName) != 4 {
		t.Fatalf("tools sent = %v", byName)
	}
	params, _ := json.Marshal(byName["schedule_collection"].Function.Parameters)
	// Server-declared bounds and defaults must reach the model verbatim.
	for _, want := range []string{`"every"`, `"top_n"`, `"maximum":100`, `"default":30`} {
		if !strings.Contains(string(params), want) {
			t.Errorf("schedule_collection parameters lack %s: %s", want, params)
		}
	}
	if req.Messages[0].Role != "system" || req.Messages[0].Content != DefaultSystemPrompt {
		t.Errorf("system message = %+v", req.Messages[0])
	}
}

func TestCustomSystemPrompt(t *testing.T) {
	r := newRig(t, answer("hi"))
	r.agent.System = "You edit a newsletter."
	r.agent.Reset()
	r.agent.Ask(context.Background(), "hello")
	if got := r.llm.requests[0].Messages[0].Content; got != "You edit a newsletter." {
		t.Errorf("system = %q", got)
	}
}

func TestToolCallRoundTrip(t *testing.T) {
	r := newRig(t,
		toolCall("call_1", "schedule_collection", `{"every":"15m"}`),
		answer("Collecting every 15 minutes."),
	)
	got, err := r.agent.Ask(context.Background(), "collect HN")
	if err != nil {
		t.Fatal(err)
	}
	if got != "Collecting every 15 minutes." || len(r.llm.requests) != 2 {
		t.Fatalf("answer=%q requests=%d", got, len(r.llm.requests))
	}
	msgs := r.llm.requests[1].Messages
	last := msgs[len(msgs)-1]
	if last.Role != "tool" || last.ToolCallID != "call_1" {
		t.Fatalf("last message = %+v", last)
	}
	var result struct {
		Created bool `json:"created"`
		Job     struct {
			Every string `json:"every"`
		} `json:"job"`
	}
	if err := json.Unmarshal([]byte(last.Content), &result); err != nil || !result.Created || result.Job.Every != "15m" {
		t.Errorf("tool content = %s", last.Content)
	}
	if r.agent.Calls != 2 || r.agent.Usage.PromptTokens != 200 {
		t.Errorf("calls=%d usage=%+v", r.agent.Calls, r.agent.Usage)
	}
}

func TestToolErrorIsForwardedForRecovery(t *testing.T) {
	r := newRig(t,
		toolCall("c1", "schedule_collection", `{"every":"5s"}`),
		toolCall("c2", "schedule_collection", `{"every":"10s"}`),
		answer("done"),
	)
	if _, err := r.agent.Ask(context.Background(), "collect very often"); err != nil {
		t.Fatal(err)
	}
	msgs := r.llm.requests[1].Messages
	var e map[string]string
	if json.Unmarshal([]byte(msgs[len(msgs)-1].Content), &e) != nil || !strings.Contains(e["error"], "between 10s and 24h") {
		t.Errorf("tool error sent to model = %s", msgs[len(msgs)-1].Content)
	}
	msgs = r.llm.requests[2].Messages
	if !strings.Contains(msgs[len(msgs)-1].Content, `"created":true`) {
		t.Errorf("retry result = %s", msgs[len(msgs)-1].Content)
	}
}

func TestUnknownToolAndBadArguments(t *testing.T) {
	r := newRig(t,
		Message{Role: "assistant", ToolCalls: []ToolCall{
			{ID: "a", Type: "function", Function: FunctionCall{Name: "drop_database", Arguments: `{}`}},
			{ID: "b", Type: "function", Function: FunctionCall{Name: "get_summary", Arguments: `{"since": `}},
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
	loop := toolCall("x", "list_jobs", `{}`)
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
	if !slices.Contains(r.events, "cap 2") {
		t.Errorf("events = %v", r.events)
	}
}

func TestFailureRollsBack(t *testing.T) {
	r := newRig(t, answer("first"))
	r.agent.Ask(context.Background(), "q1")
	before := len(r.agent.history)
	r.llm.status = 401
	_, err := r.agent.Ask(context.Background(), "q2")
	if err == nil || !strings.Contains(err.Error(), "DEEPSEEK_API_KEY") {
		t.Errorf("err = %v", err)
	}
	if len(r.agent.history) != before {
		t.Errorf("failed turn left %d messages behind", len(r.agent.history)-before)
	}
}

func TestSummarize(t *testing.T) {
	res := &mcp.CallToolResult{StructuredContent: map[string]any{
		"stories_tracked": 30.0, "job_id": 1.0, "new_entries": []any{1, 2},
	}}
	if got := Summarize(res, 100); got != "job_id=1 stories_tracked=30 new_entries[2]" {
		t.Errorf("summary = %q", got)
	}
	errRes := &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "no job\nwith id 9"}}}
	if got := Summarize(errRes, 100); got != "no job with id 9" {
		t.Errorf("error summary = %q", got)
	}
}
