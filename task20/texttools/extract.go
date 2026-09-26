package texttools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task20/llm"
	"task20/mcpserve"
)

const (
	defaultMaxItems = 30
	maxItems        = 100
	maxColumns      = 8
)

const extractSystem = `You extract items from a text into a table. Use only the text you are given: every value must be stated in it; never add, infer or complete anything.
Answer with one JSON object and nothing else:
{"columns": ["name", ...], "items": [{"values": ["...", ...], "quote": "..."}]}
- columns: short lower-case names for what each item holds, as requested.
- values: one string per column, in column order; "" when the text doesn't say.
- quote: the shortest span of the text that states the item (a clause or one sentence), copied exactly: same spelling, same punctuation, at most 200 characters.
- items in the order they appear in the text, no duplicates. If nothing matches, "items" is [].`

type ExtractIn struct {
	Text     string   `json:"text" jsonschema:"The text to extract from, as is."`
	What     string   `json:"what" jsonschema:"What to pull out, e.g. 'people and the year each is mentioned with' or 'every book title with its author'."`
	Columns  []string `json:"columns,omitempty" jsonschema:"Optional column names, e.g. ['person', 'year']; chosen from 'what' when absent."`
	Format   string   `json:"format,omitempty" jsonschema:"'markdown' for a table, 'json' for an array of objects keyed by column (each with the quote it came from)."`
	MaxItems int      `json:"max_items,omitempty" jsonschema:"Most items to return."`
}

type ExtractOut struct {
	Columns []string `json:"columns"`
	Items   int      `json:"items"`
	Dropped []string `json:"dropped" jsonschema:"Quotes of items dropped because the quote is not in the text."`
	Model   string   `json:"model"`
}

func extractSchema() *jsonschema.Schema {
	schema := mcpserve.Schema[ExtractIn]()
	schema.Required = []string{"text", "what"}
	schema.Properties["text"].MinLength = mcpserve.Ptr(1)
	schema.Properties["text"].MaxLength = mcpserve.Ptr(MaxInputChars)
	schema.Properties["what"].MinLength = mcpserve.Ptr(1)
	schema.Properties["columns"].MaxItems = mcpserve.Ptr(maxColumns)
	f := schema.Properties["format"]
	f.Enum, f.Default = []any{"markdown", "json"}, json.RawMessage(`"markdown"`)
	mi := schema.Properties["max_items"]
	mi.Minimum, mi.Maximum, mi.Default = mcpserve.Ptr(1.0), mcpserve.Ptr(float64(maxItems)), json.RawMessage(fmt.Sprint(defaultMaxItems))
	return schema
}

// Row is one extracted item.
type Row struct {
	Values []string `json:"values"`
	Quote  string   `json:"quote"`
}

type table struct {
	Columns []string `json:"columns"`
	Items   []Row    `json:"items"`
}

func (e *Engine) extract(ctx context.Context, _ *mcp.CallToolRequest, in ExtractIn) (*mcp.CallToolResult, ExtractOut, error) {
	if err := checkText("text", in.Text); err != nil {
		return nil, ExtractOut{}, err
	}
	if strings.TrimSpace(in.What) == "" {
		return nil, ExtractOut{}, fmt.Errorf("what is empty; say what to extract")
	}
	if in.Format == "" {
		in.Format = "markdown"
	}
	if in.MaxItems == 0 {
		in.MaxItems = defaultMaxItems
	}
	msg, _, err := e.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: extractSystem},
		{Role: "user", Content: ExtractPrompt(in)},
	})
	if err != nil {
		return nil, ExtractOut{}, err
	}
	var t table
	if err := json.Unmarshal([]byte(strings.TrimSpace(msg.Content)), &t); err != nil {
		return nil, ExtractOut{}, fmt.Errorf("the model's answer is not the JSON asked for: %v", err)
	}
	if len(t.Columns) == 0 {
		return nil, ExtractOut{}, errEmptyAnswer
	}
	if len(in.Columns) > 0 && len(in.Columns) == len(t.Columns) {
		t.Columns = in.Columns
	}
	kept, dropped := Ground(t.Items, len(t.Columns), in.Text)
	if len(kept) > in.MaxItems {
		kept = kept[:in.MaxItems]
	}
	out := ExtractOut{Columns: t.Columns, Items: len(kept), Dropped: dropped, Model: e.LLM.Model}
	var text string
	if in.Format == "json" {
		text = RowsJSON(t.Columns, kept)
	} else {
		text = RowsMarkdown(t.Columns, kept)
		if len(dropped) > 0 {
			text += fmt.Sprintf("\n\n(Note: %d item(s) dropped because their source is not in the text.)", len(dropped))
		}
	}
	return mcpserve.Text(text), out, nil
}

func ExtractPrompt(in ExtractIn) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Extract: %s.", strings.TrimSpace(in.What))
	if len(in.Columns) > 0 {
		fmt.Fprintf(&b, " Use exactly these columns: %s.", strings.Join(in.Columns, ", "))
	}
	fmt.Fprintf(&b, " At most %d items.", in.MaxItems)
	b.WriteString("\n\n<<<TEXT\n" + in.Text + "\nTEXT>>>")
	return b.String()
}

// Ground keeps the rows whose quote is in the source, ignoring case and
// runs of whitespace, and pads or trims each row to n values. A row with no
// quote, or one the text doesn't contain, is dropped: the model may have
// made it up. Duplicate rows are dropped silently.
func Ground(rows []Row, n int, source string) (kept []Row, dropped []string) {
	src := fold(source)
	seen := map[string]bool{}
	kept, dropped = []Row{}, []string{}
	for _, r := range rows {
		q := strings.TrimSpace(r.Quote)
		if q == "" || !strings.Contains(src, fold(q)) {
			dropped = append(dropped, q)
			continue
		}
		vals := make([]string, n)
		for i := range vals {
			if i < len(r.Values) {
				vals[i] = strings.TrimSpace(r.Values[i])
			}
		}
		key := strings.Join(vals, "\x00")
		if seen[key] {
			continue
		}
		seen[key] = true
		kept = append(kept, Row{Values: vals, Quote: q})
	}
	return kept, dropped
}

func fold(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

// RowsMarkdown is a table with one row per item.
func RowsMarkdown(cols []string, rows []Row) string {
	if len(rows) == 0 {
		return "Nothing matching was found in the text."
	}
	esc := func(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, "|", `\|`), "\n", " ") }
	var b strings.Builder
	b.WriteString("| " + strings.Join(cols, " | ") + " |\n|")
	for range cols {
		b.WriteString(" --- |")
	}
	for _, r := range rows {
		vals := make([]string, len(r.Values))
		for i, v := range r.Values {
			vals[i] = esc(v)
		}
		b.WriteString("\n| " + strings.Join(vals, " | ") + " |")
	}
	return b.String()
}

// RowsJSON is an array of objects with the keys in column order, then the
// quote. encoding/json would sort map keys, so the objects are written out.
func RowsJSON(cols []string, rows []Row) string {
	if len(rows) == 0 {
		return "[]"
	}
	var b strings.Builder
	b.WriteString("[")
	for i, r := range rows {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString("\n  {")
		for j, c := range cols {
			k, _ := json.Marshal(c)
			v, _ := json.Marshal(r.Values[j])
			fmt.Fprintf(&b, "%s: %s, ", k, v)
		}
		q, _ := json.Marshal(r.Quote)
		fmt.Fprintf(&b, `"quote": %s}`, q)
	}
	b.WriteString("\n]")
	return b.String()
}
