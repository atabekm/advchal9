package agent

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Sep joins a server's prefix and a tool's own name: search__hackernews. A
// dot would read better, but OpenAI-style APIs (DeepSeek among them) accept
// only [a-zA-Z0-9_-] in function names.
const Sep = "__"

var (
	nameRE    = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	notNameRE = regexp.MustCompile(`[^a-z0-9_-]+`)
)

// Server is one connected MCP server and the tools it offered.
type Server struct {
	URL     string
	Prefix  string // namespace for its tools; DefaultPrefix(Name()) when empty
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

// Title is the server's human-readable title, or its name.
func (s *Server) Title() string {
	if s.Session != nil {
		if ir := s.Session.InitializeResult(); ir != nil && ir.ServerInfo != nil && ir.ServerInfo.Title != "" {
			return ir.ServerInfo.Title
		}
	}
	return s.Name()
}

// DefaultPrefix is the server's name without a "server" suffix:
// searchserver → search.
func DefaultPrefix(name string) string {
	p := strings.TrimSuffix(strings.ToLower(name), "server")
	p = strings.Trim(notNameRE.ReplaceAllString(p, "_"), "_-")
	if p == "" {
		return "srv"
	}
	return p
}

// Route is where a namespaced tool name leads.
type Route struct {
	Server *Server
	Tool   string // the name the server knows it by
}

// Target reads "searchserver.hackernews".
func (r Route) Target() string { return r.Server.Name() + "." + r.Tool }

// Router merges the tool lists of several servers into one, each tool under
// its server's prefix, and sends each call to that server by the tool's own
// name. Two servers may offer tools with the same name; the prefix tells
// them apart. The server never sees the prefix.
type Router struct {
	servers []*Server
	routes  map[string]Route
	tools   []*mcp.Tool // as offered to the model: namespaced names
}

// NewRouter fails when two servers share a prefix, or a namespaced name is
// not one a model API accepts: either would make calls ambiguous or
// impossible, and picking silently would hide it.
func NewRouter(servers []*Server) (*Router, error) {
	r := &Router{routes: map[string]Route{}}
	byPrefix := map[string]*Server{}
	for _, s := range servers {
		if s == nil || s.Session == nil {
			continue
		}
		if s.Prefix == "" {
			s.Prefix = DefaultPrefix(s.Name())
		}
		if prev, ok := byPrefix[s.Prefix]; ok {
			return nil, fmt.Errorf("prefix %q is used by both %s (%s) and %s (%s); set one with -servers prefix=url",
				s.Prefix, prev.Name(), prev.URL, s.Name(), s.URL)
		}
		byPrefix[s.Prefix] = s
		for _, t := range s.Tools {
			name := s.Prefix + Sep + t.Name
			if !nameRE.MatchString(name) {
				return nil, fmt.Errorf("tool %q of %s: namespaced name %q must match %s", t.Name, s.Name(), name, nameRE)
			}
			if _, dup := r.routes[name]; dup {
				return nil, fmt.Errorf("%s offers tool %q twice", s.Name(), t.Name)
			}
			r.routes[name] = Route{Server: s, Tool: t.Name}
			nt := *t
			nt.Name = name
			nt.Description = "[" + s.Title() + "] " + t.Description
			r.tools = append(r.tools, &nt)
		}
		r.servers = append(r.servers, s)
	}
	return r, nil
}

func (r *Router) Tools() []*mcp.Tool { return r.tools }
func (r *Router) Servers() []*Server { return r.servers }

// Resolve says where a namespaced name leads.
func (r *Router) Resolve(name string) (Route, bool) {
	rt, ok := r.routes[name]
	return rt, ok
}

func (r *Router) Call(ctx context.Context, name string, args map[string]any) (*mcp.CallToolResult, error) {
	rt, ok := r.routes[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool %q", name)
	}
	return rt.Server.Session.CallTool(ctx, &mcp.CallToolParams{Name: rt.Tool, Arguments: args})
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
