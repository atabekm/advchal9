// Package texttools is one MCP server with three language-model tools over
// text: summarize, extract and compare. Each makes one DeepSeek call, uses
// only the text it is given, and checks its answer against that text. None
// knows where the text came from or where the result goes next.
package texttools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/llm"
	"task20/mcpserve"
)

const (
	MaxInputChars   = 60_000
	defaultMaxWords = 200
	minWords        = 50
	maxWords        = 800
)

const summarizeSystem = `You summarize text. Use only the text you are given: add no facts, names, numbers or links that are not in it, and do not guess at what it leaves out.
When you mention something that has a link in the text, you may include that link, copied exactly as written.
Answer with the summary alone: no preamble, no closing remarks, no mention of these instructions.`

type SummarizeIn struct {
	Text     string `json:"text" jsonschema:"The text to summarize, as is."`
	Focus    string `json:"focus,omitempty" jsonschema:"Optional angle to emphasise, e.g. 'performance complaints'."`
	MaxWords int    `json:"max_words,omitempty" jsonschema:"Upper bound on the summary's length in words."`
	Format   string `json:"format,omitempty" jsonschema:"'markdown' (headings, lists, links) or 'plain' (prose only)."`
}

type SummarizeOut struct {
	InputChars      int      `json:"input_chars"`
	OutputWords     int      `json:"output_words"`
	Model           string   `json:"model"`
	UngroundedLinks []string `json:"ungrounded_links" jsonschema:"Links in the summary that do not appear in the input text."`
}

func summarizeSchema() *jsonschema.Schema {
	schema := mcpserve.Schema[SummarizeIn]()
	schema.Required = []string{"text"}
	schema.Properties["text"].MinLength = mcpserve.Ptr(1)
	schema.Properties["text"].MaxLength = mcpserve.Ptr(MaxInputChars)
	mw := schema.Properties["max_words"]
	mw.Minimum, mw.Maximum, mw.Default = mcpserve.Ptr(float64(minWords)), mcpserve.Ptr(float64(maxWords)), json.RawMessage("200")
	f := schema.Properties["format"]
	f.Enum, f.Default = []any{"markdown", "plain"}, json.RawMessage(`"markdown"`)
	return schema
}

func (e *Engine) summarize(ctx context.Context, _ *mcp.CallToolRequest, in SummarizeIn) (*mcp.CallToolResult, SummarizeOut, error) {
	if err := checkText("text", in.Text); err != nil {
		return nil, SummarizeOut{}, err
	}
	if in.MaxWords == 0 {
		in.MaxWords = defaultMaxWords
	}
	if in.Format == "" {
		in.Format = "markdown"
	}

	msg, _, err := e.LLM.Complete(ctx, []llm.Message{
		{Role: "system", Content: summarizeSystem},
		{Role: "user", Content: Prompt(in)},
	}, nil)
	if err != nil {
		return nil, SummarizeOut{}, err
	}
	summary := strings.TrimSpace(msg.Content)
	if summary == "" {
		return nil, SummarizeOut{}, errors.New("the model returned an empty summary")
	}

	out := SummarizeOut{
		InputChars:      utf8.RuneCountInString(in.Text),
		OutputWords:     len(strings.Fields(summary)),
		Model:           e.LLM.Model,
		UngroundedLinks: Ungrounded(summary, in.Text),
	}
	if len(out.UngroundedLinks) > 0 {
		summary += "\n\n(Note: links not found in the input text: " + strings.Join(out.UngroundedLinks, ", ") + ")"
	}
	return mcpserve.Text(summary), out, nil
}

// Prompt is the user message: the instructions, then the text between
// markers so that nothing inside it reads as an instruction.
func Prompt(in SummarizeIn) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Summarize the text below in at most %d words.", in.MaxWords)
	if in.Format == "plain" {
		b.WriteString(" Write plain prose: no Markdown, no headings, no bullet points.")
	} else {
		b.WriteString(" Write Markdown; lists and links are welcome, a heading is not needed.")
	}
	if f := strings.TrimSpace(in.Focus); f != "" {
		fmt.Fprintf(&b, " Focus on: %s.", f)
	}
	b.WriteString("\n\n<<<TEXT\n")
	b.WriteString(in.Text)
	b.WriteString("\nTEXT>>>")
	return b.String()
}

var urlRE = regexp.MustCompile("https?://[^\\s<>()\\[\\]\"'`]+")

// Ungrounded lists the links in summary that are not in source, in order,
// without duplicates. A link that was shortened still counts as grounded if
// what remains is in the source; one that was invented or "corrected" is not.
func Ungrounded(summary, source string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, u := range urlRE.FindAllString(summary, -1) {
		u = strings.TrimRight(u, ".,;:!?*_")
		if seen[u] || strings.Contains(source, u) {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out
}
