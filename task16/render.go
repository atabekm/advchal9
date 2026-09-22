package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// style holds the escape sequences for one run. When output is not a terminal
// every field is empty, so the same code emits clean text into a pipe.
type style struct {
	bold, dim, red, green, cyan, yellow, reset string
}

func newStyle(enabled bool) style {
	if !enabled {
		return style{}
	}
	return style{
		bold:   "\x1b[1m",
		dim:    "\x1b[2m",
		red:    "\x1b[31m",
		green:  "\x1b[32m",
		cyan:   "\x1b[36m",
		yellow: "\x1b[33m",
		reset:  "\x1b[0m",
	}
}

// colorEnabled reports whether to emit escapes: only for a real terminal, and
// never when NO_COLOR is set (https://no-color.org).
func colorEnabled(f *os.File, forceOff bool) bool {
	if forceOff {
		return false
	}
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// termWidth is used only to wrap descriptions. Reading it via ioctl would mean
// per-platform files for one cosmetic number, so COLUMNS (exported by most
// shells) with a conservative default is the trade made here.
func termWidth() int {
	if v := os.Getenv("COLUMNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 40 {
			return n
		}
	}
	return 100
}

type renderer struct {
	w     io.Writer
	s     style
	width int

	// printedStep records whether a live step line has already been emitted.
	// A failure that happened mid-exchange has already shown its ✗ there, and
	// printing the stage again would list the same method twice.
	printedStep bool
}

func newRenderer(w io.Writer, s style) *renderer {
	return &renderer{w: w, s: s, width: termWidth()}
}

func (r *renderer) printf(format string, a ...any) {
	fmt.Fprintf(r.w, format, a...)
}

func (r *renderer) header(entry ServerEntry) {
	s := r.s
	r.printf("\n  %s%smcpls%s %s· MCP tool inspector%s\n\n", s.bold, s.cyan, s.reset, s.dim, s.reset)
	r.printf("  %stransport%s   stdio\n", s.dim, s.reset)
	r.printf("  %scommand%s     %s %s\n\n", s.dim, s.reset, entry.Command, strings.Join(entry.Args, " "))
}

// step prints one exchange as it resolves, which is what makes a hang legible:
// the line for the method still in flight simply has not appeared yet.
func (r *renderer) step(st Step) {
	s := r.s
	r.printedStep = true

	mark, color := "✓", s.green
	switch {
	case st.Unsupported:
		// Not a failure — the server simply does not implement an optional
		// method. Dimmed so it reads as information, not damage.
		mark, color = "·", s.dim
	case st.Err != nil:
		mark, color = "✗", s.red
	}

	// Notes sit after the duration so the method and timing columns stay
	// aligned no matter how much explaining a given step needs.
	var notes []string
	if st.First {
		notes = append(notes, "incl. server startup")
	}
	if st.Unsupported {
		notes = append(notes, "not supported")
	}

	name := st.Method
	if st.Unsupported {
		name = s.dim + name + s.reset
	}
	dur := formatDuration(st.Duration)

	r.printf("  %s%s%s  %s%s%8s", color, mark, s.reset, name, padTo(st.Method, 34), dur)
	if len(notes) > 0 {
		r.printf("   %s%s%s", s.dim, strings.Join(notes, " · "), s.reset)
	}
	r.printf("\n")
}

func (r *renderer) failedStep(stage string) {
	s := r.s
	r.printf("  %s✗%s  %s\n", s.red, s.reset, stage)
}

func (r *renderer) serverInfo(i *Inspection) {
	s := r.s
	r.printf("\n")
	name, ver := "(unnamed)", ""
	if i.Init != nil && i.Init.ServerInfo != nil {
		name = i.Init.ServerInfo.Name
		ver = i.Init.ServerInfo.Version
	}
	line := name
	if ver != "" {
		line += "  " + s.dim + "v" + ver + s.reset
	}
	r.printf("  %sserver%s      %s%s%s\n", s.dim, s.reset, s.bold, line, s.reset)
	if i.Init != nil {
		r.printf("  %sprotocol%s    %s\n", s.dim, s.reset, i.Init.ProtocolVersion)
		if caps := capabilityNames(i.Init.Capabilities); len(caps) > 0 {
			r.printf("  %scaps%s        %s\n", s.dim, s.reset, strings.Join(caps, " · "))
		}
	}
}

