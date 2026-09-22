package main

import (
	"encoding/json"
	"sort"
	"strings"
)

// Param is one entry of a tool's inputSchema, flattened for display.
type Param struct {
	Name        string
	Type        string
	Required    bool
	Description string
}

// parseParams turns a tool's InputSchema into an ordered parameter list.
//
// The SDK types InputSchema as `any` because it is whatever the server sent:
// normally a map[string]any, but servers are free to omit `properties`, omit
// `required`, put non-strings in `required`, or give `type` as a list such as
// ["string","null"]. Each of those is real output from some server, so none of
// them may panic — an unreadable schema yields no parameters, never a crash.
//
// Ordering is required-first (in the order the server listed them), then the
// rest alphabetically. Go map iteration is random, so without this the same
// server would render differently on every run.
func parseParams(schema any) []Param {
	obj := asObject(schema)
	if obj == nil {
		return nil
	}

	props := asObject(obj["properties"])
	if len(props) == 0 {
		return nil
	}

	required := map[string]bool{}
	var requiredOrder []string
	if list, ok := obj["required"].([]any); ok {
		for _, v := range list {
			if name, ok := v.(string); ok && !required[name] {
				required[name] = true
				requiredOrder = append(requiredOrder, name)
			}
		}
	}

	var optional []string
	for name := range props {
		if !required[name] {
			optional = append(optional, name)
		}
	}
	sort.Strings(optional)

	out := make([]Param, 0, len(props))
	for _, name := range requiredOrder {
		// A name in `required` with no matching property is malformed but
		// harmless; skip it rather than inventing a parameter.
		if _, ok := props[name]; !ok {
			continue
		}
		out = append(out, param(name, props[name], true))
	}
	for _, name := range optional {
		out = append(out, param(name, props[name], false))
	}
	return out
}

func param(name string, raw any, required bool) Param {
	p := Param{Name: name, Type: "any", Required: required}
	spec := asObject(raw)
	if spec == nil {
		return p
	}
	if t := typeOf(spec); t != "" {
		p.Type = t
	}
	if d, ok := spec["description"].(string); ok {
		p.Description = d
	}
	return p
}

// typeOf reads a JSON Schema `type`, which may be a string, a list (union
// types, commonly ["string","null"]), or absent — in which case `enum` still
// tells us something worth showing.
func typeOf(spec map[string]any) string {
	switch t := spec["type"].(type) {
	case string:
		return t
	case []any:
		var parts []string
		for _, v := range t {
			if s, ok := v.(string); ok && s != "null" {
				parts = append(parts, s)
			}
		}
		switch len(parts) {
		case 0:
		case 1, 2:
			return strings.Join(parts, "|")
		default:
			return parts[0] + "|…"
		}
	}
	if _, ok := spec["enum"]; ok {
		return "enum"
	}
	return ""
}

// asObject coerces a decoded-JSON value to map[string]any. Values that arrive
// as raw bytes or as a typed struct are round-tripped through JSON rather than
// type-switched, so this keeps working if the SDK changes the concrete type.
func asObject(v any) map[string]any {
	switch t := v.(type) {
	case nil:
		return nil
	case map[string]any:
		return t
	case json.RawMessage:
		return unmarshalObject(t)
	case []byte:
		return unmarshalObject(t)
	case string:
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return unmarshalObject(b)
}

func unmarshalObject(b []byte) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil
	}
	return m
}
