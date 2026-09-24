package main

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// The link is long enough that a wrapping renderer would split its URL.
const sample = "Three novels, each linked to its Open Library page so that the line runs well past eighty columns:\n\n- **The Dispossessed** (1974) — [OL59863W](https://openlibrary.org/works/OL59863W)\n- *The Lathe of Heaven* (1971)\n\n| title | year |\n|---|---|\n| Tehanu | 1990 |\n"

func TestMarkdownRendersWithoutPadding(t *testing.T) {
	for _, color := range []bool{false, true} {
		t.Setenv("GLAMOUR_STYLE", "")
		md := newMarkdown(color)
		if md == nil {
			t.Fatal("renderer not built")
		}
		out, err := md.Render(sample)
		if err != nil {
			t.Fatal(err)
		}
		got := trimPadding(out, color)
		for _, want := range []string{"The Dispossessed", "Tehanu", "https://openlibrary.org/works/OL59863W"} {
			if !strings.Contains(got, want) {
				t.Errorf("color=%v: output lacks %q:\n%s", color, want, got)
			}
		}
		if color && (strings.Contains(got, "**") || strings.Contains(got, "|---")) {
			t.Errorf("markdown syntax left unrendered:\n%s", got)
		}
		for _, l := range strings.Split(got, "\n") {
			plain := strings.TrimSuffix(l, "\x1b[0m")
			if strings.HasSuffix(plain, " ") {
				t.Errorf("color=%v: trailing padding on %q", color, l)
			}
		}
		if !color && strings.Contains(got, "\x1b[") {
			t.Error("notty output contains escape sequences")
		}
	}
}

func TestTrimPaddingColored(t *testing.T) {
	in := "  \x1b[1mTitle\x1b[0m\x1b[38;5;252m \x1b[0m\x1b[38;5;252m \x1b[0m\n  plain   \n"
	got := trimPadding(in, true)
	want := "  \x1b[1mTitle\x1b[0m\n  plain\x1b[0m"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestMarkdownStyle(t *testing.T) {
	cases := []struct{ glamour, fgbg, want string }{
		{"", "", "dark"},
		{"", "0;15", "light"},
		{"", "15;0", "dark"},
		{"dracula", "0;15", "dracula"},
		{"auto", "", "dark"}, // auto would query the terminal; never passed through
	}
	for _, c := range cases {
		t.Setenv("GLAMOUR_STYLE", c.glamour)
		t.Setenv("COLORFGBG", c.fgbg)
		if got := markdownStyle(); got != c.want {
			t.Errorf("GLAMOUR_STYLE=%q COLORFGBG=%q → %q, want %q", c.glamour, c.fgbg, got, c.want)
		}
	}
}

func TestFmtDur(t *testing.T) {
	for d, want := range map[time.Duration]string{
		20 * time.Second: "20s", 90 * time.Second: "1m30s", 15 * time.Minute: "15m", time.Hour: "1h", 90 * time.Minute: "1h30m",
	} {
		if got := fmtDur(d); got != want {
			t.Errorf("%v → %q, want %q", d, got, want)
		}
	}
}

func TestRootCause(t *testing.T) {
	op := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: connection refused")}
	wrapped := fmt.Errorf("mcp handshake: %w", fmt.Errorf("calling \"initialize\": %w", op))
	if got := rootCause(wrapped); got != "connect: connection refused" {
		t.Errorf("wrapped: %q", got)
	}
	flat := errors.New(`sending "initialize": rejected by transport: Post "http://x/mcp": dial tcp [::1]:8799: connect: connection refused`)
	if got := rootCause(flat); got != "connection refused" {
		t.Errorf("flattened: %q", got)
	}
}
