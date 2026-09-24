// Package tools exposes the scheduler and the collected history as MCP tools.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task18/store"
)

const (
	ServerName    = "hnserver"
	ServerVersion = "0.1.0"

	MinInterval    = 10 * time.Second
	MaxInterval    = 24 * time.Hour
	defaultSince   = 24 * time.Hour
	defaultTopN    = 30
	defaultLimit   = 5
	maxSummaryLook = 30 * 24 * time.Hour
)

// Deps is what the tools need from the running server.
type Deps struct {
	Store *store.Store
	Wake  func()           // tells the scheduler the job list changed
	Now   func() time.Time // defaults to time.Now
}

// ------------------------------------------------------------------ types

type Job struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	TopN      int    `json:"top_n" jsonschema:"How many top stories each run collects."`
	Every     string `json:"every" jsonschema:"Interval between runs, e.g. '30s' or '15m'."`
	Status    string `json:"status" jsonschema:"'active' or 'cancelled'."`
	CreatedAt string `json:"created_at"`
	NextRunAt string `json:"next_run_at,omitempty" jsonschema:"When the next run is due (active jobs only)."`
	LastRunAt string `json:"last_run_at,omitempty"`
	Runs      int    `json:"runs" jsonschema:"Runs so far, failed ones included."`
	LastError string `json:"last_error,omitempty" jsonschema:"Why the most recent run failed; absent when it succeeded."`
}

type ScheduleIn struct {
	Every string `json:"every" jsonschema:"How often to collect, as a Go duration: '30s', '15m', '1h'. Between 10s and 24h."`
	TopN  int    `json:"top_n,omitempty" jsonschema:"How many top stories to collect on each run."`
}

type ScheduleOut struct {
	Job     Job  `json:"job"`
	Created bool `json:"created" jsonschema:"False when an identical active job already existed and was returned instead."`
}

type ListIn struct {
	IncludeCancelled bool `json:"include_cancelled,omitempty" jsonschema:"Also list cancelled jobs (their history can still be summarised)."`
}

type ListOut struct {
	Now  string `json:"now" jsonschema:"Server time, to compare due times against."`
	Jobs []Job  `json:"jobs"`
}

type CancelIn struct {
	JobID int64 `json:"job_id" jsonschema:"Id of the job to cancel, as returned by list_jobs."`
}

type SummaryIn struct {
	Since string `json:"since,omitempty" jsonschema:"Start of the window: a duration back from now ('2h', '30m') or an RFC 3339 time ('2026-09-24T14:00:00+10:00'). Default 24h."`
	JobID int64  `json:"job_id,omitempty" jsonschema:"Summarise this job's history. Default: the job that collected most recently."`
	Limit int    `json:"limit,omitempty" jsonschema:"Maximum stories per list."`
}

// ----------------------------------------------------------------- server

func NewServer(d Deps) *mcp.Server {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Wake == nil {
		d.Wake = func() {}
	}
	s := mcp.NewServer(&mcp.Implementation{Name: ServerName, Title: "Hacker News collector", Version: ServerVersion},
		&mcp.ServerOptions{Instructions: "Collects the Hacker News top stories in the background on a schedule and " +
			"keeps the history. schedule_collection starts a periodic collection; get_summary reports what " +
			"changed on the front page over a time window."})
	s.AddReceivingMiddleware(nullArgsAsEmpty)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "schedule_collection",
		Title: "Schedule collection",
		Description: "Start collecting the Hacker News top stories periodically in the background. " +
			"Idempotent: if an active job with the same interval and size exists, it is returned instead of a duplicate. " +
			"The first run happens immediately.",
		InputSchema: scheduleSchema(),
		Annotations: &mcp.ToolAnnotations{IdempotentHint: true, OpenWorldHint: ptr(true)},
	}, d.schedule)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_jobs",
		Title:       "List jobs",
		Description: "List scheduled collection jobs with their interval, next and last run, run count and last error.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, d.list)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "cancel_job",
		Title:       "Cancel job",
		Description: "Stop a collection job. Its collected history is kept and can still be summarised.",
		InputSchema: cancelSchema(),
		Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), IdempotentHint: true},
	}, d.cancel)

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_summary",
		Title: "Summarise the front page",
		Description: "Aggregate the collected snapshots over a time window: stories that entered the top list, " +
			"climbed, dropped out or came and went, which gained the most points, the most discussed, and the " +
			"current top. Changes are measured against the last snapshot before the window.",
		InputSchema: summarySchema(),
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, d.summary)

	return s
}

// nullArgsAsEmpty turns `"arguments": null` (or absent) into {}. go-sdk
// v1.8.0 decodes null into a nil map and then panics writing schema defaults
// into it, which takes the whole server down; one argument-less call from any
// client must not do that.
func nullArgsAsEmpty(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if r, ok := req.(*mcp.CallToolRequest); ok && r.Params != nil {
			if a := bytes.TrimSpace(r.Params.Arguments); len(a) == 0 || bytes.Equal(a, []byte("null")) {
				r.Params.Arguments = json.RawMessage("{}")
			}
		}
		return next(ctx, method, req)
	}
}

// Bounds and defaults can't be written as struct tags; they are added to the
// inferred schemas here and reach the model with them.

func scheduleSchema() *jsonschema.Schema {
	s := mustFor[ScheduleIn]()
	p := s.Properties["top_n"]
	p.Minimum, p.Maximum, p.Default = ptr(1.0), ptr(100.0), json.RawMessage("30")
	return s
}

func cancelSchema() *jsonschema.Schema {
	s := mustFor[CancelIn]()
	s.Properties["job_id"].Minimum = ptr(1.0)
	return s
}

