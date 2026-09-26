// Package grade checks a turn's tool calls against a scenario: which tools
// had to be called, in what partial order, with which data flowing between
// them, and which must not be called at all. It sees only the client's
// record of the calls; the servers know nothing of it.
package grade

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Scenario is one request and what a correct run of it looks like.
type Scenario struct {
	Name   string `json:"name"`
	Prompt string `json:"prompt"`
	// Setup calls run through the router before the request, outside the
	// graded turn: files a scenario reads, for instance.
	Setup    []Call   `json:"setup,omitempty"`
	Steps    []Step   `json:"steps"`
	Forbid   []string `json:"forbid,omitempty"`
	MaxCalls *int     `json:"max_calls,omitempty"`

	File string `json:"-"`
}

type Call struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args"`
}

// Step is one call the request needs.
type Step struct {
	ID string `json:"id"`
	// Tool is the namespaced name; "a|b" accepts either.
	Tool string `json:"tool"`
	// After: steps whose calls must come earlier. From implies After.
	After []string `json:"after,omitempty"`
	// From: steps whose output must reach this call's arguments, directly
	// or through other calls.
	From []string `json:"from,omitempty"`
	// Args: arguments that must have exactly these values.
	Args map[string]any `json:"args,omitempty"`
}

func (s Step) Tools() []string { return strings.Split(s.Tool, "|") }

func (s Step) accepts(tool string) bool {
	for _, t := range s.Tools() {
		if t == tool {
			return true
		}
	}
	return false
}

// Before is After and From together, without duplicates.
func (s Step) Before() []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range append(append([]string{}, s.After...), s.From...) {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// Validate checks the scenario is well formed: unique step ids, references
// to earlier steps only (so the listed order is a valid order), and, when
// known is given, only tools some server offers.
func (sc *Scenario) Validate(known func(string) bool) error {
	if strings.TrimSpace(sc.Prompt) == "" {
		return fmt.Errorf("%s: prompt is empty", sc.Name)
	}
	seen := map[string]bool{}
	tool := func(where, t string) error {
		if known != nil && !known(t) {
			return fmt.Errorf("%s: %s names %q, which no connected server offers", sc.Name, where, t)
		}
		return nil
	}
	for _, c := range sc.Setup {
		if err := tool("setup", c.Tool); err != nil {
			return err
		}
	}
	for _, st := range sc.Steps {
		if st.ID == "" || seen[st.ID] {
			return fmt.Errorf("%s: step id %q is empty or repeated", sc.Name, st.ID)
		}
		for _, t := range st.Tools() {
			if err := tool("step "+st.ID, t); err != nil {
				return err
			}
		}
		for _, id := range st.Before() {
			if !seen[id] {
				return fmt.Errorf("%s: step %s refers to %q, which is not an earlier step", sc.Name, st.ID, id)
			}
		}
		seen[st.ID] = true
	}
	for _, t := range sc.Forbid {
		if err := tool("forbid", t); err != nil {
			return err
		}
	}
	return nil
}

// Load reads one scenario file, or every *.json in a directory, sorted by
// file name.
func Load(path string) ([]*Scenario, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	files := []string{path}
	if fi.IsDir() {
		if files, err = filepath.Glob(filepath.Join(path, "*.json")); err != nil {
			return nil, err
		}
		sort.Strings(files)
	}
	var out []*Scenario
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var sc Scenario
		dec := json.NewDecoder(strings.NewReader(string(b)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&sc); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		sc.File = f
		if sc.Name == "" {
			sc.Name = strings.TrimSuffix(filepath.Base(f), ".json")
		}
		if err := sc.Validate(nil); err != nil {
			return nil, err
		}
		out = append(out, &sc)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no scenarios", path)
	}
	return out, nil
}
