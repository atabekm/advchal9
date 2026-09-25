package savefile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func setup(t *testing.T) (string, *mcp.ClientSession) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "out")
	s := NewServer(&Saver{Dir: dir})
	ct, st := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := s.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return dir, cs
}

func save(t *testing.T, cs *mcp.ClientSession, args map[string]any) (*mcp.CallToolResult, Out) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "save_to_file", Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	var out Out
	b, _ := json.Marshal(res.StructuredContent)
	json.Unmarshal(b, &out)
	return res, out
}

// Written byte for byte: no newline added, CRLF and non-ASCII kept, and the
// reported hash is the hash of the file on disk.
func TestExactBytes(t *testing.T) {
	dir, cs := setup(t)
	content := "# Résumé 🦀\r\nline two\tend"
	res, out := save(t, cs, map[string]any{"filename": "notes.md", "content": content})
	if res.IsError {
		t.Fatalf("tool error: %s", text(res))
	}
	got, err := os.ReadFile(filepath.Join(dir, "notes.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != content {
		t.Errorf("file = %q, want %q", got, content)
	}
	sum := sha256.Sum256(got)
	if out.SHA256 != hex.EncodeToString(sum[:]) || out.Bytes != len(content) || out.Path != filepath.Join(dir, "notes.md") || out.Overwritten {
		t.Errorf("structured: %+v", out)
	}
	if !strings.HasPrefix(text(res), "Saved "+out.Path+" · ") || !strings.HasSuffix(text(res), out.SHA256) {
		t.Errorf("text: %q", text(res))
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestOverwrite(t *testing.T) {
	dir, cs := setup(t)
	save(t, cs, map[string]any{"filename": "a.txt", "content": "first"})

	res, _ := save(t, cs, map[string]any{"filename": "a.txt", "content": "second"})
	if !res.IsError || !strings.Contains(text(res), "already exists") {
		t.Errorf("an existing file needs overwrite: %q", text(res))
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "first" {
		t.Errorf("file changed without overwrite: %q", b)
	}

	res, out := save(t, cs, map[string]any{"filename": "a.txt", "content": "second", "overwrite": true})
	if res.IsError || !out.Overwritten || !strings.HasPrefix(text(res), "Replaced ") {
		t.Errorf("overwrite: %q %+v", text(res), out)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "second" {
		t.Errorf("file = %q", b)
	}
}

func TestRejectedNames(t *testing.T) {
	dir, cs := setup(t)
	outside := filepath.Join(filepath.Dir(dir), "escaped.md")
	for _, name := range []string{
		"", "../escaped.md", outside, "sub/a.md", `sub\a.md`, ".env", ".hidden.md", "..", "x.exe", "noext",
		"a:b.md", "tab\there.md", strings.Repeat("a", 98) + ".md",
	} {
		res, _ := save(t, cs, map[string]any{"filename": name, "content": "x"})
		if !res.IsError {
			t.Errorf("%q: want a tool error, got %q", name, text(res))
		}
	}
	if _, err := os.Stat(outside); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a file was written outside the directory")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("rejected names left files: %v", entries)
	}
	// Upper-case extensions are fine.
	if res, _ := save(t, cs, map[string]any{"filename": "Report.JSON", "content": "{}"}); res.IsError {
		t.Errorf("Report.JSON: %s", text(res))
	}
}

func TestMissingContent(t *testing.T) {
	_, cs := setup(t)
	if res, _ := save(t, cs, map[string]any{"filename": "a.md"}); !res.IsError {
		t.Errorf("content is required, got %q", text(res))
	}
	// Empty content is a legitimate file.
	if res, out := save(t, cs, map[string]any{"filename": "empty.md", "content": ""}); res.IsError || out.Bytes != 0 {
		t.Errorf("empty content: %q %+v", text(res), out)
	}
}

func TestSaveRace(t *testing.T) {
	sv := &Saver{Dir: t.TempDir()}
	errs := make(chan error, 8)
	for i := range 8 {
		go func() {
			_, err := sv.Save("same.md", []byte(strings.Repeat("x", i+1)), false)
			errs <- err
		}()
	}
	ok := 0
	for range 8 {
		err := <-errs
		switch {
		case err == nil:
			ok++
		case !errors.Is(err, ErrExists):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if ok != 1 {
		t.Errorf("%d writers succeeded without overwrite; want exactly 1", ok)
	}
}

func text(r *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}
