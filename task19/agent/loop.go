// Package agent runs a tool-calling conversation: DeepSeek decides, MCP
// executes. Nothing here knows which tools exist; they arrive through
// tools/list from however many servers are connected.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task19/llm"
)

const DefaultMaxRounds = 8

type Observer struct {
	ToolCall   func(step int, name, server string, args json.RawMessage, handoffs []Handoff)
	ToolResult func(step ChainStep, r ToolOutcome)
	RoundCap   func(max int)
}

type ToolOutcome struct {
	Result   *mcp.CallToolResult // nil when the call never reached the server
	Err      error               // protocol / local failure
	ForModel string              // exactly the text appended as the tool message
	Duration time.Duration
}

type Agent struct {
	LLM       *llm.DeepSeek
	Router    *Router
	MaxRounds int
	Obs       Observer
	System    string

	fnTools []llm.FunctionTool
	history []llm.Message
	Chain   *Chain    // the current turn's calls
	Usage   llm.Usage // cumulative
	Calls   int       // model requests made, cumulative
}

func New(model *llm.DeepSeek, router *Router, system string, obs Observer) *Agent {
	a := &Agent{LLM: model, Router: router, MaxRounds: DefaultMaxRounds, Obs: obs, System: system}
	a.fnTools = ToFunctionTools(router.Tools())
	a.history = []llm.Message{{Role: "system", Content: system}}
	a.Chain = &Chain{}
	return a
}

func ToFunctionTools(tools []*mcp.Tool) []llm.FunctionTool {
	out := make([]llm.FunctionTool, 0, len(tools))
	for _, t := range tools {
		params := t.InputSchema
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, llm.FunctionTool{
			Type:     "function",
			Function: llm.FunctionDef{Name: t.Name, Description: t.Description, Parameters: params},
		})
	}
	return out
}

// Ask runs one user message to a final answer. Each Ask starts a new chain.
func (a *Agent) Ask(ctx context.Context, question string) (string, error) {
	mark := len(a.history)
	a.history = append(a.history, llm.Message{Role: "user", Content: question})
	a.Chain = &Chain{}

	for round := 0; ; round++ {
		tools := a.fnTools
		if round == a.MaxRounds {
			tools = nil
		}
		msg, usage, err := a.LLM.Complete(ctx, a.history, tools)
		a.Usage.Add(usage)
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

func (a *Agent) callTool(ctx context.Context, tc llm.ToolCall) ToolOutcome {
	name := tc.Function.Name
	raw := json.RawMessage(strings.TrimSpace(tc.Function.Arguments))
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	var args map[string]any
	argErr := json.Unmarshal(raw, &args)
	handoffs := a.Chain.Inspect(args)

	server := ""
	if s := a.Router.Owner(name); s != nil {
		server = s.Name()
	}
	if a.Obs.ToolCall != nil {
		a.Obs.ToolCall(len(a.Chain.Steps)+1, name, server, raw, handoffs)
	}

	var out ToolOutcome
	switch {
	case server == "":
		err := fmt.Errorf("unknown tool %q", name)
		out = ToolOutcome{Err: err, ForModel: errorJSON(err.Error())}
	case argErr != nil:
		err := fmt.Errorf("arguments are not a JSON object: %v", argErr)
		out = ToolOutcome{Err: err, ForModel: errorJSON(err.Error())}
	default:
		start := time.Now()
		res, err := a.Router.Call(ctx, name, args)
		out = ToolOutcome{Result: res, Err: err, Duration: time.Since(start)}
		if err != nil {
			out.ForModel = errorJSON(err.Error())
		} else {
			out.ForModel = ResultForModel(res)
		}
	}

	ok := out.Err == nil && out.Result != nil && !out.Result.IsError
	var structured any
	if out.Result != nil {
		structured = out.Result.StructuredContent
	}
	step := a.Chain.Record(name, args, handoffs, ok, out.ForModel, structured)
	if a.Obs.ToolResult != nil {
		a.Obs.ToolResult(step, out)
	}
	return out
}

// ResultForModel is the tool's text content. Structured metadata stays in
// the trace: the text is what a tool produced, and what the next tool in a
// chain should receive.
func ResultForModel(r *mcp.CallToolResult) string {
	if r.IsError {
		return errorJSON(ResultText(r))
	}
	return ResultText(r)
}

func ResultText(r *mcp.CallToolResult) string {
	var parts []string
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			parts = append(parts, tc.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func toolMessage(id, content string) llm.Message {
	return llm.Message{Role: "tool", ToolCallID: id, Content: content}
}

func errorJSON(msg string) string {
	b, _ := json.Marshal(map[string]string{"error": msg})
	return string(b)
}
