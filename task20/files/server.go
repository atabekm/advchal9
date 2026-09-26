package files

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/mcpserve"
)

const (
	ServerName    = "fileserver"
	ServerVersion = "0.2.0"
)

// Tools lists the tool names.
var Tools = []string{"save", "append", "read", "list"}

type SaveIn struct {
	Filename  string `json:"filename" jsonschema:"A bare file name ending in .md, .txt or .json, e.g. 'rust-async.md'. No directories."`
	Content   string `json:"content" jsonschema:"The text to write, exactly as it should appear in the file."`
	Overwrite bool   `json:"overwrite,omitempty" jsonschema:"Replace the file if it already exists. Default false."`
}

type SaveOut struct {
	Path        string `json:"path" jsonschema:"Where the file was written, relative to the server's working directory."`
	Bytes       int    `json:"bytes"`
	SHA256      string `json:"sha256" jsonschema:"Hex SHA-256 of the bytes written."`
	Overwritten bool   `json:"overwritten"`
}

type AppendIn struct {
	Filename string `json:"filename" jsonschema:"A bare file name ending in .md, .txt or .json. Created if it doesn't exist."`
	Content  string `json:"content" jsonschema:"The text to add at the end, exactly as it should appear."`
}

type NameIn struct {
	Filename string `json:"filename" jsonschema:"A bare file name, as list shows it."`
}

type ListIn struct{}

type ListOut struct {
	Dir   string  `json:"dir"`
	Files []Entry `json:"files"`
}

func NewServer(st *Store) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "Files · one output directory", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Saves, appends to, reads and lists text files in the server's output directory."})
	s.AddReceivingMiddleware(mcpserve.NullArgsAsEmpty)
	name := func(schema *jsonschema.Schema) {
		schema.Properties["filename"].MaxLength = mcpserve.Ptr(maxNameLen)
	}

	save := mcpserve.Schema[SaveIn]()
	save.Required = []string{"filename", "content"}
	name(save)
	mcp.AddTool(s, &mcp.Tool{
		Name:  "save",
		Title: "Save a new file",
		Description: "Write text to a new file in the output directory, exactly as given. The name must be a bare file name " +
			"ending in .md, .txt or .json. An existing file is only replaced when overwrite is true; to add to a file, use append. " +
			"Returns the path, the size and the SHA-256 of what was written.",
		InputSchema: save,
		Annotations: &mcp.ToolAnnotations{DestructiveHint: mcpserve.Ptr(false), OpenWorldHint: mcpserve.Ptr(false)},
	}, func(_ context.Context, _ *mcp.CallToolRequest, in SaveIn) (*mcp.CallToolResult, SaveOut, error) {
		if len(in.Content) > MaxContentBytes {
			return nil, SaveOut{}, fmt.Errorf("content is %d bytes; the limit is %d", len(in.Content), MaxContentBytes)
		}
		out, err := st.Save(in.Filename, []byte(in.Content), in.Overwrite)
		if err != nil {
			return nil, SaveOut{}, err
		}
		verb := "Saved"
		if out.Overwritten {
			verb = "Replaced"
		}
		return mcpserve.Text(fmt.Sprintf("%s %s · %d bytes · sha256 %s", verb, out.Path, out.Bytes, out.SHA256)), out, nil
	})

	app := mcpserve.Schema[AppendIn]()
	app.Required = []string{"filename", "content"}
	name(app)
	mcp.AddTool(s, &mcp.Tool{
		Name:  "append",
		Title: "Append to a file",
		Description: "Add text to the end of a file in the output directory, keeping what is there; the file is created if missing. " +
			"The text goes in exactly as given, starting on a new paragraph. Returns the path, the bytes added, the new size " +
			"and the SHA-256 of the text appended.",
		InputSchema: app,
		Annotations: &mcp.ToolAnnotations{DestructiveHint: mcpserve.Ptr(false), OpenWorldHint: mcpserve.Ptr(false)},
	}, func(_ context.Context, _ *mcp.CallToolRequest, in AppendIn) (*mcp.CallToolResult, AppendOut, error) {
		if len(in.Content) > MaxContentBytes {
			return nil, AppendOut{}, fmt.Errorf("content is %d bytes; the limit is %d", len(in.Content), MaxContentBytes)
		}
		if in.Content == "" {
			return nil, AppendOut{}, errors.New("content is empty; nothing to append")
		}
		out, err := st.Append(in.Filename, []byte(in.Content))
		if err != nil {
			return nil, AppendOut{}, err
		}
		msg := fmt.Sprintf("Appended %d bytes to %s (now %d bytes) · sha256 %s", out.Appended, out.Path, out.Bytes, out.SHA256)
		if out.Created {
			msg = fmt.Sprintf("Created %s with %d bytes · sha256 %s", out.Path, out.Appended, out.SHA256)
		}
		return mcpserve.Text(msg), out, nil
	})

	read := mcpserve.Schema[NameIn]()
	read.Required = []string{"filename"}
	name(read)
	mcp.AddTool(s, &mcp.Tool{
		Name:        "read",
		Title:       "Read a file",
		Description: "Return the full text of one file in the output directory, exactly as stored. Use list to see which files exist.",
		InputSchema: read,
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: mcpserve.Ptr(false)},
	}, func(_ context.Context, _ *mcp.CallToolRequest, in NameIn) (*mcp.CallToolResult, ReadOut, error) {
		text, out, err := st.Read(in.Filename)
		if err != nil {
			return nil, ReadOut{}, err
		}
		return mcpserve.Text(text), out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "list",
		Title: "List files",
		Description: "List the files in the output directory: for each, its name, size, when it was last modified and its first line " +
			"(for a Markdown note, its title). Takes no arguments.",
		InputSchema: mcpserve.Schema[ListIn](),
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: mcpserve.Ptr(false)},
	}, func(context.Context, *mcp.CallToolRequest, ListIn) (*mcp.CallToolResult, ListOut, error) {
		entries, err := st.List()
		if err != nil {
			return nil, ListOut{}, err
		}
		return mcpserve.Text(FormatList(entries)), ListOut{Dir: st.Dir, Files: entries}, nil
	})
	return s
}

// FormatList is one line per file.
func FormatList(entries []Entry) string {
	if len(entries) == 0 {
		return "The output directory has no files yet."
	}
	lines := make([]string, len(entries))
	for i, e := range entries {
		lines[i] = fmt.Sprintf("%s · %s bytes · modified %s", e.Name, thousands(e.Bytes), e.Modified.Format("2006-01-02 15:04"))
		if e.FirstLine != "" {
			lines[i] += " · " + e.FirstLine
		}
	}
	return strings.Join(lines, "\n")
}

func thousands(n int64) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
