package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task17/agent"
)

type ui struct {
	color   bool
	raw     bool
	width   int
	inShake bool // true until tools/list has been printed
	first   bool // next MCP step is the first round trip
}

func newUI(raw bool) *ui {
	st, _ := os.Stdout.Stat()
	tty := st != nil && st.Mode()&os.ModeCharDevice != 0
	w := 100
	if c, err := strconv.Atoi(os.Getenv("COLUMNS")); err == nil && c > 40 {
		w = c
	}
	return &ui{color: tty && os.Getenv("NO_COLOR") == "", raw: raw, width: w, inShake: true, first: true}
}

func (u *ui) paint(code, s string) string {
	if !u.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (u *ui) dim(s string) string    { return u.paint("2", s) }
func (u *ui) bold(s string) string   { return u.paint("1", s) }
func (u *ui) green(s string) string  { return u.paint("32", s) }
func (u *ui) red(s string) string    { return u.paint("31", s) }
func (u *ui) yellow(s string) string { return u.paint("33", s) }
func (u *ui) cyan(s string) string   { return u.paint("36", s) }

func (u *ui) header(model string, argv []string) {
	fmt.Println()
	fmt.Printf("  %s %s\n\n", u.bold("bookagent"), u.dim("· "+model+" · MCP over stdio"))
	fmt.Printf("  %s %s\n\n", u.dim("server  "), strings.Join(argv, " "))
}

func (u *ui) mcpStep(s agent.Step) {
	if !u.inShake {
		if u.raw {
			fmt.Printf("    %s\n", u.dim(fmt.Sprintf("· %s %s", s.Method, ms(s.Duration))))
		}
		return
	}
	mark, note := u.green("✓"), ""
	if s.Err != nil {
		mark, note = u.red("✗"), "  "+s.Err.Error()
	}
	if u.first {
		note += u.dim("   incl. server startup")
		u.first = false
	}
	fmt.Printf("  %s %-28s %7s%s\n", mark, s.Method, ms(s.Duration), note)
}

func (u *ui) handshakeDone(s *mcp.ClientSession, tools []*mcp.Tool) {
	u.inShake = false
	if ir := s.InitializeResult(); ir != nil && ir.ServerInfo != nil {
		fmt.Printf("\n  %s %s %s %s\n", u.dim("connected"), u.bold(ir.ServerInfo.Name), ir.ServerInfo.Version,
			u.dim("· protocol "+ir.ProtocolVersion))
	}
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = u.cyan(t.Name)
	}
	fmt.Printf("  %s %s\n\n", u.dim(fmt.Sprintf("tools · %d  ", len(tools))), strings.Join(names, ", "))
	fmt.Println(u.dim("  Ask anything; the model decides when to call a tool. /tools shows parameters, /raw the full JSON, /help for more."))
}

func (u *ui) prompt() {
	fmt.Printf("\n%s ", u.bold("›"))
}

func (u *ui) toolCall(name string, args json.RawMessage) {
	a := compact(args)
	if !u.raw {
		a = clip(a, u.width-len(name)-8)
	}
	fmt.Printf("  %s %s %s\n", u.yellow("⚙"), u.cyan(name), a)
}

func (u *ui) toolResult(name string, o agent.ToolOutcome) {
	switch {
	case o.Err != nil:
		fmt.Printf("    %s %s\n", u.red("✗"), u.red(o.Err.Error()))
	case o.Result.IsError:
		fmt.Printf("    %s %s %s\n", u.red("✗"), u.dim(ms(o.Duration)+" · tool error ·"),
			agent.Summarize(o.Result, u.width-30))
	default:
		fmt.Printf("    %s %s %s\n", u.green("✓"), u.dim(ms(o.Duration)+" ·"),
			agent.Summarize(o.Result, u.width-20))
	}
	if u.raw {
		fmt.Println(indent(pretty(o.ForModel), "      "))
	}
}