func (r *renderer) tools(i *Inspection, showSchema, full bool) {
	s := r.s
	r.printf("\n  %sTOOLS · %d%s\n\n", s.bold, len(i.Tools), s.reset)

	if len(i.Tools) == 0 {
		r.printf("  %sThe server advertises no tools.%s\n", s.dim, s.reset)
		r.printf("  %sThis is a valid response — the handshake above still proves the connection.%s\n", s.dim, s.reset)
		return
	}

	nameCol := 0
	for _, t := range i.Tools {
		if n := len([]rune(t.Name)); n > nameCol {
			nameCol = n
		}
	}
	nameCol = clamp(nameCol+2, 14, 26)

	totalParams := 0
	for _, t := range i.Tools {
		params := parseParams(t.InputSchema)
		totalParams += len(params)

		gutter := strings.Repeat(" ", nameCol+2)
		maxLines := descMaxLines
		if full || showSchema {
			maxLines = 0
		}
		desc := r.wrapped(describe(t), r.width-nameCol-4, gutter, maxLines)

		if len([]rune(t.Name)) >= nameCol {
			// A name wider than the column would push its description out of
			// alignment with every other row, so it gets a line of its own.
			r.printf("  %s%s%s\n%s%s\n", s.cyan, t.Name, s.reset, gutter, desc)
		} else {
			r.printf("  %s%s%s%s%s\n", s.cyan, t.Name, s.reset, padTo(t.Name, nameCol), desc)
		}

		if len(params) == 0 {
			r.printf("%s%s—%s\n", gutter, s.dim, s.reset)
		} else {
			for _, line := range r.paramLines(params, r.width-nameCol-4) {
				r.printf("%s%s\n", gutter, line)
			}
		}
		if showSchema {
			r.schema(t.InputSchema, gutter)
		}
		r.printf("\n")
	}

	summary := fmt.Sprintf("%s · %s", plural(len(i.Tools), "tool"), plural(totalParams, "param"))
	if i.Init != nil && i.Init.ServerInfo != nil {
		summary += " · " + i.Init.ServerInfo.Name
		if i.Init.ServerInfo.Version != "" {
			summary += " v" + i.Init.ServerInfo.Version
		}
	}
	summary += " · " + formatDuration(i.Elapsed)
	r.printf("  %s%s%s\n\n", s.dim, summary, s.reset)
}

// describe prefers the tool's own description and falls back through the two
// title fields the spec allows, so a server that omits `description` still
// renders a meaningful row instead of a blank one.
func describe(t *mcp.Tool) string {
	if t.Description != "" {
		return t.Description
	}
	if t.Title != "" {
		return t.Title
	}
	if t.Annotations != nil && t.Annotations.Title != "" {
		return t.Annotations.Title
	}
	return ""
}

// asConnError is errors.As specialised to *connError, kept here so render.go
// does not need to know how the connection layer wraps its failures.
func asConnError(err error, target **connError) bool {
	return errors.As(err, target)
}

// paramLines renders `name*:type` pairs, wrapping onto aligned continuation
// lines rather than overflowing the terminal.
func (r *renderer) paramLines(params []Param, width int) []string {
	s := r.s
	var lines []string
	var cur strings.Builder
	curLen := 0

	for _, p := range params {
		plain := p.Name
		if p.Required {
			plain += "*"
		}
		plain += ":" + p.Type

		colored := p.Name
		if p.Required {
			colored += s.yellow + "*" + s.reset
		}
		colored += s.dim + ":" + p.Type + s.reset

		if curLen > 0 && curLen+2+len([]rune(plain)) > width {
			lines = append(lines, cur.String())
			cur.Reset()
			curLen = 0
		}
		if curLen > 0 {
			cur.WriteString("  ")
			curLen += 2
		}
		cur.WriteString(colored)
		curLen += len([]rune(plain))
	}
	if curLen > 0 {
		lines = append(lines, cur.String())
	}
	return lines
}

func (r *renderer) schema(raw any, gutter string) {
	b, err := json.MarshalIndent(raw, gutter+"  ", "  ")
	if err != nil {
		return
	}
	r.printf("%s  %s%s%s\n", gutter, r.s.dim, string(b), r.s.reset)
}

