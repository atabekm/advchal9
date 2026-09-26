package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"task20/agent"
	"task20/grade"
)

// evalRow is one scenario's line in the closing table.
type evalRow struct {
	name   string
	res    grade.Result
	ran    bool // false: the turn itself failed (setup, model API), so it has no grade
	calls  int  // model requests
	tokens int
	took   time.Duration
}

// eval runs each scenario as a fresh request, grades the calls it made and
// prints a table at the end. Tool outputs are not printed in full here: the
// grade is about which tools ran, in what order, with what data.
func (r *runner) eval(ctx context.Context, router *agent.Router, path string) bool {
	scs, err := grade.Load(path)
	if err != nil {
		r.ui.fail(err.Error(), "")
		return false
	}
	known := func(t string) bool { _, ok := router.Resolve(t); return ok }
	for _, sc := range scs {
		if err := sc.Validate(known); err != nil {
			r.ui.fail(err.Error(), "is every server up?")
			return false
		}
	}
	r.ui.brief = true
	var rows []evalRow
	for i, sc := range scs {
		if ctx.Err() != nil {
			break
		}
		r.ui.scenarioHeader(i+1, len(scs), sc)
		if err := r.setup(ctx, sc); err != nil {
			r.ui.fail("setup: "+err.Error(), "")
			rows = append(rows, evalRow{name: sc.Name})
			continue
		}
		fmt.Println("\n  " + r.ui.bold("› ") + sc.Prompt)
		start := time.Now()
		a, ok := r.run(ctx, sc.Prompt)
		row := evalRow{name: sc.Name, took: time.Since(start)}
		if ok {
			row.ran, row.res = true, grade.Grade(sc, a.Chain)
			row.calls, row.tokens = a.Calls, a.Usage.PromptTokens+a.Usage.CompletionTokens
			r.ui.report(row.res)
		}
		rows = append(rows, row)
	}
	return r.ui.evalTable(rows)
}

// setup runs a scenario's setup calls through the router, outside the
// graded turn.
func (r *runner) setup(ctx context.Context, sc *grade.Scenario) error {
	if len(sc.Setup) == 0 {
		return nil
	}
	router, err := r.ensure(ctx)
	if err != nil {
		return err
	}
	for _, c := range sc.Setup {
		res, err := router.Call(ctx, c.Tool, c.Args)
		if err != nil {
			return fmt.Errorf("%s: %w", c.Tool, err)
		}
		if res.IsError {
			return fmt.Errorf("%s: %s", c.Tool, agent.ResultText(res))
		}
		r.ui.note(fmt.Sprintf("setup %s → %s", c.Tool, oneLine(agent.ResultText(res), r.ui.width-30)))
	}
	return nil
}

func oneLine(s string, n int) string { return clip(strings.Join(strings.Fields(s), " "), n) }
