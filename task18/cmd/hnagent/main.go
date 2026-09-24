// hnagent runs until stopped and writes a periodic digest of the Hacker News
// front page. The data comes from hnserver, a separate long-running MCP
// server that collects in the background; the agent connects over HTTP, and
// DeepSeek decides which tools to call. Nothing in here names a tool.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task18/agent"
)

const systemPrompt = `You are a news desk editor watching the Hacker News front page. An MCP server collects snapshots of the top stories in the background and keeps the history; you reach it only through its tools.
Use the tools for every fact: never invent stories, numbers or links.
Write concise Markdown. Link story titles to their url; when you mention comments, link the discussion page.
If a tool reports no data or an error, say so in one line, including when the next collection is due if the tool says.
Times from the server carry the user's UTC offset; write them as local HH:MM. Current time: %s.`

const bootstrapPrompt = `Make sure the top %d Hacker News stories are being collected every %s. Look at the existing jobs first and schedule a collection only if no active job matches. Answer in one sentence: which job is collecting, and when it runs next.`

const digestPrompt = `Write the regular digest of what changed on the front page since %s. Ask the server for its aggregated summary starting exactly at %s; do not fetch the raw jobs.
Start with one sentence of numbers (snapshots taken, new entries, drop-outs). Then short sections, only for lists that are not empty: New on the front page, Climbing, Dropped off, Hottest discussions. At most 5 items per section, one line each with score and comments. Under 250 words, no closing remarks.`

func main() {
	os.Exit(run())
}

