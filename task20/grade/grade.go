package grade

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"task20/agent"
)

// minValueChars is the shortest short argument taken as data carried from
// an earlier output: a title, an id. Shorter ones match by chance.
const minValueChars = 4

// Link is one piece of data a call received from an earlier call.
type Link struct {
	From int    // chain step number
	How  string // "exact", "partial", "joined", "whitespace", or `value "…"`
}

// Flow finds, for each successful call, the earlier calls whose output
// reached its arguments: long arguments through the chain's handoff
// verdicts, short ones (a title, an id) when the value is in that output
// and not in the prompt, where the model could have read it instead.
func Flow(c *agent.Chain, prompt string) map[int][]Link {
	flow := map[int][]Link{}
	p := fold(prompt)
	for i, st := range c.Steps {
		if !st.OK {
			continue
		}
		seen := map[int]bool{}
		add := func(n int, how string) {
			if n > 0 && !seen[n] {
				seen[n] = true
				flow[st.N] = append(flow[st.N], Link{From: n, How: how})
			}
		}
		for _, h := range st.Handoffs {
			switch h.Verdict {
			case agent.None:
			case agent.Joined:
				for _, s := range h.Sources {
					add(s.Step, "joined")
				}
			default:
				add(h.From, string(h.Verdict))
			}
		}
		for _, v := range shortValues(st.Args) {
			fv := fold(v)
			if strings.Contains(p, fv) {
				continue
			}
			for j := i - 1; j >= 0; j-- { // the latest output that has it
				if prev := c.Steps[j]; prev.OK && strings.Contains(fold(prev.Output), fv) {
					add(prev.N, fmt.Sprintf("value %q", clip(v, 40)))
					break
				}
			}
		}
		sort.Slice(flow[st.N], func(a, b int) bool { return flow[st.N][a].From < flow[st.N][b].From })
	}
	return flow
}

// shortValues are the string arguments, including those inside arrays,
// long enough to mean something and short enough not to be handoffs.
func shortValues(args map[string]any) []string {
	var out []string
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case string:
			if n := len([]rune(strings.TrimSpace(x))); n >= minValueChars && n < agent.MinHandoffChars {
				out = append(out, strings.TrimSpace(x))
			}
		case []any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	for _, k := range sortedKeys(args) {
		walk(args[k])
	}
	return out
}

// StepResult is one scenario step and the call that fills it.
type StepResult struct {
	Step     Step
	Call     int    // chain step number; 0 when no call fills it
	Target   string // where the call was routed
	Tool     string // the tool called
	Details  []string
	Problems []string
}

func (r StepResult) OK() bool { return r.Call > 0 && len(r.Problems) == 0 }

// Extra is a call no step accounts for.
type Extra struct {
	Call   int
	Tool   string
	Target string
	OK     bool
}

type Result struct {
	Scenario *Scenario
	Steps    []StepResult
	Extra    []Extra
	Problems []string // about the turn as a whole: forbidden or unknown tools, too many calls
	Calls    int      // successful calls
	Failed   int      // failed calls
	Pass     bool
}

