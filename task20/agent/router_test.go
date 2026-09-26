package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoIn struct {
	Text string `json:"text"`
}

// serverWith starts an in-memory server whose tools answer "<server>:<tool>".
func serverWith(t *testing.T, name string, tools ...string) *Server {
	t.Helper()
	s := mcp.NewServer(&mcp.Implementation{Name: name, Version: "1"}, nil)
	for _, tool := range tools {
		mcp.AddTool(s, &mcp.Tool{Name: tool}, func(context.Context, *mcp.CallToolRequest, echoIn) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: name + ":" + tool}}}, nil, nil
		})
	}
	ct, st := mcp.NewInMemoryTransports()
	if _, err := s.Connect(context.Background(), st, nil); err != nil {
		t.Fatal(err)
	}
	srv, err := Connect(context.Background(), "test", "mem://"+name, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Session.Close() })
	return srv
}

func TestRouterNamespacesAndRoutes(t *testing.T) {
	a, b := serverWith(t, "alphaserver", "one", "two"), serverWith(t, "beta", "three")
	r, err := NewRouter([]*Server{a, nil, b})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range r.Tools() {
		names = append(names, tl.Name)
	}
	if strings.Join(names, ",") != "alpha__one,alpha__two,beta__three" || len(r.Servers()) != 2 {
		t.Errorf("tools %v servers %d", names, len(r.Servers()))
	}
	if d := r.Tools()[0].Description; !strings.HasPrefix(d, "[alphaserver] ") {
		t.Errorf("description %q should name the server", d)
	}
	// The server's own list is untouched: namespacing is the client's view.
	if a.Tools[0].Name != "one" {
		t.Errorf("server tool renamed to %q", a.Tools[0].Name)
	}
	for tool, want := range map[string]string{"alpha__two": "alphaserver:two", "beta__three": "beta:three"} {
		res, err := r.Call(context.Background(), tool, map[string]any{"text": "x"})
		if err != nil || ResultText(res) != want {
			t.Errorf("%s → %v %v", tool, ResultText(res), err)
		}
	}
	for _, bad := range []string{"two", "beta__one", "gamma__three"} {
		if _, err := r.Call(context.Background(), bad, nil); err == nil {
			t.Errorf("%s must fail", bad)
		}
	}
	if rt, ok := r.Resolve("beta__three"); !ok || rt.Target() != "beta.three" {
		t.Errorf("resolve %+v %v", rt, ok)
	}
}

// Two servers offering a tool by the same name is fine: each call reaches
// the server its prefix names, under the name that server knows.
func TestRouterSameToolNameOnTwoServers(t *testing.T) {
	r, err := NewRouter([]*Server{serverWith(t, "wikiserver", "search"), serverWith(t, "hnserver", "search")})
	if err != nil {
		t.Fatal(err)
	}
	for tool, want := range map[string]string{"wiki__search": "wikiserver:search", "hn__search": "hnserver:search"} {
		res, err := r.Call(context.Background(), tool, map[string]any{"text": "x"})
		if err != nil || ResultText(res) != want {
			t.Errorf("%s → %q %v", tool, ResultText(res), err)
		}
	}
}

func TestRouterPrefixClash(t *testing.T) {
	_, err := NewRouter([]*Server{serverWith(t, "alpha", "one"), serverWith(t, "alphaserver", "two")})
	if err == nil || !strings.Contains(err.Error(), `prefix "alpha" is used by both alpha`) || !strings.Contains(err.Error(), "alphaserver") {
		t.Errorf("want a clash naming both servers, got %v", err)
	}
	// An explicit prefix resolves it.
	b := serverWith(t, "alphaserver", "two")
	b.Prefix = "a2"
	r, err := NewRouter([]*Server{serverWith(t, "alpha", "one"), b})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Resolve("a2__two"); !ok {
		t.Error("a2__two not routed")
	}
}

func TestRouterRejectsNamesModelsRefuse(t *testing.T) {
	s := serverWith(t, "alpha", "has.dot")
	if _, err := NewRouter([]*Server{s}); err == nil || !strings.Contains(err.Error(), "alpha__has.dot") {
		t.Errorf("want the bad name reported, got %v", err)
	}
}

func TestDefaultPrefix(t *testing.T) {
	for in, want := range map[string]string{
		"searchserver": "search", "fileserver": "file", "Text Server": "text", "server": "srv", "my.tools": "my_tools",
	} {
		if got := DefaultPrefix(in); got != want {
			t.Errorf("DefaultPrefix(%q) = %q, want %q", in, got, want)
		}
	}
}
