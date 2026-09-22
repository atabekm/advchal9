package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

// decode mirrors what the SDK hands us: whatever the server's JSON
// unmarshalled into, with no struct types involved.
func decode(t *testing.T, raw string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("fixture is not valid JSON: %v", err)
	}
	return v
}

func names(params []Param) []string {
	out := make([]string, len(params))
	for i, p := range params {
		out[i] = p.Name
	}
	return out
}

func TestParseParamsOrdersRequiredFirst(t *testing.T) {
	// Go map iteration is randomised, so this is the test that catches a
	// renderer printing the same server differently on consecutive runs.
	schema := decode(t, `{
		"type": "object",
		"properties": {
			"zebra":   {"type": "string"},
			"alpha":   {"type": "number"},
			"message": {"type": "string"},
			"count":   {"type": "integer"}
		},
		"required": ["message", "count"]
	}`)

	want := []string{"message", "count", "alpha", "zebra"}
	for i := 0; i < 20; i++ {
		got := names(parseParams(schema))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("run %d: got %v, want %v", i, got, want)
		}
	}
}

func TestParseParamsMarksRequired(t *testing.T) {
	params := parseParams(decode(t, `{
		"properties": {"a": {"type": "string"}, "b": {"type": "string"}},
		"required": ["a"]
	}`))
	if len(params) != 2 {
		t.Fatalf("want 2 params, got %d", len(params))
	}
	if !params[0].Required || params[0].Name != "a" {
		t.Errorf("a should be required and first, got %+v", params[0])
	}
	if params[1].Required {
		t.Errorf("b should be optional, got %+v", params[1])
	}
}

