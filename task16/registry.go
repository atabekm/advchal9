package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed servers.json
var embeddedRegistry []byte

// ServerEntry is one launchable MCP server. Only stdio is implemented; the
// Transport field exists so adding streamable HTTP later is a new case rather
// than a new shape.
type ServerEntry struct {
	Transport    string   `json:"transport"`
	Command      string   `json:"command"`
	Args         []string `json:"args"`
	Note         string   `json:"note,omitempty"`
	RequiresArgs bool     `json:"requiresArgs,omitempty"`
}

type Registry struct {
	Default string                 `json:"default"`
	Servers map[string]ServerEntry `json:"servers"`
}

// loadRegistry reads servers.json from path, falling back to the copy compiled
// into the binary so mcpls works from any directory.
func loadRegistry(path string) (*Registry, error) {
	raw := embeddedRegistry
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", path, err)
		}
		raw = b
	}
	var r Registry
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("parsing server registry: %w", err)
	}
	if len(r.Servers) == 0 {
		return nil, fmt.Errorf("server registry contains no servers")
	}
	return &r, nil
}

func (r *Registry) names() []string {
	out := make([]string, 0, len(r.Servers))
	for n := range r.Servers {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// resolve looks up a server by name. extraArgs are appended to the entry's own
// arguments, which is how `mcpls filesystem ~/Projects` reaches the server.
func (r *Registry) resolve(name string, extraArgs []string) (ServerEntry, error) {
	if name == "" {
		name = r.Default
	}
	entry, ok := r.Servers[name]
	if !ok {
		return ServerEntry{}, unknownServerError{name: name, known: r.names()}
	}
	if entry.Transport != "" && entry.Transport != "stdio" {
		return ServerEntry{}, fmt.Errorf("server %q uses transport %q; this build supports stdio only", name, entry.Transport)
	}
	entry.Args = append(append([]string{}, entry.Args...), extraArgs...)
	return entry, nil
}

type unknownServerError struct {
	name  string
	known []string
}

func (e unknownServerError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "unknown server %q", e.name)
	if s := closest(e.name, e.known); s != "" {
		fmt.Fprintf(&b, "\n\nDid you mean %q?", s)
	}
	fmt.Fprintf(&b, "\nRun `mcpls servers` to see all %d.", len(e.known))
	return b.String()
}

// closest returns the nearest known name within a small edit distance, or "".
// The threshold scales with length so short names don't match everything.
func closest(target string, candidates []string) string {
	best, bestDist := "", -1
	limit := len(target)/2 + 1
	for _, c := range candidates {
		d := editDistance(strings.ToLower(target), strings.ToLower(c))
		if d <= limit && (bestDist == -1 || d < bestDist) {
			best, bestDist = c, d
		}
	}
	return best
}

func editDistance(a, b string) int {
	ar, br := []rune(a), []rune(b)
	prev := make([]int, len(br)+1)
	curr := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		curr[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			curr[j] = min(prev[j]+1, min(curr[j-1]+1, prev[j-1]+cost))
		}
		prev, curr = curr, prev
	}
	return prev[len(br)]
}

// --- last-seen tool counts -------------------------------------------------
//
// Purely cosmetic: `mcpls servers` shows "~" for a server it has never reached
// and the last observed tool count once it has. Every operation here is
// best-effort; a cache failure must never affect a listing.

type countCache map[string]int

func cachePath() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "mcpls", "counts.json")
}

func loadCounts() countCache {
	c := countCache{}
	p := cachePath()
	if p == "" {
		return c
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(b, &c)
	return c
}

func saveCount(name string, n int) {
	if name == "" {
		return
	}
	p := cachePath()
	if p == "" {
		return
	}
	c := loadCounts()
	c[name] = n
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	_ = os.WriteFile(p, b, 0o644)
}
