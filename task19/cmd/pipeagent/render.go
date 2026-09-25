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
	"golang.org/x/term"

	"task19/agent"
	"task19/mcpserve"
)

type ui struct {
	md    *glamour.TermRenderer // nil: print answers as raw markdown
	color bool
	raw   bool
	width int
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
	u := &ui{color: tty && os.Getenv("NO_COLOR") == "", raw: raw, width: w}
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

func (u *ui) header(model string, servers int) {
	fmt.Println()
	fmt.Printf("  %s %s\n\n", u.bold("pipeagent"), u.dim(fmt.Sprintf("· %s · %d MCP servers over Streamable HTTP", model, servers)))
}

func (u *ui) mcpStep(s agent.Step) {
	if u.raw {
		fmt.Printf("    %s\n", u.dim(fmt.Sprintf("· %s %s", s.Method, ms(s.Duration))))
	}
}

func (u *ui) unreachable(url string, err error) {
	fmt.Printf("  %s %s %s\n", u.red("✗"), url, u.dim("unreachable ("+rootCause(err)+") — its tools are missing"))
}

func (u *ui) connected(r *agent.Router) {
	for _, s := range r.Servers() {
		names := make([]string, len(s.Tools))
		for i, t := range s.Tools {
			names[i] = u.cyan(t.Name)
		}
		proto := ""
		if ir := s.Session.InitializeResult(); ir != nil {
			proto = " · protocol " + ir.ProtocolVersion
		}
		fmt.Printf("  %s %-13s %s %s\n", u.green("✓"), u.bold(s.Name()), strings.Join(names, ", "), u.dim("· "+s.URL+proto))
	}
	fmt.Printf("  %s\n", u.dim(fmt.Sprintf("%d tools from %d servers, offered to the model as one list", len(r.Tools()), len(r.Servers()))))
}

func (u *ui) toolCall(step int, name, server string, args json.RawMessage, handoffs []agent.Handoff) {
	a := mcpserve.ShortArgs(args, 40)
	if u.raw {
		a = compact(args)
	} else {
		a = clip(a, u.width-len(name)-len(server)-12)
	}
	at := ""
	if server != "" {
		at = u.dim(" @" + server)
	}
	fmt.Printf("  %s %s%s %s\n", u.yellow(fmt.Sprintf("⚙ %d", step)), u.cyan(name), at, a)
	for _, h := range handoffs {
		mark, text := u.green("⇐"), h.String()
		if h.Verdict == agent.Whitespace {
			mark, text = u.cyan("⇐"), h.String()
		}
		if h.Verdict == agent.Partial || h.Verdict == agent.Joined || h.Verdict == agent.None {
			mark, text = u.yellow("⇐"), u.yellow(text)
		}
		fmt.Printf("      %s %s\n", mark, text)
		for i, m := range h.Missing {
			if i == 3 {
				fmt.Printf("        %s\n", u.yellow(fmt.Sprintf("… and %d more", len(h.Missing)-3)))
				break
			}
			fmt.Printf("        %s %s\n", u.yellow("dropped:"), u.dim(clip(m, u.width-20)))
		}
	}
}

func (u *ui) toolResult(st agent.ChainStep, o agent.ToolOutcome) {
	switch {
	case o.Err != nil:
		fmt.Printf("      %s %s\n", u.red("✗"), u.red(o.Err.Error()))
	case o.Result.IsError:
		fmt.Printf("      %s %s %s\n", u.red("✗"), u.dim(ms(o.Duration)+" · tool error ·"),
			agent.Summarize(o.Result, u.width-30))
	default:
		fmt.Printf("      %s %s %s\n", u.green("✓"), u.dim(ms(o.Duration)+" ·"),
			agent.Summarize(o.Result, u.width-20))
	}
	if sc := st.Store; sc != nil {
		if sc.Match {
			fmt.Printf("      %s %s\n", u.green("≡"), u.dim(fmt.Sprintf("stored sha256 %s… = %s sent", sc.Reported[:8], sc.Arg)))
		} else {
			fmt.Printf("      %s %s\n", u.red("≠"), u.red(fmt.Sprintf("stored sha256 %s… matches no argument sent", clip(sc.Reported, 9))))
		}
	}
	switch {
	case u.raw:
		fmt.Println(indent(o.ForModel, "        "))
	case st.OK:
		u.output(st.Output)
	}
}

// output prints what a tool returned, in full, behind a bar: the data the
// model now holds and may carry into the next call. Long lines are wrapped
// so the bar stays on every line.
func (u *ui) output(text string) {
	bar := u.dim("│ ")
	width := max(40, u.width-10)
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		for _, w := range wrap(l, width) {
			fmt.Println("      " + bar + w)
		}
	}
}

// wrap breaks a line at spaces to fit width, keeping its leading indentation
// on the continuation lines. A single word longer than width (a URL) stays whole.
func wrap(line string, width int) []string {
	if len([]rune(line)) <= width {
		return []string{line}
	}
	lead := line[:len(line)-len(strings.TrimLeft(line, " "))]
	var out []string
	cur := lead
	for _, word := range strings.Fields(line) {
		switch {
		case cur == lead:
			cur += word
		case len([]rune(cur))+1+len([]rune(word)) > width:
			out = append(out, cur)
			cur = lead + word
		default:
			cur += " " + word
		}
	}
	return append(out, cur)
}

// chain prints the turn's calls as one pipeline, with how each piece of data
// got from one tool to the next.
func (u *ui) chain(c *agent.Chain) {
	path, counts, stores := c.Report()
	if path == "" {
		return
	}
	total := 0
	var parts []string
	for _, v := range []agent.Verdict{agent.Exact, agent.Whitespace, agent.Partial, agent.Joined, agent.None} {
		if n := counts[v]; n > 0 {
			total += n
			s := fmt.Sprintf("%d %s", n, v)
			if v == agent.Partial || v == agent.Joined || v == agent.None {
				s = u.yellow(s)
			}
			parts = append(parts, s)
		}
	}
	line := fmt.Sprintf("%s · %d handoff%s", path, total, plural(total))
	if total > 0 {
		line += ": " + strings.Join(parts, ", ")
	}
	for _, s := range stores {
		if s.Match {
			line += " · " + u.green("stored = sent")
		} else {
			line += " · " + u.red("stored ≠ sent")
		}
	}
	fmt.Printf("\n  %s %s\n", u.bold("chain"), line)
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
	fmt.Println(u.dim(`  <request>   anything the tools can do, e.g. "find HN stories on X, summarize them, save to x.md"
  /tools      list the tools of every connected server with their parameters
  /raw        toggle full tool arguments and results
  /quit       exit  (Ctrl-C also works)`))
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
func (u *ui) tools(r *agent.Router) {
	for _, srv := range r.Servers() {
		fmt.Printf("\n  %s %s\n", u.bold(srv.Name()), u.dim(srv.URL))
		for _, t := range srv.Tools {
			fmt.Printf("\n    %s  %s\n", u.cyan(t.Name), t.Description)
			for _, p := range params(t.InputSchema) {
				fmt.Printf("      %s\n", p)
			}
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
