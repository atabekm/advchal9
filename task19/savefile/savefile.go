// Package savefile is the third tool of the pipeline: it writes the text it
// is given into one directory, byte for byte. It does not know what the text
// is or where it came from.
package savefile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task19/mcpserve"
)

const (
	ServerName    = "fileserver"
	ServerVersion = "0.1.0"

	MaxContentBytes = 1 << 20
	maxNameLen      = 100
)

var allowedExt = []string{".md", ".txt", ".json"}

type In struct {
	Filename  string `json:"filename" jsonschema:"A bare file name ending in .md, .txt or .json, e.g. 'rust-async.md'. No directories."`
	Content   string `json:"content" jsonschema:"The text to write, exactly as it should appear in the file."`
	Overwrite bool   `json:"overwrite,omitempty" jsonschema:"Replace the file if it already exists. Default false."`
}

type Out struct {
	Path        string `json:"path" jsonschema:"Where the file was written, relative to the server's working directory."`
	Bytes       int    `json:"bytes"`
	SHA256      string `json:"sha256" jsonschema:"Hex SHA-256 of the bytes written."`
	Overwritten bool   `json:"overwritten"`
}

// Saver writes into Dir and nowhere else.
type Saver struct {
	Dir string
}

func NewServer(sv *Saver) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "File saver", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Saves text to a file in the server's output directory."})
	s.AddReceivingMiddleware(mcpserve.NullArgsAsEmpty)

	schema := mcpserve.Schema[In]()
	schema.Required = []string{"filename", "content"}
	schema.Properties["filename"].MaxLength = mcpserve.Ptr(maxNameLen)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "save_to_file",
		Title: "Save to file",
		Description: "Write text to a file in the output directory, exactly as given. The name must be a bare file name " +
			"ending in .md, .txt or .json. An existing file is only replaced when overwrite is true. " +
			"Returns the path, the size and the SHA-256 of what was written.",
		InputSchema: schema,
		Annotations: &mcp.ToolAnnotations{DestructiveHint: mcpserve.Ptr(false), OpenWorldHint: mcpserve.Ptr(false)},
	}, sv.handle)
	return s
}

func (sv *Saver) handle(_ context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, Out, error) {
	if err := CheckName(in.Filename); err != nil {
		return nil, Out{}, err
	}
	if len(in.Content) > MaxContentBytes {
		return nil, Out{}, fmt.Errorf("content is %d bytes; the limit is %d", len(in.Content), MaxContentBytes)
	}
	out, err := sv.Save(in.Filename, []byte(in.Content), in.Overwrite)
	if err != nil {
		return nil, Out{}, err
	}
	verb := "Saved"
	if out.Overwritten {
		verb = "Replaced"
	}
	return mcpserve.Text(fmt.Sprintf("%s %s · %d bytes · sha256 %s", verb, out.Path, out.Bytes, out.SHA256)), out, nil
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
func (sv *Saver) Save(name string, data []byte, overwrite bool) (Out, error) {
	if err := CheckName(name); err != nil {
		return Out{}, err
	}
	if err := os.MkdirAll(sv.Dir, 0o755); err != nil {
		return Out{}, err
	}
	path := filepath.Join(sv.Dir, name)
	_, statErr := os.Lstat(path)
	exists := statErr == nil
	if exists && !overwrite {
		return Out{}, fmt.Errorf("%w: %s already exists; choose another name or set overwrite to true", ErrExists, path)
	}

	tmp, err := os.CreateTemp(sv.Dir, ".tmp-"+name+"-*")
	if err != nil {
		return Out{}, err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return Out{}, err
	}
	if err := tmp.Close(); err != nil {
		return Out{}, err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return Out{}, err
	}
	if !overwrite {
		// Link fails if the name appeared since the check above; rename would
		// silently replace it.
		if err := os.Link(tmp.Name(), path); err != nil {
			if os.IsExist(err) {
				return Out{}, fmt.Errorf("%w: %s already exists; choose another name or set overwrite to true", ErrExists, path)
			}
			return Out{}, err
		}
	} else if err := os.Rename(tmp.Name(), path); err != nil {
		return Out{}, err
	}

	sum := sha256.Sum256(data)
	return Out{Path: path, Bytes: len(data), SHA256: hex.EncodeToString(sum[:]), Overwritten: exists}, nil
}