func run() int {
	endpoint := flag.String("server", "http://localhost:8765/mcp", "hnserver MCP endpoint")
	every := flag.Duration("every", time.Hour, "how often to write a digest")
	collect := flag.Duration("collect", 15*time.Minute, "collection interval to ask for at startup")
	top := flag.Int("top", 30, "how many top stories the collection should cover")
	model := flag.String("model", "deepseek-flash", "DeepSeek model: deepseek-flash or deepseek-v4-pro")
	rounds := flag.Int("rounds", agent.DefaultMaxRounds, "maximum tool rounds per turn")
	raw := flag.Bool("raw", false, "start with full tool arguments and results shown")
	plain := flag.Bool("plain", false, "print answers as raw markdown instead of rendering them")
	flag.Parse()

	u := newUI(*raw, *plain)
	key, err := apiKey()
	if err != nil {
		u.fail(err.Error(), "export DEEPSEEK_API_KEY=sk-…  (or put it in a .env file here)")
		return 2
	}
	if *every < 10*time.Second {
		u.fail("-every must be at least 10s", "")
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	u.header(*model, *endpoint, *every, *collect)
	r := &runner{ui: u, llm: agent.NewDeepSeek(key, *model), endpoint: *endpoint, rounds: *rounds}
	defer r.close()

	if !r.connectWithRetry(ctx) {
		fmt.Println()
		return 0
	}
	r.turn(ctx, "setup", "", fmt.Sprintf(bootstrapPrompt, *top, fmtDur(*collect)), time.Time{})

	lines := readLines(ctx)
	ticker := time.NewTicker(*every)
	defer ticker.Stop()
	lastDigest := time.Now()
	nextDigest := lastDigest.Add(*every)
	u.note("first digest at " + nextDigest.Format("15:04:05"))

	// A failed digest is retried soon rather than at the next slot: with
	// hourly digests, a ten-second server restart shouldn't cost an hour.
	// The window still starts at the last digest that succeeded.
	var retry <-chan time.Time
	retryAfter := min(30*time.Second, *every)
	digest := func() {
		now := time.Now()
		since := lastDigest.Truncate(time.Second)
		retry = nil
		if r.turn(ctx, "digest "+now.Format("15:04"), "since "+since.Format("15:04:05"),
			fmt.Sprintf(digestPrompt, since.Format(time.RFC3339), since.Format(time.RFC3339)), nextDigest) {
			lastDigest = now
			return
		}
		if ctx.Err() == nil {
			retry = time.After(retryAfter)
			u.note("digest not written — retrying at " + time.Now().Add(retryAfter).Format("15:04:05"))
		}
	}

	for {
		select {
		case <-ctx.Done():
			fmt.Println()
			return 0
		case <-ticker.C:
			nextDigest = time.Now().Add(*every)
			digest()
		case <-retry:
			ticker.Reset(*every)
			nextDigest = time.Now().Add(*every)
			digest()
		case line, ok := <-lines:
			if !ok {
				// stdin closed (e.g. running under nohup): keep going on the timer.
				lines = nil
				continue
			}
			switch {
			case line == "":
			case line == "/quit" || line == "/exit":
				return 0
			case line == "/help":
				u.help()
			case line == "/now":
				// The schedule restarts from here; otherwise the next regular
				// digest could cover only the few seconds since this one.
				ticker.Reset(*every)
				nextDigest = time.Now().Add(*every)
				digest()
			case line == "/tools":
				if r.ensure(ctx) {
					u.tools(r.tools)
				}
			case line == "/raw":
				u.raw = !u.raw
				u.note("raw mode " + onOff(u.raw))
			case strings.HasPrefix(line, "/"):
				u.note("unknown command " + line + " — /help")
			default:
				r.turn(ctx, "question", "", line, nextDigest)
			}
		}
	}
}

// readLines delivers stdin lines until EOF. The terminal echoes what is
// typed; piped input is echoed here so transcripts read right.
func readLines(ctx context.Context) <-chan string {
	st, _ := os.Stdin.Stat()
	echo := st != nil && st.Mode()&os.ModeCharDevice == 0
	out := make(chan string)
	go func() {
		defer close(out)
		in := bufio.NewScanner(os.Stdin)
		in.Buffer(make([]byte, 64*1024), 1<<20)
		for in.Scan() {
			line := strings.TrimSpace(in.Text())
			if echo && line != "" {
				fmt.Println("› " + line)
			}
			select {
			case out <- line:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// runner owns the MCP session and replaces it when the server goes away.
type runner struct {
	ui       *ui
	llm      *agent.DeepSeek
	endpoint string
	rounds   int

	session   *mcp.ClientSession
	tools     []*mcp.Tool
	connected bool // a session has been established at least once
}

func (r *runner) connect(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r.ui.inShake, r.ui.shake = true, nil
	transport := &mcp.StreamableClientTransport{Endpoint: r.endpoint, DisableStandaloneSSE: true, MaxRetries: -1}
	s, tools, err := agent.Connect(ctx, "hnagent", transport, agent.Observer{MCP: r.ui.mcpStep})
	r.ui.inShake = false
	if err != nil {
		return err
	}
	r.session, r.tools = s, tools
	r.ui.handshakeDone(s, tools, !r.connected)
	r.connected = true
	return nil
}

// connectWithRetry waits for the server, backing off up to 30s. It returns
// false only when ctx is cancelled.
func (r *runner) connectWithRetry(ctx context.Context) bool {
	wait := 2 * time.Second
	for {
		err := r.connect(ctx)
		if err == nil {
			return true
		}
		if ctx.Err() != nil {
			return false
		}
		r.ui.waiting(r.endpoint, err, wait)
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
		wait = min(2*wait, 30*time.Second)
	}
}

// ensure checks the session with a ping and reconnects once if it is gone,
// e.g. after hnserver restarted and forgot the session.
func (r *runner) ensure(ctx context.Context) bool {
	if r.session != nil {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := r.session.Ping(pctx, nil)
		cancel()
		if err == nil {
			return true
		}
		r.ui.note("session lost (" + rootCause(err) + ") — reconnecting")
		r.close()
	}
	if err := r.connect(ctx); err != nil {
		r.ui.fail("hnserver unreachable at "+r.endpoint+" ("+rootCause(err)+")", "")
		return false
	}
	return true
}

func (r *runner) close() {
	if r.session != nil {
		r.session.Close()
		r.session = nil
	}
}

// turn runs one prompt in a fresh conversation. A process that runs for
// days can't carry one growing history; what links a digest to the last is
// the time window, and the data itself lives on the server.
func (r *runner) turn(ctx context.Context, title, detail, prompt string, next time.Time) bool {
	r.ui.section(title, detail)
	if !r.ensure(ctx) {
		return false
	}
	a := agent.New(r.llm, r.session, r.tools, agent.Observer{
		MCP:        r.ui.mcpStep,
		ToolCall:   r.ui.toolCall,
		ToolResult: r.ui.toolResult,
		RoundCap:   r.ui.roundCap,
	})
	a.System = fmt.Sprintf(systemPrompt, time.Now().Format(time.RFC3339))
	a.Reset()
	a.MaxRounds = r.rounds

	tctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	start := time.Now()
	answer, err := a.Ask(tctx, prompt)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return false
		}
		r.ui.fail(err.Error(), "")
		return false
	}
	r.ui.answer(answer)
	r.ui.footer(a.Calls, a.Usage.PromptTokens, a.Usage.CompletionTokens, time.Since(start), next)
	return true
}

// apiKey reads DEEPSEEK_API_KEY, falling back to a .env in the working dir.
func apiKey() (string, error) {
	if k := strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")); k != "" {
		return k, nil
	}
	b, err := os.ReadFile(".env")
	if err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(l), "=")
			if ok && strings.TrimSpace(strings.TrimPrefix(k, "export ")) == "DEEPSEEK_API_KEY" {
				if v = strings.Trim(strings.TrimSpace(v), `"'`); v != "" {
					return v, nil
				}
			}
		}
	}
	return "", agent.ErrNoKey
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
