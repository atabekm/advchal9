// pipeagent connects to several MCP servers at once, merges their tools into
// one list and lets DeepSeek chain them. The servers know nothing of each
// other; the model carries each output to the next call, and the agent checks
// every handoff. Nothing in here names a tool.
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

	"task19/agent"
	"task19/llm"
)

const defaultServers = "http://localhost:8771/mcp,http://localhost:8772/mcp,http://localhost:8773/mcp"

const systemPrompt = `You complete requests with the tools available to you. They come from separate servers and do not talk to each other: when one tool's output is the next tool's input, you carry it.
When you pass a tool's output to another tool, pass it verbatim: the complete text, character for character, with nothing added, removed, reformatted or summarised by you. Leave processing to the tools rather than rewriting their output yourself.
Use the tools for every fact; never invent results. If a call fails, read the error, fix the arguments and try again, or say plainly what could not be done.
When you are done, answer in two or three sentences: what was done and where the result is, quoting paths exactly as a tool returned them.
Current time: %s.`

func main() {
	os.Exit(run())
}

func run() int {
	servers := flag.String("servers", defaultServers, "comma-separated MCP endpoints")
	question := flag.String("q", "", "run this one request and exit")
	model := flag.String("model", "deepseek-flash", "DeepSeek model: deepseek-flash or deepseek-v4-pro")
	rounds := flag.Int("rounds", agent.DefaultMaxRounds, "maximum tool rounds per request")
	raw := flag.Bool("raw", false, "start with full tool arguments and results shown")
	plain := flag.Bool("plain", false, "print answers as raw markdown instead of rendering them")
	flag.Parse()

	u := newUI(*raw, *plain)
	key, err := llm.APIKey()
	if err != nil {
		u.fail(err.Error(), "export DEEPSEEK_API_KEY=sk-…  (or put it in a .env file here)")
		return 2
	}
	var urls []string
	for _, s := range strings.Split(*servers, ",") {
		if s = strings.TrimSpace(s); s != "" {
			urls = append(urls, s)
		}
	}
	if len(urls) == 0 {
		u.fail("-servers is empty", "")
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	u.header(*model, len(urls))
	r := &runner{ui: u, llm: llm.NewDeepSeek(key, *model), urls: urls, servers: make([]*agent.Server, len(urls)), rounds: *rounds}
	defer r.close()
	router, err := r.ensure(ctx)
	if err != nil {
		u.fail(err.Error(), "")
		return 1
	}
	u.connected(router)

	if *question != "" {
		fmt.Println("\n  " + u.bold("› ") + *question)
		if !r.turn(ctx, *question) {
			return 1
		}
		return 0
	}

	fmt.Println(u.dim("\n  Ask for something the tools can do together; /help for commands."))
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 1<<20)
	for {
		fmt.Print("\n" + u.bold("› "))
		if !in.Scan() || ctx.Err() != nil {
			fmt.Println()
			return 0
		}
		line := strings.TrimSpace(in.Text())
		switch {
		case line == "":
		case line == "/quit" || line == "/exit":
			return 0
		case line == "/help":
			u.help()
		case line == "/tools":
			if router, err := r.ensure(ctx); err == nil {
				u.tools(router)
			} else {
				u.fail(err.Error(), "")
			}
		case line == "/raw":
			u.raw = !u.raw
			u.note("raw mode " + onOff(u.raw))
		case strings.HasPrefix(line, "/"):
			u.note("unknown command " + line + " — /help")
		default:
			r.turn(ctx, line)
		}
	}
}

// runner owns one session per server and replaces any that went away.
type runner struct {
	ui      *ui
	llm     *llm.DeepSeek
	urls    []string
	servers []*agent.Server // same order as urls; nil while unreachable
	down    []bool          // reported as unreachable last time, to avoid repeating it
	rounds  int
}

// ensure pings every session, reconnects the lost ones, tries the missing
// ones once, and returns a router over whatever is up. A server that stays
// down costs its tools, not the run: the model then says what it can't do.
func (r *runner) ensure(ctx context.Context) (*agent.Router, error) {
	if r.down == nil {
		r.down = make([]bool, len(r.urls))
	}
	for i, url := range r.urls {
		if s := r.servers[i]; s != nil {
			pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			err := s.Session.Ping(pctx, nil)
			cancel()
			if err == nil {
				continue
			}
			r.ui.note(fmt.Sprintf("%s: session lost (%s) — reconnecting", s.Name(), rootCause(err)))
			s.Session.Close()
			r.servers[i] = nil
		}
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		transport := &mcp.StreamableClientTransport{Endpoint: url, DisableStandaloneSSE: true, MaxRetries: -1}
		s, err := agent.Connect(cctx, "pipeagent", url, transport, r.ui.mcpStep)
		cancel()
		if err != nil {
			if !r.down[i] {
				r.ui.unreachable(url, err)
			}
			r.down[i] = true
			continue
		}
		if r.down[i] {
			r.ui.note(s.Name() + " is back at " + url)
		}
		r.down[i] = false
		r.servers[i] = s
	}
	router, err := agent.NewRouter(r.servers)
	if err != nil {
		return nil, err
	}
	if len(router.Tools()) == 0 {
		return nil, errors.New("no server reachable, so no tools")
	}
	return router, nil
}

func (r *runner) close() {
	for _, s := range r.servers {
		if s != nil {
			s.Session.Close()
		}
	}
}

// turn runs one request in a fresh conversation and prints the chain report.
func (r *runner) turn(ctx context.Context, prompt string) bool {
	router, err := r.ensure(ctx)
	if err != nil {
		r.ui.fail(err.Error(), "")
		return false
	}
	fmt.Println()
	a := agent.New(r.llm, router, fmt.Sprintf(systemPrompt, time.Now().Format(time.RFC3339)), agent.Observer{
		ToolCall:   r.ui.toolCall,
		ToolResult: r.ui.toolResult,
		RoundCap:   r.ui.roundCap,
	})
	a.MaxRounds = r.rounds

	tctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	start := time.Now()
	answer, err := a.Ask(tctx, prompt)
	r.ui.chain(a.Chain)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			r.ui.fail(err.Error(), "")
		}
		return false
	}
	r.ui.answer(answer)
	r.ui.footer(a.Calls, a.Usage.PromptTokens, a.Usage.CompletionTokens, time.Since(start))
	return true
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
