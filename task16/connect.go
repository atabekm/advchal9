package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Step is one observed JSON-RPC exchange. Every field is measured: the method
// name comes from the SDK's middleware hook and the duration is wall time
// around the call, so nothing here is reconstructed after the fact.
type Step struct {
	Method   string
	Duration time.Duration
	Err      error

	// Unsupported marks a method the server answered with JSON-RPC -32601.
	// That is a negotiation outcome, not a fault: the SDK probes for optional
	// methods, and an older server declining one is normal. Rendering it as a
	// failure would make a healthy connection look broken.
	Unsupported bool

	// First marks the opening round trip, whose duration also contains the
	// child process booting. On a cold `npx` that is seconds against
	// milliseconds for everything after it, and leaving it unexplained makes
	// the protocol look slow when the cost was actually starting Node.
	First bool
}

// tracer collects steps as they happen and reports each one the moment it
// resolves, so a hang is visible at the method that hung.
type tracer struct {
	mu      sync.Mutex
	steps   []Step
	onStep  func(Step)
	onStart func(method string)

	sawFirst bool
}

func (t *tracer) middleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		start := time.Now()

		// The SDK spawns the child inside Connect and no exported hook fires
		// when the process is up, so there is no honest way to time the spawn
		// separately. What is true is that the first round trip waits for it —
		// so that step is flagged and labelled rather than having an invented
		// "spawn" duration placed in front of it.
		t.mu.Lock()
		first := !t.sawFirst
		t.sawFirst = true
		t.mu.Unlock()

		if t.onStart != nil {
			t.onStart(method)
		}
		res, err := next(ctx, method, req)
		t.record(Step{
			Method:      method,
			Duration:    time.Since(start),
			Err:         err,
			Unsupported: isMethodNotFound(err),
			First:       first,
		})
		return res, err
	}
}

// isMethodNotFound detects JSON-RPC -32601. The SDK surfaces the condition as
// a formatted string rather than a typed error, so the text is what there is
// to match on.
func isMethodNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "method not found") || strings.Contains(msg, "-32601")
}

func (t *tracer) record(s Step) {
	t.mu.Lock()
	t.steps = append(t.steps, s)
	cb := t.onStep
	t.mu.Unlock()
	if cb != nil {
		cb(s)
	}
}

func (t *tracer) snapshot() []Step {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]Step{}, t.steps...)
}

// Inspection is everything one run learned from a server.
type Inspection struct {
	Command string
	Args    []string
	Init    *mcp.InitializeResult
	Tools   []*mcp.Tool
	Steps   []Step
	Elapsed time.Duration
}

// inspect runs the whole exchange: spawn, handshake, tools/list, close.
func inspect(ctx context.Context, entry ServerEntry, timeout time.Duration, onStep func(Step), onStart func(string)) (*Inspection, error) {
	// Resolve the executable first. Without this, a missing `npx` surfaces as
	// a broken-pipe error from deep inside the transport, which reads as a
	// protocol fault rather than a missing program.
	if _, err := exec.LookPath(entry.Command); err != nil {
		return nil, &connError{
			stage:  "spawn",
			msg:    fmt.Sprintf("%q is not in $PATH", entry.Command),
			detail: "Install it, or point mcpls at a different command with `mcpls -- <command> [args...]`.",
		}
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	started := time.Now()
	tr := &tracer{onStep: onStep, onStart: onStart}
	client := mcp.NewClient(&mcp.Implementation{
		Name:    "mcpls",
		Title:   "mcpls · MCP tool inspector",
		Version: version,
	}, nil)
	client.AddSendingMiddleware(tr.middleware)

	cmd := exec.Command(entry.Command, entry.Args...)
	cmd.Stderr = os.Stderr // server diagnostics stay visible instead of vanishing
	transport := &mcp.CommandTransport{Command: cmd}

	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, handshakeError(ctx, err, timeout)
	}
	defer session.Close()

	tools, err := listTools(ctx, session)
	if err != nil {
		return nil, &connError{
			stage:  "tools/list",
			msg:    err.Error(),
			detail: "The handshake succeeded, so the server is speaking MCP but refused or failed the tools/list call.",
		}
	}

	return &Inspection{
		Command: entry.Command,
		Args:    entry.Args,
		Init:    session.InitializeResult(),
		Tools:   tools,
		Steps:   tr.snapshot(),
		Elapsed: time.Since(started),
	}, nil
}

// listTools walks every page. Servers with many tools paginate, and a client
// that reads only the first page reports a truncated list as a complete one.
func listTools(ctx context.Context, session *mcp.ClientSession) ([]*mcp.Tool, error) {
	var tools []*mcp.Tool
	for tool, err := range session.Tools(ctx, nil) {
		if err != nil {
			return nil, err
		}
		tools = append(tools, tool)
	}
	return tools, nil
}

// connError carries a stage and a suggested next action, so a failure tells the
// reader what to do rather than only what broke.
type connError struct {
	stage  string
	msg    string
	detail string
}

func (e *connError) Error() string { return e.msg }

func handshakeError(ctx context.Context, err error, timeout time.Duration) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &connError{
			stage: "initialize",
			msg:   fmt.Sprintf("server did not complete the handshake within %s", timeout),
			detail: "The first `npx` run downloads the package, which can take longer than this.\n" +
				"Retry, or raise the limit with --timeout 60s.",
		}
	}
	return &connError{
		stage:  "initialize",
		msg:    err.Error(),
		detail: "The process started but did not complete an MCP handshake. Run with -v to see the frames.",
	}
}

// --- JSON output -----------------------------------------------------------

func (i *Inspection) toJSON() ([]byte, error) {
	type jsonStep struct {
		Method      string `json:"method"`
		Millis      int64  `json:"durationMs"`
		Error       string `json:"error,omitempty"`
		Unsupported bool   `json:"unsupported,omitempty"`
	}
	out := struct {
		Command  string              `json:"command"`
		Args     []string            `json:"args"`
		Server   *mcp.Implementation `json:"serverInfo"`
		Protocol string              `json:"protocolVersion"`
		Caps     []string            `json:"capabilities"`
		Steps    []jsonStep          `json:"steps"`
		Tools    []*mcp.Tool         `json:"tools"`
		Millis   int64               `json:"elapsedMs"`
	}{
		Command:  i.Command,
		Args:     i.Args,
		Protocol: i.Init.ProtocolVersion,
		Caps:     capabilityNames(i.Init.Capabilities),
		Tools:    i.Tools,
		Millis:   i.Elapsed.Milliseconds(),
	}
	if i.Init != nil {
		out.Server = i.Init.ServerInfo
	}
	for _, s := range i.Steps {
		js := jsonStep{Method: s.Method, Millis: s.Duration.Milliseconds()}
		if s.Err != nil {
			js.Error = s.Err.Error()
			js.Unsupported = s.Unsupported
		}
		out.Steps = append(out.Steps, js)
	}
	return json.MarshalIndent(out, "", "  ")
}

func capabilityNames(c *mcp.ServerCapabilities) []string {
	if c == nil {
		return nil
	}
	var out []string
	if c.Tools != nil {
		out = append(out, "tools")
	}
	if c.Prompts != nil {
		out = append(out, "prompts")
	}
	if c.Resources != nil {
		out = append(out, "resources")
	}
	if c.Completions != nil {
		out = append(out, "completions")
	}
	if c.Logging != nil {
		out = append(out, "logging")
	}
	for name := range c.Experimental {
		out = append(out, "experimental:"+name)
	}
	return out
}