func summarySchema() *jsonschema.Schema {
	s := mustFor[SummaryIn]()
	s.Properties["limit"].Minimum, s.Properties["limit"].Maximum = ptr(1.0), ptr(20.0)
	s.Properties["limit"].Default = json.RawMessage("5")
	s.Properties["job_id"].Minimum = ptr(1.0)
	return s
}

// ---------------------------------------------------------------- handlers

func (d Deps) schedule(ctx context.Context, _ *mcp.CallToolRequest, in ScheduleIn) (*mcp.CallToolResult, ScheduleOut, error) {
	every, err := time.ParseDuration(strings.TrimSpace(in.Every))
	if err != nil {
		return nil, ScheduleOut{}, fmt.Errorf("every: %q is not a duration; use e.g. '30s', '15m' or '1h'", in.Every)
	}
	if every < MinInterval || every > MaxInterval {
		return nil, ScheduleOut{}, fmt.Errorf("every must be between %s and %s, got %s", MinInterval, MaxInterval, every)
	}
	every = every.Round(time.Second)
	if in.TopN == 0 {
		in.TopN = defaultTopN
	}
	j, created, err := d.Store.EnsureJob(ctx, store.KindHNTop, in.TopN, every, d.Now())
	if err != nil {
		return nil, ScheduleOut{}, err
	}
	if created {
		d.Wake()
	}
	return nil, ScheduleOut{Job: jobOut(j), Created: created}, nil
}

func (d Deps) list(ctx context.Context, _ *mcp.CallToolRequest, in ListIn) (*mcp.CallToolResult, ListOut, error) {
	jobs, err := d.Store.Jobs(ctx, in.IncludeCancelled)
	if err != nil {
		return nil, ListOut{}, err
	}
	out := ListOut{Now: rfc(d.Now()), Jobs: []Job{}}
	for _, j := range jobs {
		out.Jobs = append(out.Jobs, jobOut(j))
	}
	return nil, out, nil
}

func (d Deps) cancel(ctx context.Context, _ *mcp.CallToolRequest, in CancelIn) (*mcp.CallToolResult, Job, error) {
	j, err := d.Store.CancelJob(ctx, in.JobID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, Job{}, fmt.Errorf("no job with id %d; list_jobs shows the existing ones", in.JobID)
	}
	if err != nil {
		return nil, Job{}, err
	}
	d.Wake()
	return nil, jobOut(j), nil
}

func (d Deps) summary(ctx context.Context, _ *mcp.CallToolRequest, in SummaryIn) (*mcp.CallToolResult, store.Summary, error) {
	now := d.Now()
	from, err := parseSince(in.Since, now)
	if err != nil {
		return nil, store.Summary{}, err
	}
	if in.Limit == 0 {
		in.Limit = defaultLimit
	}
	sum, err := d.Store.Summary(ctx, store.SummaryQuery{JobID: in.JobID, From: from, To: now, Limit: in.Limit})
	if errors.Is(err, store.ErrNotFound) {
		return nil, store.Summary{}, fmt.Errorf("no job with id %d; list_jobs shows the existing ones", in.JobID)
	}
	if err != nil {
		return nil, store.Summary{}, err
	}
	if sum.Window.Snapshots == 0 {
		sum.Note += d.nextRunHint(ctx)
	}
	return nil, sum, nil
}

// parseSince accepts a duration back from now or an absolute RFC 3339 time.
func parseSince(s string, now time.Time) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return now.Add(-defaultSince), nil
	}
	var from time.Time
	if d, err := time.ParseDuration(strings.TrimPrefix(s, "-")); err == nil {
		from = now.Add(-d)
	} else if t, err := time.Parse(time.RFC3339, s); err == nil {
		from = t
	} else {
		return time.Time{}, fmt.Errorf("since: %q is neither a duration ('2h') nor an RFC 3339 time ('2026-09-24T14:00:00+10:00')", s)
	}
	if from.After(now) {
		return time.Time{}, fmt.Errorf("since (%s) is in the future; server time is %s", rfc(from), rfc(now))
	}
	if now.Sub(from) > maxSummaryLook {
		from = now.Add(-maxSummaryLook)
	}
	return from, nil
}

// nextRunHint tells the model when data will exist, so "nothing yet" comes
// with something actionable.
func (d Deps) nextRunHint(ctx context.Context) string {
	jobs, err := d.Store.Jobs(ctx, false)
	if err != nil {
		return ""
	}
	if len(jobs) == 0 {
		return "; no collection is scheduled (use schedule_collection)"
	}
	next := jobs[0].NextRunAt
	for _, j := range jobs[1:] {
		if j.NextRunAt.Before(next) {
			next = j.NextRunAt
		}
	}
	return "; next collection due at " + rfc(next)
}

func jobOut(j store.Job) Job {
	out := Job{ID: j.ID, Kind: j.Kind, TopN: j.TopN, Every: FormatDuration(j.Interval), Status: "cancelled",
		CreatedAt: rfc(j.CreatedAt), Runs: j.Runs, LastError: j.LastError}
	if j.Enabled {
		out.Status, out.NextRunAt = "active", rfc(j.NextRunAt)
	}
	if !j.LastRunAt.IsZero() {
		out.LastRunAt = rfc(j.LastRunAt)
	}
	return out
}

// FormatDuration drops Go's zero units: 15m rather than 15m0s.
func FormatDuration(d time.Duration) string {
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

// rfc renders times in the server's zone, with its offset: server and
// agent share a machine, so what the model reads matches the terminal clock.
func rfc(t time.Time) string { return t.Local().Format(time.RFC3339) }

func mustFor[T any]() *jsonschema.Schema {
	s, err := jsonschema.For[T](nil)
	if err != nil {
		panic(err)
	}
	return s
}

func ptr[T any](v T) *T { return &v }
