package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeInspection builds an Inspection without touching a server, so the
// navigation loop can be tested without spawning anything.
func fakeInspection(t *testing.T, names ...string) *Inspection {
	t.Helper()
	insp := &Inspection{Command: "fake"}
	for _, n := range names {
		var schema any
		if err := json.Unmarshal([]byte(`{"properties":{"a":{"type":"string"}},"required":["a"]}`), &schema); err != nil {
			t.Fatal(err)
		}
		insp.Tools = append(insp.Tools, newTool(n, "describes "+n, schema))
	}
	return insp
}

// drive runs browseTools against scripted keystrokes and returns whether the
// session quit outright, plus everything printed.
func drive(t *testing.T, insp *Inspection, input string) (quit bool, out string) {
	t.Helper()
	var buf bytes.Buffer
	r := newRenderer(&buf, newStyle(false))
	b := &browser{
		ctx:  context.Background(),
		reg:  &Registry{Servers: map[string]ServerEntry{}},
		r:    r,
		in:   bufio.NewScanner(strings.NewReader(input)),
		seen: map[string]*Inspection{},
	}
	return b.browseTools("fake", insp), buf.String()
}

func TestBrowseQuitAndBack(t *testing.T) {
	insp := fakeInspection(t, "alpha", "beta", "gamma")

	cases := []struct {
		name     string
		input    string
		wantQuit bool
	}{
		{"q quits the session", "q\n", true},
		{"quit spelled out", "quit\n", true},
		{"b returns to the server menu", "b\n", false},
		{"back spelled out", "back\n", false},
		{"EOF is treated as quit", "", true},
		{"quit after inspecting", "2\nq\n", true},
		{"back after inspecting", "2\nb\n", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			quit, _ := drive(t, insp, c.input)
			if quit != c.wantQuit {
				t.Errorf("quit = %v, want %v", quit, c.wantQuit)
			}
		})
	}
}

func TestBrowseSelectByNumber(t *testing.T) {
	insp := fakeInspection(t, "alpha", "beta", "gamma")
	_, out := drive(t, insp, "2\nq\n")

	if !strings.Contains(out, "beta  (2 of 3)") {
		t.Errorf("selecting 2 should open beta as 2 of 3, got:\n%s", out)
	}
	if strings.Contains(out, "alpha  (1 of 3)") {
		t.Error("selecting 2 should not also open alpha")
	}
}

func TestBrowseNextWalksAndWraps(t *testing.T) {
	insp := fakeInspection(t, "alpha", "beta", "gamma")
	// Four advances over three tools: the fourth must wrap to the first.
	_, out := drive(t, insp, "n\nn\nn\nn\nq\n")

	for _, want := range []string{"alpha  (1 of 3)", "beta  (2 of 3)", "gamma  (3 of 3)"} {
		if !strings.Contains(out, want) {
			t.Errorf("walking should have reached %q, got:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "Back to the first tool.") {
		t.Error("advancing past the last tool should say it wrapped")
	}
	if strings.Count(out, "alpha  (1 of 3)") != 2 {
		t.Errorf("alpha should appear twice after wrapping, got %d", strings.Count(out, "alpha  (1 of 3)"))
	}
}

func TestBrowseEnterAdvances(t *testing.T) {
	// A bare Enter is the same as n, which is what makes walking the list one
	// tool at a time comfortable.
	insp := fakeInspection(t, "alpha", "beta")
	_, out := drive(t, insp, "\n\nq\n")
	if !strings.Contains(out, "alpha  (1 of 2)") || !strings.Contains(out, "beta  (2 of 2)") {
		t.Errorf("Enter should advance like n, got:\n%s", out)
	}
}

func TestBrowsePrevWrapsBackwards(t *testing.T) {
	insp := fakeInspection(t, "alpha", "beta", "gamma")
	_, out := drive(t, insp, "p\nq\n")
	if !strings.Contains(out, "gamma  (3 of 3)") {
		t.Errorf("p from the list should wrap to the last tool, got:\n%s", out)
	}
}

func TestBrowseSchemaNeedsASelection(t *testing.T) {
	insp := fakeInspection(t, "alpha")

	_, out := drive(t, insp, "s\nq\n")
	if !strings.Contains(out, "select a tool first") {
		t.Errorf("s in the list view should explain itself, got:\n%s", out)
	}
	if strings.Contains(out, "SCHEMA") {
		t.Error("s with nothing selected must not print a schema")
	}

	_, out = drive(t, insp, "1\ns\nq\n")
	if !strings.Contains(out, "SCHEMA") {
		t.Errorf("s after selecting should print the schema, got:\n%s", out)
	}

	// Toggling off again must hide it: the second detail render has it, the
	// third does not.
	_, out = drive(t, insp, "1\ns\ns\nq\n")
	if strings.Count(out, "SCHEMA") != 1 {
		t.Errorf("s should toggle the schema, saw it %d times", strings.Count(out, "SCHEMA"))
	}
}

func TestBrowseRejectsOutOfRange(t *testing.T) {
	insp := fakeInspection(t, "alpha", "beta")
	for _, input := range []string{"0\nq\n", "3\nq\n", "-1\nq\n", "zzz\nq\n"} {
		quit, out := drive(t, insp, input)
		if !quit {
			t.Errorf("%q should still reach quit", input)
		}
		if !strings.Contains(out, "type a number from 1 to 2") {
			t.Errorf("%q should be rejected with guidance, got:\n%s", input, out)
		}
	}
}

func TestBrowseListReturnsToTheMenu(t *testing.T) {
	insp := fakeInspection(t, "alpha", "beta")
	_, out := drive(t, insp, "1\nl\nq\n")
	// The tool menu heading appears once on entry and again after l.
	if strings.Count(out, "TOOLS · 2") != 2 {
		t.Errorf("l should reprint the tool list, saw the heading %d times", strings.Count(out, "TOOLS · 2"))
	}
}

func TestBrowseEmptyToolList(t *testing.T) {
	insp := &Inspection{Command: "fake"}
	quit, out := drive(t, insp, "q\n")
	if !quit {
		t.Error("q should quit even with no tools")
	}
	if !strings.Contains(out, "advertises no tools") {
		t.Errorf("an empty list needs explaining, got:\n%s", out)
	}
	if !strings.Contains(out, "handshake above still proves the connection") {
		t.Error("an empty list should not read as a failed connection")
	}
}

func TestExpandHome(t *testing.T) {
	if got := expandHome("/absolute/path"); got != "/absolute/path" {
		t.Errorf("absolute paths must be untouched, got %q", got)
	}
	if got := expandHome("relative"); got != "relative" {
		t.Errorf("relative paths must be untouched, got %q", got)
	}
	if got := expandHome("~/Projects"); strings.HasPrefix(got, "~") {
		t.Errorf("~/ should have been expanded, got %q", got)
	}
	if got := expandHome("~notauser/x"); got != "~notauser/x" {
		t.Errorf("only a leading ~/ expands, got %q", got)
	}
}

// newTool builds an mcp.Tool for tests without importing the SDK into every
// test file's signature set.
func newTool(name, desc string, schema any) *mcp.Tool {
	return &mcp.Tool{Name: name, Description: desc, InputSchema: schema}
}
