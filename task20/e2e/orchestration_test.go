package e2e

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"task20/agent"
	"task20/grade"
	"task20/llm"
)

// callsModel makes the given calls in order, one per model turn. A string
// argument "$N" is replaced by the output of call N, verbatim, the way the
// real model is asked to carry data.
func callsModel(calls ...call) chatFunc {
	return func(msgs []llm.Message) map[string]any {
		var outputs []string
		for _, m := range msgs {
			if m.Role == "tool" {
				outputs = append(outputs, m.Content)
			}
		}
		if len(outputs) == len(calls) {
			return map[string]any{"role": "assistant", "content": "Done."}
		}
		c := calls[len(outputs)]
		args := map[string]any{}
		for k, v := range c.args {
			if s, ok := v.(string); ok && strings.HasPrefix(s, "$") {
				n := int(s[1] - '0')
				v = outputs[n-1]
			}
			args[k] = v
		}
		return toolCall("call_"+string(rune('a'+len(outputs))), c.tool, args)
	}
}

type call struct {
	tool string
	args map[string]any
}

func scenario(t *testing.T) *grade.Scenario {
	scs, err := grade.Load("../scenarios/1-jwst-hn-vs-wiki.json")
	if err != nil {
		t.Fatal(err)
	}
	return scs[0]
}

func run(t *testing.T, calls ...call) (*pipeline, grade.Result) {
	t.Helper()
	p := setupWith(t, callsModel(calls...))
	sc := scenario(t)
	if err := sc.Validate(func(s string) bool { _, ok := p.router.Resolve(s); return ok }); err != nil {
		t.Fatal(err)
	}
	a := agent.New(p.model, p.router, "system", agent.Observer{})
	if _, err := a.Ask(context.Background(), sc.Prompt); err != nil {
		t.Fatal(err)
	}
	return p, grade.Grade(sc, a.Chain)
}

// Scenario 1 played correctly, through the three real servers: every call
// is routed to the server its prefix names, the data flows, and it passes.
func TestScenarioPasses(t *testing.T) {
	p, r := run(t,
		call{"search__hackernews", map[string]any{"query": "James Webb Space Telescope"}},
		call{"search__wikipedia", map[string]any{"query": "James Webb Space Telescope"}},
		call{"text__compare", map[string]any{"a": "$2", "b": "$1", "a_label": "Wikipedia", "b_label": "Hacker News"}},
		call{"file__save", map[string]any{"filename": "jwst-hn-vs-wiki.md", "content": "$3"}},
	)
	if !r.Pass {
		t.Fatalf("want PASS: %+v", r)
	}
	targets := []string{"searchserver.hackernews", "searchserver.wikipedia", "textserver.compare", "fileserver.save"}
	for i, s := range r.Steps {
		if s.Target != targets[i] || s.Call != i+1 {
			t.Errorf("step %s: call %d → %s, want %s", s.Step.ID, s.Call, s.Target, targets[i])
		}
	}
	// The file server really wrote the comparison.
	b, err := os.ReadFile(filepath.Join(p.dir, "jwst-hn-vs-wiki.md"))
	if err != nil || string(b) != summaryText {
		t.Errorf("file %q %v", b, err)
	}
}

// The same scenario with the wrong search tool and the save before the
// comparison: it fails, and says why.
func TestScenarioFails(t *testing.T) {
	_, r := run(t,
		call{"search__wikipedia", map[string]any{"query": "Hacker News James Webb"}},
		call{"search__wikipedia", map[string]any{"query": "James Webb Space Telescope"}},
		call{"file__save", map[string]any{"filename": "jwst-hn-vs-wiki.md", "content": "$2"}},
		call{"text__compare", map[string]any{"a": "$2", "b": "$1"}},
		call{"search__books", map[string]any{"query": "James Webb"}},
	)
	if r.Pass {
		t.Fatal("want FAIL")
	}
	var got []string
	for _, s := range r.Steps {
		for _, p := range s.Problems {
			got = append(got, s.Step.ID+": "+p)
		}
	}
	got = append(got, r.Problems...)
	all := strings.Join(got, "\n")
	for _, want := range []string{
		"hn: not called",
		"cmp: needs hn first, which was not done",
		"save: came before cmp (call 4)",
		"call 5: search__books is forbidden here",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %q in\n%s", want, all)
		}
	}
}
