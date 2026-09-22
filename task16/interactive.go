package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// browser is the interactive mode: a scrolling REPL over servers → tools →
// one tool's detail.
//
// It deliberately does not take over the screen. Everything printed stays in
// scrollback, so the handshake trace for each server remains visible above the
// tools it produced — which is the whole argument that the list is real.
type browser struct {
	ctx     context.Context
	reg     *Registry
	r       *renderer
	in      *bufio.Scanner
	timeout time.Duration

	// seen holds inspections from this session. Revisiting a server reuses its
	// result instead of paying for another handshake — but the result is
	// labelled as cached rather than replaying the original timings as though
	// they had just happened.
	seen map[string]*Inspection
}

func newBrowser(ctx context.Context, reg *Registry, r *renderer, in io.Reader, timeout time.Duration) *browser {
	return &browser{
		ctx:     ctx,
		reg:     reg,
		r:       r,
		in:      bufio.NewScanner(in),
		timeout: timeout,
		seen:    map[string]*Inspection{},
	}
}

// read returns the next trimmed line, and false at EOF. EOF is treated as quit
// so a piped script ends cleanly instead of spinning.
func (b *browser) read() (string, bool) {
	if !b.in.Scan() {
		b.r.printf("\n")
		return "", false
	}
	return strings.TrimSpace(b.in.Text()), true
}

func (b *browser) run(startServer string) int {
	b.r.interactiveHeader()

	for {
		name := startServer
		startServer = ""

		if name == "" {
			var ok bool
			name, ok = b.chooseServer()
			if !ok {
				b.r.goodbye()
				return exitOK
			}
		}

		insp, err := b.connect(name)
		if err != nil {
			b.r.failure(err)
			// A server that will not start is not fatal to the session: fall
			// back to the menu so another can be tried.
			continue
		}

		if quit := b.browseTools(name, insp); quit {
			b.r.goodbye()
			return exitOK
		}
	}
}

// chooseServer renders the registry and returns the chosen name. A false
// second result means quit.
func (b *browser) chooseServer() (string, bool) {
	names := b.reg.names()
	counts := loadCounts()
	for name, insp := range b.seen {
		counts[name] = len(insp.Tools)
	}

	for {
		b.r.serverMenu(b.reg, names, counts, b.seen)
		b.r.prompt(fmt.Sprintf("[1-%d] connect · [q]uit", len(names)))

		line, ok := b.read()
		if !ok {
			return "", false
		}
		switch strings.ToLower(line) {
		case "q", "quit", "exit":
			return "", false
		case "":
			continue
		}
		if n, err := strconv.Atoi(line); err == nil && n >= 1 && n <= len(names) {
			return names[n-1], true
		}
		b.r.badInput(fmt.Sprintf("type a number from 1 to %d, or q to quit", len(names)))
	}
}

// connect returns this session's inspection for a server, performing the
// handshake only the first time.
func (b *browser) connect(name string) (*Inspection, error) {
	if insp, ok := b.seen[name]; ok {
		b.r.cachedNotice(name)
		b.r.serverInfo(insp)
		return insp, nil
	}
	return b.reconnect(name)
}

func (b *browser) reconnect(name string) (*Inspection, error) {
	entry, err := b.reg.resolve(name, nil)
	if err != nil {
		return nil, err
	}
	if entry.RequiresArgs {
		// Servers like filesystem need a directory. Asking beats failing.
		b.r.note(fmt.Sprintf("%s needs an argument (a directory it may read).", name))
		b.r.prompt("path · [Enter] for the current directory")
		line, ok := b.read()
		if !ok {
			return nil, fmt.Errorf("cancelled")
		}
		if line == "" {
			line = "."
		}
		entry.Args = append(entry.Args, expandHome(line))
	}

	b.r.printf("\n")
	b.r.connecting(entry)

	// A fresh renderer state per connection: each handshake prints its own
	// step lines.
	b.r.printedStep = false
	insp, err := inspect(b.ctx, entry, b.timeout, b.r.step, nil)
	if err != nil {
		return nil, err
	}
	b.seen[name] = insp
	saveCount(name, len(insp.Tools))
	b.r.serverInfo(insp)
	return insp, nil
}

// browseTools is the level-2 and level-3 loop. It returns true when the user
// asked to quit outright, false when they went back to the server menu.
func (b *browser) browseTools(name string, insp *Inspection) bool {
	n := len(insp.Tools)
	if n == 0 {
		b.r.note("This server advertises no tools. The handshake above still proves the connection.")
		b.r.prompt("[b]ack · [q]uit")
		line, ok := b.read()
		return !ok || strings.EqualFold(line, "q")
	}

	// current is the tool being inspected, or -1 for the list view.
	current := -1
	showSchema := false
	b.r.toolMenu(insp)

	for {
		hint := fmt.Sprintf("[1-%d] inspect · [n]ext · [l]ist · [b]ack · [q]uit", n)
		if current >= 0 {
			hint = fmt.Sprintf("[1-%d] inspect · [n]ext · [s]chema · [l]ist · [b]ack · [q]uit", n)
		}
		b.r.prompt(hint)

		line, ok := b.read()
		if !ok {
			return true
		}

		switch strings.ToLower(line) {
		case "q", "quit", "exit":
			return true

		case "b", "back":
			return false

		case "l", "list":
			current, showSchema = -1, false
			b.r.toolMenu(insp)

		case "s", "schema":
			if current < 0 {
				b.r.badInput("select a tool first, then s shows its raw schema")
				continue
			}
			showSchema = !showSchema
			b.r.toolDetail(insp.Tools[current], current+1, n, showSchema)

		case "n", "next", "":
			// Enter also advances, which is what makes walking the whole list
			// one tool at a time comfortable.
			current++
			if current >= n {
				current = 0
				b.r.note("Back to the first tool.")
			}
			showSchema = false
			b.r.toolDetail(insp.Tools[current], current+1, n, showSchema)

		case "p", "prev":
			current--
			if current < 0 {
				current = n - 1
			}
			showSchema = false
			b.r.toolDetail(insp.Tools[current], current+1, n, showSchema)

		case "r", "reconnect":
			delete(b.seen, name)
			fresh, err := b.reconnect(name)
			if err != nil {
				b.r.failure(err)
				return false
			}
			insp = fresh
			n = len(insp.Tools)
			current, showSchema = -1, false
			b.r.toolMenu(insp)

		default:
			idx, err := strconv.Atoi(line)
			if err != nil || idx < 1 || idx > n {
				b.r.badInput(fmt.Sprintf("type a number from 1 to %d, n for next, b to go back, or q to quit", n))
				continue
			}
			current = idx - 1
			showSchema = false
			b.r.toolDetail(insp.Tools[current], current+1, n, showSchema)
		}
	}
}

// expandHome resolves a leading ~/ so a typed path behaves the way it would in
// a shell. The shell expands it before argv when the path is a command-line
// argument, but at an interactive prompt nothing has.
func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return home + p[1:]
		}
	}
	return p
}
