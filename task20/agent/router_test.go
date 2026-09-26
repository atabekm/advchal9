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

func TestRouterMergesAndRoutes(t *testing.T) {
	a, b := serverWith(t, "alpha", "one", "two"), serverWith(t, "beta", "three")
	r, err := NewRouter([]*Server{a, nil, b})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range r.Tools() {
		names = append(names, tl.Name)
	}
	if strings.Join(names, ",") != "one,two,three" || len(r.Servers()) != 2 {
		t.Errorf("tools %v servers %d", names, len(r.Servers()))
	}
	for tool, want := range map[string]string{"two": "alpha:two", "three": "beta:three"} {
		res, err := r.Call(context.Background(), tool, map[string]any{"text": "x"})
		if err != nil || ResultText(res) != want {
			t.Errorf("%s → %v %v", tool, ResultText(res), err)
		}
	}
	if _, err := r.Call(context.Background(), "four", nil); err == nil {
		t.Error("unknown tool must fail")
	}
}

func TestRouterCollision(t *testing.T) {
	_, err := NewRouter([]*Server{serverWith(t, "alpha", "search"), serverWith(t, "beta", "search")})
	if err == nil || !strings.Contains(err.Error(), `"search" is offered by both alpha`) || !strings.Contains(err.Error(), "beta") {
		t.Errorf("want a collision naming both servers, got %v", err)
	}
}
