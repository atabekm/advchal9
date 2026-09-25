package main

import (
	"reflect"
	"testing"
)

func TestWrap(t *testing.T) {
	for _, tc := range []struct {
		line  string
		width int
		want  []string
	}{
		{"short", 10, []string{"short"}},
		{"one two three four", 9, []string{"one two", "three", "four"}},
		{"   indented words here", 12, []string{"   indented", "   words", "   here"}},
		{"see https://example.com/a/very/long/path now", 12, []string{"see", "https://example.com/a/very/long/path", "now"}},
	} {
		if got := wrap(tc.line, tc.width); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("wrap(%q, %d) = %q, want %q", tc.line, tc.width, got, tc.want)
		}
	}
}
