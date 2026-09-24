package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/term"

	"task18/agent"
)

type ui struct {
	md      *glamour.TermRenderer // nil: print answers as raw markdown
	color   bool
	raw     bool
	width   int
	inShake bool         // true while a handshake is in progress
	shake   []agent.Step // its steps, printed once it succeeds
}

func newUI(raw, plain bool) *ui {
	tty := term.IsTerminal(int(os.Stdout.Fd()))
	w := 100
	if c, err := strconv.Atoi(os.Getenv("COLUMNS")); err == nil && c > 40 {
		w = c
	}
	if tty {
		if c, _, err := term.GetSize(int(os.Stdout.Fd())); err == nil && c > 40 {
			w = c
		}
	}
	u := &ui{color: tty && os.Getenv("NO_COLOR") == "", raw: raw, width: w, inShake: true}
	// Piped output gets the raw markdown: glamour's colourless styles keep the
	// ** and * markers anyway, and raw markdown pastes cleanly elsewhere.
	if tty && !plain {
		u.md = newMarkdown(u.color)
	}
	return u
}

// newMarkdown renders answers for a terminal. Word wrap is off: glamour
// hard-wraps inside link URLs (breaking them for clicking and copying), while
// the terminal's own soft wrap keeps each URL one unbroken token.
func newMarkdown(color bool) *glamour.TermRenderer {
	style := "notty" // NO_COLOR: structure without escape sequences
	if color {
		style = markdownStyle()
	}
	r, err := glamour.NewTermRenderer(glamour.WithStandardStyle(style), glamour.WithWordWrap(0))
	if err != nil {
		return nil
	}
	return r
}

// trailingPad matches glamour's right padding: spaces, each possibly wrapped
// in its own SGR sequence when colour is on.
var trailingPad = regexp.MustCompile(`(?:\x1b\[[0-9;]*m| )+$`)

// markdownStyle picks dark or light without asking the terminal. glamour's
// "auto" sends an OSC 11 background query and reads the reply from stdin; a
// terminal that doesn't answer costs a timeout and swallows the first line
// typed at the prompt. GLAMOUR_STYLE overrides; COLORFGBG ("fg;bg", set by
// many terminals) is a hint; dark is the fallback.
func markdownStyle() string {
	if s := os.Getenv("GLAMOUR_STYLE"); s != "" && s != "auto" {
		return s
	}
	if v := os.Getenv("COLORFGBG"); v != "" {
		parts := strings.Split(v, ";")
		if bg, err := strconv.Atoi(parts[len(parts)-1]); err == nil && (bg == 7 || bg == 15) {
			return "light"
		}
	}
	return "dark"
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

func (u *ui) header(model, endpoint string, every, collect time.Duration) {
	fmt.Println()
	fmt.Printf("  %s %s\n", u.bold("hnagent"), u.dim("· "+model+" · MCP over Streamable HTTP"))
	fmt.Printf("  %s %s\n", u.dim("server  "), endpoint)
	fmt.Printf("  %s every %s %s\n\n", u.dim("digest  "), fmtDur(every), u.dim("· collection requested every "+fmtDur(collect)))
}

func (u *ui) mcpStep(s agent.Step) {
	if !u.inShake {
		if u.raw {
			fmt.Printf("    %s\n", u.dim(fmt.Sprintf("· %s %s", s.Method, ms(s.Duration))))
		}
		return
	}
	// Held back until the handshake succeeds: a server that isn't up yet
	// should cost one "retrying" line per attempt, not a trace of failures.
	u.shake = append(u.shake, s)
}

func (u *ui) handshakeDone(s *mcp.ClientSession, tools []*mcp.Tool, first bool) {
	u.inShake = false
	if first {
		fmt.Println() // mid-run reconnects follow a section header's blank line
	}
	for _, st := range u.shake {
		mark, note := u.green("✓"), ""
		if st.Err != nil {
			// A step can fail inside a successful handshake (e.g. a protocol
			// version fallback); show it, but keep it to one line.
			mark, note = u.yellow("·"), "  "+u.dim(firstLine(st.Err.Error()))
		}
		fmt.Printf("  %s %-28s %7s%s\n", mark, st.Method, ms(st.Duration), note)
	}
	u.shake = nil
	if ir := s.InitializeResult(); ir != nil && ir.ServerInfo != nil {
		fmt.Printf("\n  %s %s %s %s\n", u.dim("connected"), u.bold(ir.ServerInfo.Name), ir.ServerInfo.Version,
			u.dim("· protocol "+ir.ProtocolVersion))
	}
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = u.cyan(t.Name)
	}
	fmt.Printf("  %s %s\n", u.dim(fmt.Sprintf("tools · %d  ", len(tools))), strings.Join(names, ", "))
	if first {
		fmt.Println(u.dim("\n  Runs until stopped. Type a question at any time; /now for a digest right away, /help for more."))
	} else {
		fmt.Println()
	}
}

