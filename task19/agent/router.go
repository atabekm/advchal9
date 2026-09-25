package agent

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Server is one connected MCP server and the tools it offered.
type Server struct {
	URL     string
	Session *mcp.ClientSession
	Tools   []*mcp.Tool
}

// Name is what the server calls itself, or its URL before the handshake.
func (s *Server) Name() string {
	if s.Session != nil {
		if ir := s.Session.InitializeResult(); ir != nil && ir.ServerInfo != nil {
			return ir.ServerInfo.Name
		}
	}
	return s.URL
}

// Router merges the tool lists of several servers into one and sends each
// call to the server that owns the tool. The model sees a single list and
// never learns that the tools live apart.
type Router struct {
	servers []*Server
	owner   map[string]*Server
	tools   []*mcp.Tool
}

// NewRouter fails when two servers offer a tool with the same name: a call
// by that name would be ambiguous, and picking one silently would hide it.
func NewRouter(servers []*Server) (*Router, error) {
	r := &Router{owner: map[string]*Server{}}
	for _, s := range servers {
		if s == nil || s.Session == nil {
			continue
		}
		for _, t := range s.Tools {
			if prev, ok := r.owner[t.Name]; ok {
				return nil, fmt.Errorf("tool %q is offered by both %s (%s) and %s (%s)",
					t.Name, prev.Name(), prev.URL, s.Name(), s.URL)
			}
			r.owner[t.Name] = s
			r.tools = append(r.tools, t)
		}
		r.servers = append(r.servers, s)
	}
	return r, nil
}

func (r *Router) Tools() []*mcp.Tool        { return r.tools }
func (r *Router) Servers() []*Server        { return r.servers }
func (r *Router) Owner(tool string) *Server { return r.owner[tool] }

func (r *Router) Call(ctx context.Context, name string, args map[string]any) (*mcp.CallToolResult, error) {
	s := r.owner[name]
	if s == nil {
		return nil, fmt.Errorf("unknown tool %q", name)
	}
	return s.Session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
}

// Step is one MCP request as seen by the client, for the trace.
type Step struct {
	Method   string
	Duration time.Duration
	Err      error
}

// Connect performs the handshake with one server and lists its tools.
func Connect(ctx context.Context, name, url string, transport mcp.Transport, onStep func(Step)) (*Server, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: name, Version: "0.1.0"}, nil)
	var mu sync.Mutex
	client.AddSendingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			start := time.Now()
			res, err := next(ctx, method, req)
			if onStep != nil {
				mu.Lock()
				onStep(Step{Method: method, Duration: time.Since(start), Err: err})
				mu.Unlock()
			}
			return res, err
		}
	})
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return nil, fmt.Errorf("mcp handshake: %w", err)
	}
	s := &Server{URL: url, Session: session}
	for t, err := range session.Tools(ctx, nil) {
		if err != nil {
			session.Close()
			return nil, fmt.Errorf("tools/list: %w", err)
		}
		s.Tools = append(s.Tools, t)
	}
	return s, nil
}