// descMaxLines caps how much of a tool description is shown. Some real
// servers ship paragraphs of prompt-engineering text in `description`
// (sequential-thinking ships sixteen lines of it), which buries every other
// tool on the screen. Two lines identify a tool; --full prints the rest.
const descMaxLines = 2

// wrapped lays text out in the description column, indenting continuation
// lines to the gutter so the block stays rectangular. When maxLines is
// positive the text is clipped to that many lines and marked with an ellipsis,
// so a truncated description never masquerades as a complete one.
func (r *renderer) wrapped(text string, width int, gutter string, maxLines int) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return r.s.dim + "(no description)" + r.s.reset
	}
	if width < 20 {
		width = 20
	}

	var lines []string
	var cur strings.Builder
	curLen := 0
	truncated := false

	for _, word := range strings.Fields(text) {
		wl := len([]rune(word))
		if curLen > 0 && curLen+1+wl > width {
			lines = append(lines, cur.String())
			if maxLines > 0 && len(lines) == maxLines {
				truncated = true
				break
			}
			cur.Reset()
			curLen = 0
		}
		if curLen > 0 {
			cur.WriteString(" ")
			curLen++
		}
		cur.WriteString(word)
		curLen += wl
	}
	if !truncated && curLen > 0 {
		lines = append(lines, cur.String())
	}
	if truncated && len(lines) > 0 {
		last := lines[len(lines)-1]
		// Trim enough room for the marker rather than overrunning the column.
		for len([]rune(last)) > width-2 {
			idx := strings.LastIndex(last, " ")
			if idx < 0 {
				break
			}
			last = last[:idx]
		}
		lines[len(lines)-1] = last + r.s.dim + " …" + r.s.reset
	}
	return strings.Join(lines, "\n"+gutter)
}

func (r *renderer) servers(reg *Registry, counts countCache) {
	s := r.s
	r.printf("\n  %s%smcpls%s %s· known servers%s\n\n", s.bold, s.cyan, s.reset, s.dim, s.reset)
	r.printf("  %s%-22s %6s  %s%s\n", s.dim, "NAME", "TOOLS", "COMMAND", s.reset)
	r.printf("  %s%s%s\n", s.dim, strings.Repeat("─", 70), s.reset)

	for _, name := range reg.names() {
		e := reg.Servers[name]
		label := name
		if name == reg.Default {
			label += " (default)"
		}
		count := "~"
		if n, ok := counts[name]; ok {
			count = strconv.Itoa(n)
		}
		cmd := e.Command + " " + strings.Join(e.Args, " ")
		if e.RequiresArgs {
			cmd += " " + s.yellow + "<dir>" + s.reset
		}
		r.printf("  %s%-22s%s %6s  %s\n", s.cyan, label, s.reset, count, cmd)
	}
	r.printf("\n  %s~ means never connected. Counts are from the last successful run.%s\n", s.dim, s.reset)
	r.printf("  %sRun `mcpls <name>` to connect, or `mcpls -- <command>` for anything else.%s\n\n", s.dim, s.reset)
}

func (r *renderer) failure(err error) {
	s := r.s
	var ce *connError
	if asConnError(err, &ce) {
		if !r.printedStep {
			r.failedStep(ce.stage)
		}
		r.printf("\n")
		r.indented(ce.msg, s.red)
		if ce.detail != "" {
			r.indented(ce.detail, s.dim)
		}
		r.printf("\n")
		return
	}
	r.printf("\n")
	r.indented(err.Error(), s.red)
	r.printf("\n")
}

// indented prints a possibly multi-line message with every line at the same
// two-space margin as the rest of the output.
func (r *renderer) indented(msg, color string) {
	for _, line := range strings.Split(msg, "\n") {
		if line == "" {
			r.printf("\n")
			continue
		}
		r.printf("  %s%s%s\n", color, line, r.s.reset)
	}
}

// --- helpers ---------------------------------------------------------------

func padTo(word string, col int) string {
	n := col - len([]rune(word))
	if n < 1 {
		n = 1
	}
	return strings.Repeat(" ", n)
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func formatDuration(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%dms", d.Milliseconds())
	}
	return fmt.Sprintf("%.2fs", d.Seconds())
}