func (u *ui) roundCap(max int) {
	fmt.Printf("    %s\n", u.yellow(fmt.Sprintf("tool budget reached (%d rounds) — asking for an answer without tools", max)))
}

func (u *ui) answer(s string) {
	fmt.Println()
	fmt.Println(indent(s, "  "))
}

func (u *ui) footer(calls, in, out int, d time.Duration) {
	fmt.Printf("\n  %s\n", u.dim(fmt.Sprintf("%d model call%s · %s in / %s out tokens · %s",
		calls, plural(calls), thousands(in), thousands(out), d.Round(100*time.Millisecond))))
}

func (u *ui) note(s string) { fmt.Printf("  %s\n", u.dim(s)) }

func (u *ui) fail(msg, hint string) {
	fmt.Fprintf(os.Stderr, "\n  %s %s\n", u.red("✗"), msg)
	if hint != "" {
		fmt.Fprintf(os.Stderr, "    %s\n", u.dim(hint))
	}
}

func (u *ui) help() {
	fmt.Println(u.dim(`  /tools    list tools with their parameters (as received via tools/list)
  /raw      toggle full JSON for tool arguments, results and MCP requests
  /history  dump the conversation as sent to the model
  /reset    clear the conversation
  /quit     exit  (Ctrl-C cancels a question in flight)`))
}

// tools renders parameters from each tool's inputSchema as the server sent it.
func (u *ui) tools(ts []*mcp.Tool) {
	for _, t := range ts {
		fmt.Printf("\n  %s  %s\n", u.cyan(t.Name), t.Description)
		for _, p := range params(t.InputSchema) {
			fmt.Printf("    %s\n", p)
		}
	}
}

func params(schema any) []string {
	b, _ := json.Marshal(schema)
	var s struct {
		Properties map[string]struct {
			Type        any      `json:"type"`
			Description string   `json:"description"`
			Minimum     *float64 `json:"minimum"`
			Maximum     *float64 `json:"maximum"`
			Default     any      `json:"default"`
			Pattern     string   `json:"pattern"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if json.Unmarshal(b, &s) != nil || len(s.Properties) == 0 {
		return []string{"—"}
	}
	req := map[string]bool{}
	for _, r := range s.Required {
		req[r] = true
	}
	names := make([]string, 0, len(s.Properties))
	for n := range s.Properties {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		if req[names[i]] != req[names[j]] {
			return req[names[i]]
		}
		return names[i] < names[j]
	})
	var out []string
	for _, n := range names {
		p := s.Properties[n]
		sig := fmt.Sprintf("%s:%v", n, p.Type)
		if req[n] {
			sig = n + "*:" + fmt.Sprint(p.Type)
		}
		var extra []string
		if p.Minimum != nil && p.Maximum != nil {
			extra = append(extra, fmt.Sprintf("%g–%g", *p.Minimum, *p.Maximum))
		}
		if p.Default != nil {
			extra = append(extra, fmt.Sprintf("default %v", p.Default))
		}
		if p.Pattern != "" {
			extra = append(extra, "/"+p.Pattern+"/")
		}
		line := fmt.Sprintf("%-22s %s", sig, p.Description)
		if len(extra) > 0 {
			line += " (" + strings.Join(extra, ", ") + ")"
		}
		out = append(out, line)
	}
	return out
}

func compact(b json.RawMessage) string {
	var buf bytes.Buffer
	if json.Compact(&buf, b) != nil {
		return string(b)
	}
	return buf.String()
}

func pretty(s string) string {
	var buf bytes.Buffer
	if json.Indent(&buf, []byte(s), "", "  ") != nil {
		return s
	}
	return buf.String()
}

func clip(s string, n int) string {
	r := []rune(s)
	if n > 1 && len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func indent(s, pad string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = pad + l
		}
	}
	return strings.Join(lines, "\n")
}

func ms(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1fs", d.Seconds())
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
