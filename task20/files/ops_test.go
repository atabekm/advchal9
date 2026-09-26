package files

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func call(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any, out any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if out != nil {
		b, _ := json.Marshal(res.StructuredContent)
		json.Unmarshal(b, out)
	}
	return res
}

// Append creates, then adds on a new paragraph whatever the file ended with;
// the content itself goes in unchanged and its hash is the one reported.
func TestAppend(t *testing.T) {
	dir, cs := setup(t)
	var out AppendOut
	res := call(t, cs, "append", map[string]any{"filename": "notes.md", "content": "# Notes"}, &out)
	if res.IsError || !out.Created || out.Separator != "" || !strings.HasPrefix(text(res), "Created ") {
		t.Fatalf("create: %s %+v", text(res), out)
	}
	for _, tc := range []struct{ content, sep, file string }{
		{"one", "\n\n", "# Notes\n\none"},
		{"two\n", "\n\n", "# Notes\n\none\n\ntwo\n"},
		{"three\n\n", "\n", "# Notes\n\none\n\ntwo\n\nthree\n\n"},
		{"four", "", "# Notes\n\none\n\ntwo\n\nthree\n\nfour"},
	} {
		out = AppendOut{}
		res := call(t, cs, "append", map[string]any{"filename": "notes.md", "content": tc.content}, &out)
		b, _ := os.ReadFile(filepath.Join(dir, "notes.md"))
		if res.IsError || out.Created || out.Separator != tc.sep || string(b) != tc.file {
			t.Errorf("append %q: %s %+v\nfile %q", tc.content, text(res), out, b)
		}
		if out.SHA256 != hash([]byte(tc.content)) || out.FileSHA256 != hash(b) || out.Bytes != len(b) || out.Appended != len(tc.content) {
			t.Errorf("append %q: hashes/sizes %+v", tc.content, out)
		}
	}
	for _, args := range []map[string]any{{"filename": "notes.md", "content": ""}, {"filename": "../x.md", "content": "x"}, {"filename": "x.md"}} {
		if res := call(t, cs, "append", args, nil); !res.IsError {
			t.Errorf("%v: want an error, got %s", args, text(res))
		}
	}
}

func TestRead(t *testing.T) {
	dir, cs := setup(t)
	content := "# Résumé\r\nexact\tbytes"
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "a.md"), []byte(content), 0o644)
	var out ReadOut
	res := call(t, cs, "read", map[string]any{"filename": "a.md"}, &out)
	if res.IsError || text(res) != content || out.FileSHA256 != hash([]byte(content)) || out.Bytes != len(content) {
		t.Errorf("read: %q %+v", text(res), out)
	}
	if res := call(t, cs, "read", map[string]any{"filename": "b.md"}, nil); !res.IsError || !strings.Contains(text(res), "list shows") {
		t.Errorf("missing file: %s", text(res))
	}
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.md"), []byte("no"), 0o644)
	if res := call(t, cs, "read", map[string]any{"filename": "../secret.md"}, nil); !res.IsError {
		t.Errorf("read outside the directory: %s", text(res))
	}
	os.Symlink(filepath.Join(filepath.Dir(dir), "secret.md"), filepath.Join(dir, "link.md"))
	if res := call(t, cs, "read", map[string]any{"filename": "link.md"}, nil); !res.IsError {
		t.Errorf("read through a symlink: %s", text(res))
	}
}

func TestList(t *testing.T) {
	dir, cs := setup(t)
	if res := call(t, cs, "list", nil, nil); res.IsError || text(res) != "The output directory has no files yet." {
		t.Errorf("missing dir: %s", text(res))
	}
	os.MkdirAll(filepath.Join(dir, "sub.md"), 0o755)
	for name, body := range map[string]string{
		"space.md": "\n\n# Space telescopes\nJWST…", "b.txt": "plain", ".hidden.md": "x", "x.exe": "x",
		".tmp-a.md-123": "x", "long.json": `{"k": "` + strings.Repeat("v", 100) + `"}`,
	} {
		os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644)
	}
	mod := time.Date(2026, 9, 26, 14, 2, 0, 0, time.Local)
	os.Chtimes(filepath.Join(dir, "space.md"), mod, mod)

	var out ListOut
	res := call(t, cs, "list", map[string]any{}, &out)
	var names []string
	for _, e := range out.Files {
		names = append(names, e.Name)
	}
	if res.IsError || !slices.Equal(names, []string{"b.txt", "long.json", "space.md"}) {
		t.Fatalf("listed %v: %s", names, text(res))
	}
	lines := strings.Split(text(res), "\n")
	if lines[2] != "space.md · 28 bytes · modified 2026-09-26 14:02 · # Space telescopes" {
		t.Errorf("line %q", lines[2])
	}
	if !strings.HasSuffix(lines[1], "…") || len([]rune(out.Files[1].FirstLine)) != 80 {
		t.Errorf("a long first line is cut: %q", lines[1])
	}
}

func TestToolList(t *testing.T) {
	_, cs := setup(t)
	var names []string
	for tool, err := range cs.Tools(context.Background(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tool.Name)
	}
	if want := slices.Sorted(slices.Values(Tools)); !slices.Equal(names, want) {
		t.Errorf("tools %v, want %v", names, want)
	}
}
