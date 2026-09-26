package texttools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/llm"
	"task20/mcpserve"
)

const (
	defaultCompareWords = 300
	minCompareWords     = 100
	maxCompareWords     = 1000
)

const compareSystem = `You compare two texts. Use only what they say: add no facts, names, numbers or links, and do not guess at what they leave out.
Answer in Markdown with exactly these four sections, in this order, using the labels you are given:
## In common
## Only in <label A>
## Only in <label B>
## Where they disagree
Under each, a bullet list; write "- Nothing." for an empty section. In "In common" and "Where they disagree", each bullet says what each side says.
When you mention something that has a link in either text, you may include that link, copied exactly as written.
Answer with the comparison alone: no title, no preamble, no closing remarks.`

type CompareIn struct {
	A        string `json:"a" jsonschema:"The first text, as is."`
	B        string `json:"b" jsonschema:"The second text, as is."`
	ALabel   string `json:"a_label,omitempty" jsonschema:"A short name for the first text, e.g. 'Wikipedia'. Default 'A'."`
	BLabel   string `json:"b_label,omitempty" jsonschema:"A short name for the second text, e.g. 'Hacker News'. Default 'B'."`
	Focus    string `json:"focus,omitempty" jsonschema:"Optional angle, e.g. 'cost and delays'."`
	MaxWords int    `json:"max_words,omitempty" jsonschema:"Upper bound on the comparison's length in words."`
}

type CompareOut struct {
	AChars          int      `json:"a_chars"`
	BChars          int      `json:"b_chars"`
	OutputWords     int      `json:"output_words"`
	Sections        []string `json:"sections" jsonschema:"The section headings the answer has."`
	UngroundedLinks []string `json:"ungrounded_links" jsonschema:"Links in the comparison that appear in neither text."`
	Model           string   `json:"model"`
}

func compareSchema() *jsonschema.Schema {
	schema := mcpserve.Schema[CompareIn]()
	schema.Required = []string{"a", "b"}
	for _, k := range []string{"a", "b"} {
		schema.Properties[k].MinLength = mcpserve.Ptr(1)
		schema.Properties[k].MaxLength = mcpserve.Ptr(MaxInputChars / 2)
	}
	for _, k := range []string{"a_label", "b_label"} {
		schema.Properties[k].MaxLength = mcpserve.Ptr(40)
	}
	mw := schema.Properties["max_words"]
	mw.Minimum, mw.Maximum, mw.Default = mcpserve.Ptr(float64(minCompareWords)), mcpserve.Ptr(float64(maxCompareWords)), json.RawMessage(fmt.Sprint(defaultCompareWords))
	return schema
}

func (e *Engine) compare(ctx context.Context, _ *mcp.CallToolRequest, in CompareIn) (*mcp.CallToolResult, CompareOut, error) {
	for arg, s := range map[string]string{"a": in.A, "b": in.B} {
		if err := checkText(arg, s); err != nil {
			return nil, CompareOut{}, err
		}
	}
	if utf8.RuneCountInString(in.A)+utf8.RuneCountInString(in.B) > MaxInputChars {
		return nil, CompareOut{}, fmt.Errorf("a and b together exceed %d characters; shorten them first", MaxInputChars)
	}
	in.ALabel, in.BLabel = label(in.ALabel, "A"), label(in.BLabel, "B")
	if in.ALabel == in.BLabel {
		in.BLabel += " (2)"
	}
	if in.MaxWords == 0 {
		in.MaxWords = defaultCompareWords
	}
	msg, _, err := e.LLM.Complete(ctx, []llm.Message{
		{Role: "system", Content: compareSystem},
		{Role: "user", Content: ComparePrompt(in)},
	}, nil)
	if err != nil {
		return nil, CompareOut{}, err
	}
	text := strings.TrimSpace(msg.Content)
	if text == "" {
		return nil, CompareOut{}, errEmptyAnswer
	}
	out := CompareOut{
		AChars: utf8.RuneCountInString(in.A), BChars: utf8.RuneCountInString(in.B),
		OutputWords: len(strings.Fields(text)), Sections: Sections(text),
		UngroundedLinks: Ungrounded(text, in.A+"\n"+in.B), Model: e.LLM.Model,
	}
	if len(out.UngroundedLinks) > 0 {
		text += "\n\n(Note: links found in neither text: " + strings.Join(out.UngroundedLinks, ", ") + ")"
	}
	return mcpserve.Text(text), out, nil
}

func label(s, def string) string {
	if s = strings.Join(strings.Fields(s), " "); s != "" {
		return s
	}
	return def
}

func ComparePrompt(in CompareIn) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Compare the two texts below in at most %d words. Label A is %q, label B is %q.", in.MaxWords, in.ALabel, in.BLabel)
	if f := strings.TrimSpace(in.Focus); f != "" {
		fmt.Fprintf(&b, " Focus on: %s.", f)
	}
	fmt.Fprintf(&b, "\n\n<<<A: %s\n%s\nA>>>\n\n<<<B: %s\n%s\nB>>>", in.ALabel, in.A, in.BLabel, in.B)
	return b.String()
}

// Sections lists the "## " headings of a Markdown answer, in order.
func Sections(md string) []string {
	out := []string{}
	for _, l := range strings.Split(md, "\n") {
		if h, ok := strings.CutPrefix(strings.TrimSpace(l), "## "); ok {
			out = append(out, strings.TrimSpace(h))
		}
	}
	return out
}
