// Package files is one MCP server over one directory: save, append, read
// and list. Files are written byte for byte; the server does not know what
// the text is or where it came from, and never touches anything outside Dir.
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

const (
	MaxContentBytes = 1 << 20
	MaxFileBytes    = 4 << 20 // append stops growing a file here
	maxNameLen      = 100
)

var allowedExt = []string{".md", ".txt", ".json"}

// Store reads and writes in Dir and nowhere else.
type Store struct {
	Dir string
	mu  sync.Mutex // serialises appends, which read the file's tail first
}

// ErrExists is returned when the file is there and overwrite was not asked for.
var ErrExists = errors.New("file exists")

// CheckName accepts only a bare, visible file name with an allowed extension.
// Every rejection says what would be accepted, so the caller can fix it.
func CheckName(name string) error {
	switch {
	case name == "":
		return errors.New("filename is empty; give a bare name such as 'summary.md'")
	case strings.ContainsAny(name, `/\`) || name == "." || name == "..":
		return fmt.Errorf("filename %q contains a path; give a bare name such as 'summary.md' (files always go to the output directory)", name)
	case strings.HasPrefix(name, "."):
		return fmt.Errorf("filename %q is hidden; start it with a letter or digit", name)
	case len(name) > maxNameLen:
		return fmt.Errorf("filename is %d bytes long; the limit is %d", len(name), maxNameLen)
	}
	for _, r := range name {
		if unicode.IsControl(r) || r == ':' {
			return fmt.Errorf("filename %q contains %q; use letters, digits, '-', '_' and '.'", name, r)
		}
	}
	ext := strings.ToLower(filepath.Ext(name))
	for _, a := range allowedExt {
		if ext == a {
			return nil
		}
	}
	return fmt.Errorf("filename %q must end in %s", name, strings.Join(allowedExt, ", "))
}

// Save writes data to Dir/name through a temp file and a rename, so a reader
// never sees half a file. Without overwrite, an existing file is left alone.
func (st *Store) Save(name string, data []byte, overwrite bool) (SaveOut, error) {
	if err := CheckName(name); err != nil {
		return SaveOut{}, err
	}
	if err := os.MkdirAll(st.Dir, 0o755); err != nil {
		return SaveOut{}, err
	}
	path := filepath.Join(st.Dir, name)
	_, statErr := os.Lstat(path)
	exists := statErr == nil
	if exists && !overwrite {
		return SaveOut{}, fmt.Errorf("%w: %s already exists; choose another name or set overwrite to true", ErrExists, path)
	}

	tmp, err := os.CreateTemp(st.Dir, ".tmp-"+name+"-*")
	if err != nil {
		return SaveOut{}, err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return SaveOut{}, err
	}
	if err := tmp.Close(); err != nil {
		return SaveOut{}, err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return SaveOut{}, err
	}
	if !overwrite {
		// Link fails if the name appeared since the check above; rename would
		// silently replace it.
		if err := os.Link(tmp.Name(), path); err != nil {
			if os.IsExist(err) {
				return SaveOut{}, fmt.Errorf("%w: %s already exists; choose another name or set overwrite to true", ErrExists, path)
			}
			return SaveOut{}, err
		}
	} else if err := os.Rename(tmp.Name(), path); err != nil {
		return SaveOut{}, err
	}

	sum := sha256.Sum256(data)
	return SaveOut{Path: path, Bytes: len(data), SHA256: hex.EncodeToString(sum[:]), Overwritten: exists}, nil
}
