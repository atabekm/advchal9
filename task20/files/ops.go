package files

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ErrNoFile is returned by Read for a name with no file behind it.
var ErrNoFile = errors.New("no such file")

type AppendOut struct {
	Path       string `json:"path"`
	Appended   int    `json:"appended" jsonschema:"Bytes of content added, not counting the separator."`
	Separator  string `json:"separator" jsonschema:"Newlines put before the content so it starts on a new paragraph."`
	Bytes      int    `json:"bytes" jsonschema:"The file's size afterwards."`
	SHA256     string `json:"sha256" jsonschema:"Hex SHA-256 of the content appended, as sent."`
	FileSHA256 string `json:"file_sha256" jsonschema:"Hex SHA-256 of the whole file afterwards."`
	Created    bool   `json:"created"`
}

// Append adds data to the end of Dir/name, creating the file if needed. The
// content goes in unchanged; if the file doesn't already end in a blank
// line, newlines are put before it so it starts a new paragraph.
func (st *Store) Append(name string, data []byte) (AppendOut, error) {
	if err := CheckName(name); err != nil {
		return AppendOut{}, err
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := os.MkdirAll(st.Dir, 0o755); err != nil {
		return AppendOut{}, err
	}
	path := filepath.Join(st.Dir, name)
	// A symlink would lead the write outside Dir.
	if fi, err := os.Lstat(path); err == nil && !fi.Mode().IsRegular() {
		return AppendOut{}, fmt.Errorf("%s is not a regular file", path)
	}
	old, err := os.ReadFile(path)
	created := errors.Is(err, os.ErrNotExist)
	if err != nil && !created {
		return AppendOut{}, err
	}
	sep := separator(old)
	if n := len(old) + len(sep) + len(data); n > MaxFileBytes {
		return AppendOut{}, fmt.Errorf("%s would grow to %d bytes; the limit is %d", path, n, MaxFileBytes)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return AppendOut{}, err
	}
	if _, err := f.Write(append([]byte(sep), data...)); err != nil {
		f.Close()
		return AppendOut{}, err
	}
	if err := f.Close(); err != nil {
		return AppendOut{}, err
	}
	whole := append(append(old, sep...), data...)
	return AppendOut{
		Path: path, Appended: len(data), Separator: sep, Bytes: len(whole),
		SHA256: hash(data), FileSHA256: hash(whole), Created: created,
	}, nil
}

func separator(old []byte) string {
	s := string(old)
	switch {
	case s == "" || strings.HasSuffix(s, "\n\n"):
		return ""
	case strings.HasSuffix(s, "\n"):
		return "\n"
	}
	return "\n\n"
}

type ReadOut struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
	// Not "sha256": the agent takes a result's sha256 for a hash of what the
	// call stored, and a read stores nothing.
	FileSHA256 string `json:"file_sha256" jsonschema:"Hex SHA-256 of the file."`
	Modified   string `json:"modified"`
}

// Read returns the file's text exactly.
func (st *Store) Read(name string) (string, ReadOut, error) {
	if err := CheckName(name); err != nil {
		return "", ReadOut{}, err
	}
	path := filepath.Join(st.Dir, name)
	fi, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", ReadOut{}, fmt.Errorf("%w: %s; list shows the files there are", ErrNoFile, path)
	}
	if err != nil {
		return "", ReadOut{}, err
	}
	if !fi.Mode().IsRegular() {
		return "", ReadOut{}, fmt.Errorf("%s is not a regular file", path)
	}
	if fi.Size() > MaxContentBytes {
		return "", ReadOut{}, fmt.Errorf("%s is %d bytes; read returns at most %d", path, fi.Size(), MaxContentBytes)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", ReadOut{}, err
	}
	return string(b), ReadOut{Path: path, Bytes: len(b), FileSHA256: hash(b), Modified: fi.ModTime().Format(time.RFC3339)}, nil
}

// Entry is one file in the directory.
type Entry struct {
	Name      string    `json:"name"`
	Bytes     int64     `json:"bytes"`
	Modified  time.Time `json:"modified"`
	FirstLine string    `json:"first_line,omitempty"`
}

// List returns the files the other tools could read: visible, regular, with
// an allowed extension, sorted by name. A missing directory is empty.
func (st *Store) List() ([]Entry, error) {
	des, err := os.ReadDir(st.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return []Entry{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Entry{}
	for _, de := range des {
		if !de.Type().IsRegular() || CheckName(de.Name()) != nil {
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		out = append(out, Entry{Name: de.Name(), Bytes: fi.Size(), Modified: fi.ModTime(), FirstLine: firstLine(filepath.Join(st.Dir, de.Name()))})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// firstLine is the file's first non-empty line, shortened: for a Markdown
// note, its title, which is often enough to tell what a file covers.
func firstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 64<<10))
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			if r := []rune(l); len(r) > 80 {
				l = string(r[:79]) + "…"
			}
			return l
		}
	}
	return ""
}

func hash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
