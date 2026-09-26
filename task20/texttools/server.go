package texttools

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/llm"
	"task20/mcpserve"
)

const (
	ServerName    = "textserver"
	ServerVersion = "0.2.0"
)

// Tools lists the tool names.
var Tools = []string{"summarize", "extract", "compare"}

// Engine holds the model client; the key belongs to this server.
type Engine struct {
	LLM *llm.DeepSeek
}

func NewServer(e *Engine) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "Text · summarize, extract, compare", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Language-model tools over text you pass in: summarize one text, extract a list from it, or compare two. They use nothing but the text given."})
	s.AddReceivingMiddleware(mcpserve.NullArgsAsEmpty)
	ro := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: mcpserve.Ptr(false)}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "summarize",
		Title: "Summarize text",
		Description: "Condense one text into a shorter summary in prose or Markdown. Uses only what the text says; links in " +
			"the summary are copied from it. Returns the summary as plain text. For a list of specific items, use extract; " +
			"for two texts side by side, use compare.",
		InputSchema: summarizeSchema(),
		Annotations: ro,
	}, e.summarize)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "extract",
		Title: "Extract a list",
		Description: "Pull a specific list out of one text, e.g. 'people and the year each is mentioned with' or 'every book title', " +
			"as a Markdown table or a JSON array with the columns you name. Every item is checked against the text: one whose " +
			"source quote is not in the text is dropped. Use it instead of summarize when the result should be data.",
		InputSchema: extractSchema(),
		Annotations: ro,
	}, e.extract)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "compare",
		Title: "Compare two texts",
		Description: "Compare two texts, e.g. two sources on the same topic: what both say, what only one says, and where they " +
			"disagree, as Markdown with one section each; every point names its side. Uses only the two texts. Pass each " +
			"text whole, with a short label saying where it came from.",
		InputSchema: compareSchema(),
		Annotations: ro,
	}, e.compare)
	return s
}

// checkText rejects an empty or oversized text argument.
func checkText(arg, s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("%s is empty", arg)
	}
	if n := utf8.RuneCountInString(s); n > MaxInputChars {
		return fmt.Errorf("%s is %d characters; the limit is %d", arg, n, MaxInputChars)
	}
	return nil
}

var errEmptyAnswer = errors.New("the model returned an empty answer")