func TestParseParamsMalformedSchemas(t *testing.T) {
	// Every one of these is something a real server can emit. None may panic,
	// and none may invent a parameter that was not in `properties`.
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"no properties", `{"type": "object"}`, nil},
		{"empty properties", `{"type": "object", "properties": {}}`, nil},
		{"null schema", `null`, nil},
		{"schema is a string", `"not an object"`, nil},
		{"properties is an array", `{"properties": []}`, nil},
		{"required absent", `{"properties": {"a": {"type": "string"}}}`, []string{"a"}},
		{"required is not a list", `{"properties": {"a": {}}, "required": "a"}`, []string{"a"}},
		{"required holds non-strings", `{"properties": {"a": {}}, "required": [1, true, "a"]}`, []string{"a"}},
		{"required names a missing property", `{"properties": {"a": {}}, "required": ["ghost", "a"]}`, []string{"a"}},
		{"required lists a duplicate", `{"properties": {"a": {}}, "required": ["a", "a"]}`, []string{"a"}},
		{"property value is not an object", `{"properties": {"a": "string"}}`, []string{"a"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := names(parseParams(decode(t, c.raw)))
			if len(got) == 0 && len(c.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestParamTypes(t *testing.T) {
	params := parseParams(decode(t, `{
		"properties": {
			"a": {"type": "string"},
			"b": {"type": ["boolean", "null"]},
			"c": {"type": ["string", "number"]},
			"d": {"type": ["string", "number", "boolean"]},
			"e": {"enum": ["x", "y"]},
			"f": {},
			"g": {"type": 42}
		},
		"required": ["a", "b", "c", "d", "e", "f", "g"]
	}`))

	want := map[string]string{
		"a": "string",
		"b": "boolean",       // null is dropped: optionality is shown by the * marker
		"c": "string|number", // a two-type union still fits
		"d": "string|…",      // three or more is elided
		"e": "enum",          // no type, but enum says something
		"f": "any",           // nothing at all
		"g": "any",           // type present but not a string or list
	}
	if len(params) != len(want) {
		t.Fatalf("want %d params, got %d", len(want), len(params))
	}
	for _, p := range params {
		if want[p.Name] != p.Type {
			t.Errorf("%s: got type %q, want %q", p.Name, p.Type, want[p.Name])
		}
	}
}

func TestParseParamsAcceptsRawJSON(t *testing.T) {
	// The SDK types InputSchema as `any`; a server-side tool can hold a
	// json.RawMessage there instead of a decoded map.
	raw := json.RawMessage(`{"properties": {"path": {"type": "string"}}, "required": ["path"]}`)
	params := parseParams(raw)
	if len(params) != 1 || params[0].Name != "path" || !params[0].Required {
		t.Fatalf("raw JSON schema not handled: %+v", params)
	}
}

func TestParamDescription(t *testing.T) {
	params := parseParams(decode(t, `{
		"properties": {"path": {"type": "string", "description": "Absolute path"}},
		"required": ["path"]
	}`))
	if len(params) != 1 || params[0].Description != "Absolute path" {
		t.Fatalf("description not captured: %+v", params)
	}
}

func TestClosestSuggestsNearMisses(t *testing.T) {
	known := []string{"everything", "filesystem", "memory", "sequential-thinking"}
	cases := map[string]string{
		"filesytem":  "filesystem",
		"filesystm":  "filesystem",
		"memry":      "memory",
		"everythin":  "everything",
		"postgres":   "", // genuinely not one of ours — suggesting anything would mislead
		"xxxxxxxxxx": "",
	}
	for input, want := range cases {
		if got := closest(input, known); got != want {
			t.Errorf("closest(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSplitAtDoubleDash(t *testing.T) {
	cases := []struct {
		argv   []string
		before []string
		after  []string
		hasDD  bool
	}{
		{[]string{"everything"}, []string{"everything"}, nil, false},
		{[]string{"--json", "memory"}, []string{"--json", "memory"}, nil, false},
		{[]string{"--", "npx", "-y", "pkg"}, []string{}, []string{"npx", "-y", "pkg"}, true},
		{[]string{"--json", "--", "npx", "--server-flag"}, []string{"--json"}, []string{"npx", "--server-flag"}, true},
		{[]string{"--"}, []string{}, []string{}, true},
	}
	for _, c := range cases {
		before, after := splitAtDoubleDash(c.argv)
		if !reflect.DeepEqual(before, c.before) {
			t.Errorf("%v: before = %v, want %v", c.argv, before, c.before)
		}
		if (after != nil) != c.hasDD {
			t.Errorf("%v: presence of `--` detected as %v, want %v", c.argv, after != nil, c.hasDD)
		}
		if c.hasDD && !reflect.DeepEqual(after, c.after) {
			t.Errorf("%v: after = %v, want %v", c.argv, after, c.after)
		}
	}
}

func TestRegistryResolveAppendsExtraArgs(t *testing.T) {
	reg, err := loadRegistry("")
	if err != nil {
		t.Fatalf("embedded registry failed to load: %v", err)
	}
	entry, err := reg.resolve("filesystem", []string{"/tmp"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := entry.Args[len(entry.Args)-1]; got != "/tmp" {
		t.Errorf("extra arg not appended, last arg is %q", got)
	}

	// Resolving must not mutate the registry entry, or a second resolve would
	// accumulate the first call's arguments.
	again, err := reg.resolve("filesystem", nil)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	for _, a := range again.Args {
		if a == "/tmp" {
			t.Fatal("registry entry was mutated by a previous resolve")
		}
	}
}

func TestRegistryDefaultAndUnknown(t *testing.T) {
	reg, err := loadRegistry("")
	if err != nil {
		t.Fatalf("embedded registry failed to load: %v", err)
	}
	if _, err := reg.resolve("", nil); err != nil {
		t.Errorf("empty name should resolve to the default: %v", err)
	}
	if _, err := reg.resolve("nope", nil); err == nil {
		t.Error("unknown server should be an error")
	}
}

func TestIsMethodNotFound(t *testing.T) {
	if !isMethodNotFound(errString(`calling "server/discover": Method not found`)) {
		t.Error("JSON-RPC -32601 text should be recognised")
	}
	if isMethodNotFound(nil) {
		t.Error("nil error is not a missing method")
	}
	if isMethodNotFound(errString("connection reset by peer")) {
		t.Error("a transport failure must not be downgraded to 'unsupported'")
	}
}

type errString string

func (e errString) Error() string { return string(e) }
