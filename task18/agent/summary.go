package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Summarize describes a tool result in one line without knowing the tool:
// scalar fields as key=value, arrays as key[n]. For search_books that reads
// "total_found=11 returned=5 books[5]" — derived from the data, not from a
// per-tool formatter.
func Summarize(r *mcp.CallToolResult, width int) string {
	if r.IsError {
		return oneLine(ResultText(r), width)
	}
	obj, ok := asObject(r.StructuredContent)
	if !ok {
		return oneLine(ResultText(r), width)
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	// Scalars first (they are the headline facts), then collections; stable within each.
	sort.SliceStable(keys, func(i, j int) bool {
		si, sj := isScalar(obj[keys[i]]), isScalar(obj[keys[j]])
		if si != sj {
			return si
		}
		return keys[i] < keys[j]
	})
	var parts []string
	for _, k := range keys {
		switch v := obj[k].(type) {
		case []any:
			parts = append(parts, fmt.Sprintf("%s[%d]", k, len(v)))
		case map[string]any:
			parts = append(parts, k+"{…}")
		case string:
			if k == "description" || k == "url" || len(v) > 48 {
				continue // long prose and links are noise in a one-line summary
			}
			parts = append(parts, fmt.Sprintf("%s=%q", k, v))
		case nil:
		default:
			parts = append(parts, fmt.Sprintf("%s=%v", k, v))
		}
	}
	return oneLine(strings.Join(parts, " "), width)
}

func asObject(v any) (map[string]any, bool) {
	if v == nil {
		return nil, false
	}
	if m, ok := v.(map[string]any); ok {
		return m, true
	}
	// structuredContent may arrive as json.RawMessage or a typed value.
	b, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil, false
	}
	return m, true
}

func isScalar(v any) bool {
	switch v.(type) {
	case []any, map[string]any:
		return false
	}
	return true
}

func oneLine(s string, width int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if width > 1 && len(r) > width {
		return string(r[:width-1]) + "…"
	}
	return s
}
