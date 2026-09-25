// Package mcpserve is the plumbing the three servers share: Streamable HTTP,
// a request log, the null-arguments guard and graceful shutdown. It holds no
// state; the tools stay independent of each other.
package mcpserve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/term"
)

// Config describes one server process.
type Config struct {
	Addr    string
	Server  *mcp.Server
	Name    string
	Version string
	Details [][2]string // extra banner lines, label → value
}

// Run serves cfg.Server at http://Addr/mcp until SIGINT/SIGTERM and returns
// the process exit code.
func Run(cfg Config) int {
	lg := NewLogger()
	cfg.Server.AddReceivingMiddleware(lg.Middleware)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		lg.Fail("listen: %v", err)
		return 1
	}
	httpServer := &http.Server{Handler: Handler(cfg.Server), ReadHeaderTimeout: 10 * time.Second}

	lg.l.Println()
	lg.l.Printf("  %s %s", lg.paint("1", cfg.Name), lg.paint("2", cfg.Version+" · MCP over Streamable HTTP"))
	lg.l.Printf("  %s http://%s/mcp", lg.paint("2", "endpoint"), cfg.Addr)
	for _, d := range cfg.Details {
		lg.l.Printf("  %s %s", lg.paint("2", fmt.Sprintf("%-8s", d[0])), d[1])
	}
	lg.l.Println()

	go func() {
		if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			lg.Fail("http: %v", err)
			stop()
		}
	}()

	<-ctx.Done()
	lg.Note("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	httpServer.Shutdown(shutdown)
	return 0
}

// Handler mounts the server at /mcp. Tests use it with httptest.
func Handler(s *mcp.Server) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, nil))
	return mux
}

// NullArgsAsEmpty turns `"arguments": null` (or absent) into {}. go-sdk
// v1.8.0 decodes null into a nil map and then panics writing schema defaults
// into it, which takes the whole server down.
func NullArgsAsEmpty(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if r, ok := req.(*mcp.CallToolRequest); ok && r.Params != nil {
			if a := bytes.TrimSpace(r.Params.Arguments); len(a) == 0 || bytes.Equal(a, []byte("null")) {
				r.Params.Arguments = json.RawMessage("{}")
			}
		}
		return next(ctx, method, req)
	}
}

// Text builds a tool result whose content is the given text. Structured
// output, if the tool has any, is added by the SDK next to it.
func Text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

// Schema infers the input schema of T. Bounds, defaults and enums can't be
// written as struct tags, so each tool adds them to the result.
func Schema[T any]() *jsonschema.Schema {
	s, err := jsonschema.For[T](nil)
	if err != nil {
		panic(err)
	}
	return s
}

func Ptr[T any](v T) *T { return &v }

// ------------------------------------------------------------------ logging

type Logger struct {
	color bool
	l     *log.Logger
}

func NewLogger() *Logger {
	return &Logger{
		color: term.IsTerminal(int(os.Stderr.Fd())) && os.Getenv("NO_COLOR") == "",
		l:     log.New(os.Stderr, "", 0),
	}
}

func (g *Logger) paint(code, s string) string {
	if !g.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (g *Logger) line(format string, a ...any) {
	g.l.Printf("%s  %s", g.paint("2", time.Now().Format("15:04:05")), fmt.Sprintf(format, a...))
}

// Middleware logs one line per tools/call: the arguments with long strings
// shortened, the outcome, and how long it took.
func (g *Logger) Middleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		start := time.Now()
		res, err := next(ctx, method, req)
		if r, ok := req.(*mcp.CallToolRequest); ok {
			mark, tail := g.paint("32", "✓"), ""
			if err != nil {
				mark, tail = g.paint("31", "✗"), " · "+err.Error()
			} else if cr, ok := res.(*mcp.CallToolResult); ok {
				if cr.IsError {
					mark = g.paint("31", "✗")
				}
				tail = " · " + clip(resultText(cr), 70)
			}
			g.line("%s %s %s · %s%s", mark, r.Params.Name, g.paint("2", ShortArgs(r.Params.Arguments, 40)),
				ms(time.Since(start)), g.paint("2", tail))
		}
		return res, err
	}
}

func (g *Logger) Note(format string, a ...any) { g.line("%s", g.paint("2", fmt.Sprintf(format, a...))) }
func (g *Logger) Fail(format string, a ...any) {
	g.line("%s %s", g.paint("31", "✗"), fmt.Sprintf(format, a...))
}

// ShortArgs renders tool arguments on one line, replacing each string longer
// than max with its first characters and its length, so a 5,000-character
// text argument reads as "Hacker News search… (5,012 chars)".
func ShortArgs(raw []byte, max int) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return clip(string(raw), 120)
	}
	for k, v := range m {
		if s, ok := v.(string); ok && len([]rune(s)) > max {
			r := []rune(s)
			m[k] = fmt.Sprintf("%s… (%s chars)", oneLine(string(r[:max])), thousands(len(r)))
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func resultText(r *mcp.CallToolResult) string {
	for _, c := range r.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			return oneLine(t.Text)
		}
	}
	return ""
}

func oneLine(s string) string {
	return string(bytes.Join(bytes.Fields([]byte(s)), []byte(" ")))
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func thousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func ms(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}
