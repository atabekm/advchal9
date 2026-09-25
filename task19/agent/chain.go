package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// MinHandoffChars is the shortest string argument checked as a handoff.
// Below it an argument is a query or a file name, not data from a tool.
const MinHandoffChars = 200

// Verdict says how an argument relates to an earlier tool output.
type Verdict string

const (
	Exact      Verdict = "exact"      // byte-identical
	Whitespace Verdict = "whitespace" // identical once whitespace is collapsed
	Partial    Verdict = "partial"    // some of the output's lines, possibly with others
	None       Verdict = "none"       // nothing in common with any earlier output
)

// Handoff describes one argument that carries data into a call.
type Handoff struct {
	Arg      string
	From     int // step number the data came from; 0 for None
	FromTool string
	Verdict  Verdict
	Chars    int
	SHA256   string
	Kept     int    // Partial: lines of the source output present in the argument
	Of       int    // Partial: non-empty lines in the source output
	Added    int    // Partial: argument lines not in the source output
	Diff     string // Whitespace: where the argument first departs from the output
}

// StoreCheck compares a hash a tool reports for what it stored with the
// hash of the argument the client sent.
type StoreCheck struct {
	Arg      string // the argument whose hash matches; "" when none does
	Reported string
	Match    bool
}

// ChainStep is one tool call in the turn.
type ChainStep struct {
	N        int
	Tool     string
	OK       bool
	Output   string // the text the model received
	Handoffs []Handoff
	Store    *StoreCheck
}

// Chain watches the tool calls of one turn. The tools know nothing of each
// other; only the client sees every output and every argument, so the
// checking happens here.
type Chain struct {
	Steps []ChainStep
}

// Inspect checks the call about to be made against the outputs so far.
func (c *Chain) Inspect(args map[string]any) []Handoff {
	var out []Handoff
	for _, k := range sortedKeys(args) {
		s, ok := args[k].(string)
		if !ok || len([]rune(s)) < MinHandoffChars {
			continue
		}
		h := c.classify(s)
		h.Arg, h.Chars, h.SHA256 = k, len([]rune(s)), Hash(s)
		out = append(out, h)
	}
	return out
}

func (c *Chain) classify(arg string) Handoff {
	// The latest output wins a tie: a pipeline hands on what it just got.
	for i := len(c.Steps) - 1; i >= 0; i-- {
		if st := c.Steps[i]; st.OK && st.Output == arg {
			return Handoff{From: st.N, FromTool: st.Tool, Verdict: Exact}
		}
	}
	for i := len(c.Steps) - 1; i >= 0; i-- {
		if st := c.Steps[i]; st.OK && collapse(st.Output) == collapse(arg) {
			return Handoff{From: st.N, FromTool: st.Tool, Verdict: Whitespace, Diff: FirstDiff(st.Output, arg)}
		}
	}
	best := Handoff{Verdict: None}
	bestFrac := 0.0
	argLines := lineSet(arg)
	for i := len(c.Steps) - 1; i >= 0; i-- {
		st := c.Steps[i]
		if !st.OK {
			continue
		}
		src := lineSet(st.Output)
		if len(src) == 0 {
			continue
		}
		kept := 0
		for l := range src {
			if argLines[l] {
				kept++
			}
		}
		if f := float64(kept) / float64(len(src)); kept > 0 && f > bestFrac {
			added := 0
			for l := range argLines {
				if !src[l] {
					added++
				}
			}
			bestFrac = f
			best = Handoff{From: st.N, FromTool: st.Tool, Verdict: Partial, Kept: kept, Of: len(src), Added: added}
		}
	}
	return best
}

// Record adds a finished call. If the result reports a sha256 of what it
// stored, it is compared with the hashes of the string arguments sent.
func (c *Chain) Record(tool string, args map[string]any, handoffs []Handoff, ok bool, output string, structured any) ChainStep {
	st := ChainStep{N: len(c.Steps) + 1, Tool: tool, OK: ok, Output: output, Handoffs: handoffs}
	if ok {
		if reported := reportedHash(structured); reported != "" {
			sc := &StoreCheck{Reported: reported}
			for _, k := range sortedKeys(args) {
				if s, isStr := args[k].(string); isStr && Hash(s) == reported {
					sc.Arg, sc.Match = k, true
					break
				}
			}
			st.Store = sc
		}
	}
	c.Steps = append(c.Steps, st)
	return st
}

// Report is the turn in one line: the successful calls in order and the
// handoff verdicts.
func (c *Chain) Report() (path string, counts map[Verdict]int, stores []StoreCheck) {
	counts = map[Verdict]int{}
	var names []string
	for _, st := range c.Steps {
		if !st.OK {
			continue
		}
		names = append(names, st.Tool)
		for _, h := range st.Handoffs {
			counts[h.Verdict]++
		}
		if st.Store != nil {
			stores = append(stores, *st.Store)
		}
	}
	return strings.Join(names, " → "), counts, stores
}

func Hash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (h Handoff) String() string {
	switch h.Verdict {
	case None:
		return fmt.Sprintf("%s · matches no earlier output · %s chars", h.Arg, thousands(h.Chars))
	case Partial:
		return fmt.Sprintf("%s · from step %d %s · partial: %d of %d lines kept, %d added · %s chars",
			h.Arg, h.From, h.FromTool, h.Kept, h.Of, h.Added, thousands(h.Chars))
	case Whitespace:
		return fmt.Sprintf("%s · from step %d %s · whitespace differs (%s) · %s chars",
			h.Arg, h.From, h.FromTool, h.Diff, thousands(h.Chars))
	}
	return fmt.Sprintf("%s · from step %d %s · exact · %s chars · sha256 %s",
		h.Arg, h.From, h.FromTool, thousands(h.Chars), h.SHA256[:8])
}

// FirstDiff says where b first departs from a, e.g.
// `line 3: output "a  b", argument "a b"` or `trailing "\n" dropped`.
func FirstDiff(a, b string) string {
	ra, rb := []rune(a), []rune(b)
	i := 0
	for i < len(ra) && i < len(rb) && ra[i] == rb[i] {
		i++
	}
	switch {
	case i == len(ra) && i == len(rb):
		return "identical"
	case i == len(rb):
		return fmt.Sprintf("trailing %s dropped", quote(ra[i:], 12))
	case i == len(ra):
		return fmt.Sprintf("trailing %s added", quote(rb[i:], 12))
	}
	line := 1 + strings.Count(string(ra[:i]), "\n")
	from := max(0, i-6)
	return fmt.Sprintf("line %d: output %s, argument %s", line,
		quote(ra[from:min(len(ra), i+6)], 16), quote(rb[from:min(len(rb), i+6)], 16))
}

func quote(r []rune, n int) string {
	if len(r) > n {
		return strconv.Quote(string(r[:n])) + "…"
	}
	return strconv.Quote(string(r))
}

func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func reportedHash(structured any) string {
	b, err := json.Marshal(structured)
	if err != nil {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return ""
	}
	s, _ := m["sha256"].(string)
	return strings.ToLower(s)
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

func lineSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, l := range strings.Split(s, "\n") {
		if l = collapse(l); l != "" {
			m[l] = true
		}
	}
	return m
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