// waiting reports a failed connection attempt; repeated failures print once.
func (u *ui) waiting(endpoint string, err error, retry time.Duration) {
	fmt.Printf("  %s %s %s\n", u.yellow("…"), u.dim("hnserver unreachable at "+endpoint+" — retrying in "+fmtDur(retry)),
		u.dim("("+rootCause(err)+")"))
}

// section starts a turn: a digest, the bootstrap or a typed question.
func (u *ui) section(title, detail string) {
	head := "── " + title
	if detail != "" {
		head += " · " + detail
	}
	head += " "
	fill := max(4, min(u.width, 72)-len([]rune(head))-2)
	fmt.Printf("\n  %s\n\n", u.bold(head)+u.dim(strings.Repeat("─", fill)))
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
	if u.md != nil {
		if out, err := u.md.Render(s); err == nil {
			// glamour supplies its own margin and blank lines around blocks.
			fmt.Println(trimPadding(out, u.color))
			return
		}
	}
	fmt.Println()
	fmt.Println(indent(s, "  "))
}

// trimPadding drops the trailing spaces glamour pads lines and table cells
// with, so copied answers stay clean.
func trimPadding(out string, color bool) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	for i, l := range lines {
		if t := trailingPad.ReplaceAllString(l, ""); t != l {
			lines[i] = t
			if color {
				lines[i] += "\x1b[0m" // the trimmed run may have held the reset
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (u *ui) footer(calls, in, out int, d time.Duration, next time.Time) {
	line := fmt.Sprintf("%d model call%s · %s in / %s out tokens · %s",
		calls, plural(calls), thousands(in), thousands(out), d.Round(100*time.Millisecond))
	if !next.IsZero() {
		line += " · next digest " + next.Format("15:04:05")
	}
	fmt.Printf("\n  %s\n", u.dim(line))
}

func (u *ui) note(s string) { fmt.Printf("  %s\n", u.dim(s)) }

func (u *ui) fail(msg, hint string) {
	fmt.Fprintf(os.Stderr, "\n  %s %s\n", u.red("✗"), msg)
	if hint != "" {
		fmt.Fprintf(os.Stderr, "    %s\n", u.dim(hint))
	}
}

func (u *ui) help() {
	fmt.Println(u.dim(`  <question>  ask anything; the model answers with the server's tools
  /now        write a digest now (the regular schedule continues)
  /tools      list tools with their parameters (as received via tools/list)
  /raw        toggle full JSON for tool arguments, results and MCP requests
  /quit       exit  (Ctrl-C also works)`))
}

// fmtDur drops Go's zero units: 15m rather than 15m0s.
func fmtDur(d time.Duration) string {
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

// rootCause digs the network failure out of the SDK's chain of "calling …
// sending … rejected by transport …": "connection refused", not all of it.
func rootCause(err error) string {
	var op *net.OpError
	if errors.As(err, &op) {
		return firstLine(op.Err.Error())
	}
	msg, _, _ := strings.Cut(err.Error(), "\n")
	if i := strings.LastIndex(msg, ": "); i >= 0 {
		msg = msg[i+2:]
	}
	return firstLine(msg)
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return clip(s, 80)
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
