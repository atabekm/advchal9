package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const DefaultMaxRounds = 6

// DefaultSystemPrompt is used when Agent.System is empty.
const DefaultSystemPrompt = `You are a helpful assistant with access to tools provided by an MCP server.
Use the tools whenever a question depends on facts they can provide; do not answer such questions from memory.
Base your answer on the tool results, mention identifiers or links they return when useful, and say plainly when a tool finds nothing.
If a tool returns an error, read it, correct your arguments and try again, or explain the problem to the user.`

// Step is one observed MCP request, measured by client middleware.
type Step struct {
	Method   string
	Duration time.Duration
	Err      error
}

// Observer receives events as they happen so the UI can render a live trace.
// All methods are optional (nil funcs are skipped).
type Observer struct {
	MCP        func(Step)
	ToolCall   func(name string, args json.RawMessage)
	ToolResult func(name string, r ToolOutcome)
	RoundCap   func(max int)
}

// ToolOutcome is what one tools/call produced, as the model will see it.
type ToolOutcome struct {
	Result   *mcp.CallToolResult // nil when the call never reached the server
	Err      error               // protocol / local failure
	ForModel string              // exactly the text appended as the tool message
	Duration time.Duration
}

// Agent holds one MCP session, the tool catalogue and the conversation.
type Agent struct {
	LLM       *DeepSeek
	Session   *mcp.ClientSession
	Tools     []*mcp.Tool
	MaxRounds int
	Obs       Observer
	System    string // system prompt; DefaultSystemPrompt when empty

	fnTools []FunctionTool
	history []Message
	Usage   Usage // cumulative
	Calls   int   // model requests made, cumulative
}

// Connect performs the MCP handshake over transport and lists the tools.
// Every JSON-RPC request is reported to obs.MCP with its real duration.
func Connect(ctx context.Context, name string, transport mcp.Transport, obs Observer) (*mcp.ClientSession, []*mcp.Tool, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: name, Version: "0.1.0"}, nil)
	var mu sync.Mutex
	client.AddSendingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			start := time.Now()
			res, err := next(ctx, method, req)
			if obs.MCP != nil {
				mu.Lock()
				obs.MCP(Step{Method: method, Duration: time.Since(start), Err: err})
				mu.Unlock()
			}
			return res, err
		}
	})
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("mcp handshake: %w", err)
	}
	var tools []*mcp.Tool
	for t, err := range session.Tools(ctx, nil) {
		if err != nil {
			session.Close()
			return nil, nil, fmt.Errorf("tools/list: %w", err)
		}
		tools = append(tools, t)
	}
	return session, tools, nil
}

func New(llm *DeepSeek, session *mcp.ClientSession, tools []*mcp.Tool, obs Observer) *Agent {
	a := &Agent{LLM: llm, Session: session, Tools: tools, MaxRounds: DefaultMaxRounds, Obs: obs}
	a.fnTools = ToFunctionTools(tools)
	a.Reset()
	return a
}

// ToFunctionTools maps MCP tool definitions onto chat-completions functions.
// The input schema is forwarded verbatim: bounds, defaults and descriptions
// the server declared reach the model unchanged.
func ToFunctionTools(tools []*mcp.Tool) []FunctionTool {
	out := make([]FunctionTool, 0, len(tools))
	for _, t := range tools {
		params := t.InputSchema
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, FunctionTool{
			Type:     "function",
			Function: FunctionDef{Name: t.Name, Description: t.Description, Parameters: params},
		})
	}
	return out
}

// Reset clears the conversation, keeping the system prompt.
func (a *Agent) Reset() {
	sys := a.System
	if sys == "" {
		sys = DefaultSystemPrompt
	}
	a.history = []Message{{Role: "system", Content: sys}}
}

// Ask runs one user turn to completion: model → tools → model … → answer.
// On failure the turn is rolled back so the history stays well-formed.
func (a *Agent) Ask(ctx context.Context, question string) (string, error) {
	mark := len(a.history)
	a.history = append(a.history, Message{Role: "user", Content: question})

	for round := 0; ; round++ {
		tools := a.fnTools
		if round == a.MaxRounds {
			// Budget spent: withhold tools so the model must answer with what it has.
			tools = nil
		}
		msg, usage, err := a.LLM.Complete(ctx, a.history, tools)
		a.Usage.add(usage)
		a.Calls++
		if err != nil {
			a.history = a.history[:mark]
			return "", err
		}
		a.history = append(a.history, msg)
		if len(msg.ToolCalls) == 0 {
			return strings.TrimSpace(msg.Content), nil
		}
		if round == a.MaxRounds {
			// Tools were withheld yet it still asked; answer every call so the
			// history stays valid, and stop.
			for _, tc := range msg.ToolCalls {
				a.history = append(a.history, toolMessage(tc.ID, errorJSON("tool budget exhausted")))
			}
			if s := strings.TrimSpace(msg.Content); s != "" {
				return s, nil
			}
			return "(no answer: the tool budget ran out before the model finished)", nil
		}
		for _, tc := range msg.ToolCalls {
			out := a.callTool(ctx, tc)
			a.history = append(a.history, toolMessage(tc.ID, out.ForModel))
		}
		if round+1 == a.MaxRounds && a.Obs.RoundCap != nil {
			a.Obs.RoundCap(a.MaxRounds)
		}
	}
}

func (a *Agent) callTool(ctx context.Context, tc ToolCall) ToolOutcome {
	name := tc.Function.Name
	args := json.RawMessage(strings.TrimSpace(tc.Function.Arguments))
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	if a.Obs.ToolCall != nil {
		a.Obs.ToolCall(name, args)
	}
	out := a.execute(ctx, name, args)
	if a.Obs.ToolResult != nil {
		a.Obs.ToolResult(name, out)
	}
	return out
}

func (a *Agent) execute(ctx context.Context, name string, args json.RawMessage) ToolOutcome {
	if !a.hasTool(name) {
		err := fmt.Errorf("unknown tool %q", name)
		return ToolOutcome{Err: err, ForModel: errorJSON(err.Error())}
	}
	var argMap map[string]any
	if err := json.Unmarshal(args, &argMap); err != nil {
		err = fmt.Errorf("arguments are not a JSON object: %v", err)
		return ToolOutcome{Err: err, ForModel: errorJSON(err.Error())}
	}
	start := time.Now()
	res, err := a.Session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: argMap})
	d := time.Since(start)
	if err != nil {
		return ToolOutcome{Err: err, Duration: d, ForModel: errorJSON(err.Error())}
	}
	return ToolOutcome{Result: res, Duration: d, ForModel: ResultForModel(res)}
}

func (a *Agent) hasTool(name string) bool {
	for _, t := range a.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// ResultForModel renders a CallToolResult as the tool message content.
// Structured output wins when present; a tool error is wrapped so the model
// can tell failure from data and act on the reason.
func ResultForModel(r *mcp.CallToolResult) string {
	if r.IsError {
		return errorJSON(ResultText(r))
	}
	if r.StructuredContent != nil {
		if b, err := json.Marshal(r.StructuredContent); err == nil {
			return string(b)
		}
	}
	return ResultText(r)
}

// ResultText concatenates the text blocks of a result.
func ResultText(r *mcp.CallToolResult) string {
	var parts []string
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			parts = append(parts, tc.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func toolMessage(id, content string) Message {
	return Message{Role: "tool", ToolCallID: id, Content: content}
}

func errorJSON(msg string) string {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return string(b)
}

var ErrNoKey = errors.New("DEEPSEEK_API_KEY is not set")
