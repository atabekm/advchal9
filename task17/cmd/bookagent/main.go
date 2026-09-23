// bookagent is a REPL agent: DeepSeek chooses tools, an MCP server runs them.
// It spawns the server (olserver by default) over stdio and learns its tools
// from tools/list; nothing in here names a tool.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task17/agent"
)

func main() {
	os.Exit(run())
}

func run() int {
	model := flag.String("model", "deepseek-flash", "DeepSeek model: deepseek-flash or deepseek-v4-pro")
	server := flag.String("server", "", "MCP server command (default: olserver next to this binary or in the working dir)")
	rounds := flag.Int("rounds", agent.DefaultMaxRounds, "maximum tool rounds per question")
	raw := flag.Bool("raw", false, "start with full tool arguments and results shown")
	plain := flag.Bool("plain", false, "print answers as raw markdown instead of rendering them")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: bookagent [flags] [-- server-command args...]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	ui := newUI(*raw, *plain)

	key, err := apiKey()
	if err != nil {
		ui.fail(err.Error(), "export DEEPSEEK_API_KEY=sk-…  (or put it in a .env file here)")
		return 2
	}

	argv := flag.Args()
	if len(argv) == 0 {
		path, err := findServer(*server)
		if err != nil {
			ui.fail(err.Error(), "build it with:  go build -o . ./cmd/...")
			return 2
		}
		argv = []string{path}
	}

	ui.header(*model, argv)

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stderr = os.Stderr
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	session, tools, err := agent.Connect(ctx, &mcp.CommandTransport{Command: cmd}, agent.Observer{MCP: ui.mcpStep})
	cancel()
	if err != nil {
		ui.fail(err.Error(), "")
		return 1
	}
	defer session.Close()
	ui.handshakeDone(session, tools)

	a := agent.New(agent.NewDeepSeek(key, *model), session, tools, agent.Observer{
		MCP:        ui.mcpStep,
		ToolCall:   ui.toolCall,
		ToolResult: ui.toolResult,
		RoundCap:   ui.roundCap,
	})
	a.MaxRounds = *rounds

	repl(a, ui)
	return 0
}

func repl(a *agent.Agent, ui *ui) {
	// Ctrl-C cancels the question in flight; at the prompt it exits.
	var (
		mu       sync.Mutex
		inFlight context.CancelFunc
	)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		for range sig {
			mu.Lock()
			c := inFlight
			mu.Unlock()
			if c == nil {
				fmt.Println()
				os.Exit(0)
			}
			c()
		}
	}()

	// Piped input isn't echoed by a terminal; print it so transcripts read right.
	st, _ := os.Stdin.Stat()
	echo := st != nil && st.Mode()&os.ModeCharDevice == 0

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 1<<20)
	for {
		ui.prompt()
		if !in.Scan() {
			fmt.Println()
			return
		}
		line := strings.TrimSpace(in.Text())
		if echo {
			fmt.Println(line)
		}
		switch {
		case line == "":
			continue
		case line == "/quit" || line == "/exit":
			return
		case line == "/help":
			ui.help()
			continue
		case line == "/tools":
			ui.tools(a.Tools)
			continue
		case line == "/raw":
			ui.raw = !ui.raw
			ui.note(fmt.Sprintf("raw mode %s", onOff(ui.raw)))
			continue
		case line == "/reset":
			a.Reset()
			ui.note("conversation cleared")
			continue
		case line == "/history":
			b, _ := json.MarshalIndent(a.History(), "  ", "  ")
			fmt.Println("  " + string(b))
			continue
		case strings.HasPrefix(line, "/"):
			ui.note("unknown command " + line + " — /help")
			continue
		}

		ctx, cancel := context.WithCancel(context.Background())
		mu.Lock()
		inFlight = cancel
		mu.Unlock()

		start := time.Now()
		calls, usage := a.Calls, a.Usage
		fmt.Println()
		answer, err := a.Ask(ctx, line)

		mu.Lock()
		inFlight = nil
		mu.Unlock()
		cancel()

		if err != nil {
			if errors.Is(err, context.Canceled) {
				ui.note("cancelled — question discarded")
			} else {
				ui.fail(err.Error(), "the question was discarded; history is unchanged")
			}
			continue
		}
		ui.answer(answer)
		ui.footer(a.Calls-calls, a.Usage.PromptTokens-usage.PromptTokens,
			a.Usage.CompletionTokens-usage.CompletionTokens, time.Since(start))
	}
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

// findServer resolves the olserver binary: explicit flag, then next to this
// executable, then the working directory.
func findServer(flagValue string) (string, error) {
	if flagValue != "" {
		if p, err := exec.LookPath(flagValue); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("server %q not found", flagValue)
	}
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "olserver"))
	}
	candidates = append(candidates, "./olserver")
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return filepath.Abs(c)
		}
	}
	return "", errors.New("olserver binary not found")
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
