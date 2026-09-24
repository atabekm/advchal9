// hnserver collects the Hacker News top stories on a schedule and serves the
// history as MCP tools over Streamable HTTP. It runs on its own: collection
// continues whether or not any client is connected.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/term"

	"task18/hn"
	"task18/scheduler"
	"task18/store"
	"task18/tools"
)

func main() {
	addr := flag.String("addr", "localhost:8765", "listen address")
	dbPath := flag.String("db", "hn.db", "SQLite database file")
	flag.Parse()

	lg := newLogger()

	st, err := store.Open(*dbPath)
	if err != nil {
		lg.fail("opening %s: %v", *dbPath, err)
		os.Exit(1)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := hn.NewClient()
	sched := &scheduler.Scheduler{
		Store: st,
		Collect: func(ctx context.Context, j store.Job) (hn.Snapshot, error) {
			return client.Top(ctx, j.TopN)
		},
		OnRun:   lg.run,
		OnError: func(err error) { lg.fail("scheduler: %v (retrying)", err) },
	}

	server := tools.NewServer(tools.Deps{Store: st, Wake: sched.Wake})
	server.AddReceivingMiddleware(lg.middleware)
	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		lg.fail("listen: %v", err)
		os.Exit(1)
	}
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	jobs, _ := st.Jobs(ctx, false)
	lg.banner(*addr, *dbPath, jobs)

	go sched.Run(ctx)
	go func() {
		if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			lg.fail("http: %v", err)
			stop()
		}
	}()

	<-ctx.Done()
	lg.note("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	httpServer.Shutdown(shutdown)
}

// ------------------------------------------------------------------ output

type logger struct {
	color bool
	l     *log.Logger
}

func newLogger() *logger {
	return &logger{
		color: term.IsTerminal(int(os.Stderr.Fd())) && os.Getenv("NO_COLOR") == "",
		l:     log.New(os.Stderr, "", 0),
	}
}

func (g *logger) paint(code, s string) string {
	if !g.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (g *logger) line(format string, a ...any) {
	g.l.Printf("%s  %s", g.paint("2", time.Now().Format("15:04:05")), fmt.Sprintf(format, a...))
}

func (g *logger) banner(addr, db string, jobs []store.Job) {
	g.l.Println()
	g.l.Printf("  %s %s", g.paint("1", tools.ServerName), g.paint("2", tools.ServerVersion+" · MCP over Streamable HTTP"))
	g.l.Printf("  %s http://%s/mcp", g.paint("2", "endpoint"), addr)
	g.l.Printf("  %s %s", g.paint("2", "database"), db)
	if len(jobs) == 0 {
		g.l.Printf("  %s none yet — a client creates them with schedule_collection", g.paint("2", "jobs    "))
	}
	for _, j := range jobs {
		g.l.Printf("  %s #%d %s top %d every %s · %d runs so far · next %s", g.paint("2", "job     "),
			j.ID, j.Kind, j.TopN, tools.FormatDuration(j.Interval), j.Runs, due(j.NextRunAt))
	}
	g.l.Println()
}

// due renders a due time; one in the past means "missed while down, runs now".
func due(t time.Time) string {
	if !t.After(time.Now()) {
		return "now (overdue)"
	}
	return t.Local().Format("15:04:05")
}

func (g *logger) run(e scheduler.Event) {
	head := fmt.Sprintf("job %d %s", e.Job.ID, e.Job.Kind)
	if e.Err != nil {
		g.line("%s  %s %s · %s", head, g.paint("31", "✗"), e.Err, ms(e.Duration))
		return
	}
	extra := ""
	if e.Skipped > 0 {
		extra = fmt.Sprintf(" · %d skipped", e.Skipped)
	}
	g.line("%s  %s %d stories · %d new%s · %s", head, g.paint("32", "✓"), e.Stories, e.New, extra, ms(e.Duration))
}

// middleware logs each tool call, so the server terminal shows when a client
// is reading as well as when the scheduler is writing.
func (g *logger) middleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		start := time.Now()
		res, err := next(ctx, method, req)
		if r, ok := req.(*mcp.CallToolRequest); ok {
			mark := g.paint("36", "←")
			if err != nil {
				mark = g.paint("31", "✗")
			} else if cr, ok := res.(*mcp.CallToolResult); ok && cr.IsError {
				mark = g.paint("31", "✗")
			}
			g.line("%s %s %s · %s", mark, r.Params.Name, g.paint("2", compact(r.Params.Arguments)), ms(time.Since(start)))
		}
		return res, err
	}
}

func (g *logger) note(format string, a ...any) { g.line("%s", g.paint("2", fmt.Sprintf(format, a...))) }
func (g *logger) fail(format string, a ...any) {
	g.line("%s %s", g.paint("31", "✗"), fmt.Sprintf(format, a...))
}

func compact(b []byte) string {
	if len(b) == 0 || string(b) == "{}" || string(b) == "null" {
		return "{}"
	}
	if len(b) > 120 {
		return string(b[:119]) + "…"
	}
	return string(b)
}

func ms(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}