// Grade matches the turn's calls to the scenario's steps. Each step takes
// the earliest unclaimed successful call of an accepted tool that meets all
// its conditions; when none does, the earliest such call is reported with
// what it got wrong.
func Grade(sc *Scenario, c *agent.Chain) Result {
	res := Result{Scenario: sc}
	flow := Flow(c, sc.Prompt)
	byN := map[int]agent.ChainStep{}
	for _, st := range c.Steps {
		byN[st.N] = st
		if st.OK {
			res.Calls++
		} else {
			res.Failed++
		}
	}
	claimed := map[int]bool{}
	matched := map[string]int{} // step id → call

	for _, step := range sc.Steps {
		var first *StepResult
		var chosen *StepResult
		failedCall := 0
		for _, st := range c.Steps {
			if !step.accepts(st.Tool) || claimed[st.N] {
				continue
			}
			if !st.OK {
				if failedCall == 0 {
					failedCall = st.N
				}
				continue
			}
			r := check(step, st, matched, flow)
			if first == nil {
				first = &r
			}
			if len(r.Problems) == 0 {
				chosen = &r
				break
			}
		}
		switch {
		case chosen != nil:
		case first != nil:
			chosen = first
		default:
			chosen = &StepResult{Step: step, Problems: []string{"not called"}}
			if failedCall > 0 {
				chosen.Problems = []string{fmt.Sprintf("called at %d but it failed, and never successfully", failedCall)}
			}
		}
		if chosen.Call > 0 {
			claimed[chosen.Call] = true
			matched[step.ID] = chosen.Call
		}
		res.Steps = append(res.Steps, *chosen)
	}

	forbidden := map[string]bool{}
	for _, t := range sc.Forbid {
		forbidden[t] = true
	}
	for _, st := range c.Steps {
		switch {
		case st.Target == "":
			res.Problems = append(res.Problems, fmt.Sprintf("call %d: %s is not a tool any server offers", st.N, st.Tool))
		case forbidden[st.Tool]:
			res.Problems = append(res.Problems, fmt.Sprintf("call %d: %s is forbidden here", st.N, st.Tool))
		}
		if !claimed[st.N] {
			res.Extra = append(res.Extra, Extra{Call: st.N, Tool: st.Tool, Target: st.Target, OK: st.OK})
		}
	}
	if sc.MaxCalls != nil && res.Calls > *sc.MaxCalls {
		res.Problems = append(res.Problems, fmt.Sprintf("%d successful calls; at most %d expected", res.Calls, *sc.MaxCalls))
	}

	res.Pass = len(res.Problems) == 0
	for _, s := range res.Steps {
		res.Pass = res.Pass && s.OK()
	}
	return res
}

// check says whether call st can fill step, given the calls already matched.
func check(step Step, st agent.ChainStep, matched map[string]int, flow map[int][]Link) StepResult {
	r := StepResult{Step: step, Call: st.N, Target: st.Target, Tool: st.Tool}
	var order []string
	for _, id := range step.Before() {
		n, ok := matched[id]
		switch {
		case !ok:
			r.Problems = append(r.Problems, fmt.Sprintf("needs %s first, which was not done", id))
		case n > st.N:
			r.Problems = append(r.Problems, fmt.Sprintf("came before %s (call %d)", id, n))
		default:
			order = append(order, id)
		}
	}
	if len(order) > 0 {
		r.Details = append(r.Details, "after "+strings.Join(order, ", ")+" ✓")
	}
	for _, id := range step.From {
		n, ok := matched[id]
		if !ok {
			continue // already reported as missing
		}
		if how, ok := provenance(st.N, n, flow); ok {
			r.Details = append(r.Details, fmt.Sprintf("from %s (%s)", id, how))
		} else {
			r.Problems = append(r.Problems, fmt.Sprintf("carries nothing from %s (call %d)", id, n))
		}
	}
	for _, k := range sortedKeys(step.Args) {
		want := step.Args[k]
		got, ok := st.Args[k]
		if ok && equal(got, want) {
			r.Details = append(r.Details, fmt.Sprintf("%s=%s ✓", k, show(want)))
		} else if !ok {
			r.Problems = append(r.Problems, fmt.Sprintf("%s missing, want %s", k, show(want)))
		} else {
			r.Problems = append(r.Problems, fmt.Sprintf("%s=%s, want %s", k, show(got), show(want)))
		}
	}
	return r
}

// provenance says how data from call src reached call dst: directly, or
// through a chain of calls ("via 3: exact").
func provenance(dst, src int, flow map[int][]Link) (string, bool) {
	for _, l := range flow[dst] {
		if l.From == src {
			return l.How, true
		}
	}
	for _, l := range flow[dst] {
		if l.From > src {
			if how, ok := provenance(l.From, src, flow); ok {
				if strings.HasPrefix(how, "via ") {
					return fmt.Sprintf("via %d, %s", l.From, strings.TrimPrefix(how, "via ")), true
				}
				return fmt.Sprintf("via %d: %s", l.From, how), true
			}
		}
	}
	return "", false
}

func equal(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	var x, y any
	json.Unmarshal(ja, &x)
	json.Unmarshal(jb, &y)
	return reflect.DeepEqual(x, y)
}

func show(v any) string {
	b, _ := json.Marshal(v)
	return clip(string(b), 40)
}

func fold(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
