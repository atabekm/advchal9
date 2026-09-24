package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"task18/hn"
	"task18/scheduler"
	"task18/store"
)

var t0 = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

type env struct {
	cs    *mcp.ClientSession
	st    *store.Store
	now   time.Time
	wakes int
}

func setup(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hn.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	e := &env{st: st, now: t0}
	server := NewServer(Deps{Store: st, Now: func() time.Time { return e.now }, Wake: func() { e.wakes++ }})

	ctx := context.Background()
	sT, cT := mcp.NewInMemoryTransports()
	ss, err := server.Connect(ctx, sT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	e.cs, err = mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, cT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.cs.Close() })
	return e
}

// call returns the result; protocol errors (e.g. schema violations) come
// back as err so tests can tell them from tool errors.
func call(cs *mcp.ClientSession, name string, args map[string]any) (*mcp.CallToolResult, error) {
	return cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
}

func decode[T any](t *testing.T, r *mcp.CallToolResult) T {
	t.Helper()
	if r.IsError {
		t.Fatalf("tool error: %s", text(r))
	}
	var v T
	b, _ := json.Marshal(r.StructuredContent)
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func text(r *mcp.CallToolResult) string {
	var parts []string
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			parts = append(parts, tc.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// rejected passes when the call fails, either as a protocol error or as a
// tool error mentioning want.
func rejected(t *testing.T, r *mcp.CallToolResult, err error, want string) {
	t.Helper()
	if err != nil {
		return
	}
	if !r.IsError {
		t.Fatalf("expected a rejection mentioning %q, got success: %s", want, text(r))
	}
	if !strings.Contains(text(r), want) {
		t.Errorf("error %q does not mention %q", text(r), want)
	}
}

func TestToolsListed(t *testing.T) {
	e := setup(t)
	res, err := e.cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
	}
	if got := strings.Join(names, ","); got != "cancel_job,get_summary,list_jobs,schedule_collection" {
		t.Errorf("tools = %s", got)
	}
}

func TestSchedule(t *testing.T) {
	e := setup(t)
	r, err := call(e.cs, "schedule_collection", map[string]any{"every": "30s"})
	if err != nil {
		t.Fatal(err)
	}
	out := decode[ScheduleOut](t, r)
	if !out.Created || out.Job.Every != "30s" || out.Job.TopN != 30 || out.Job.Status != "active" || out.Job.NextRunAt != rfc(t0) {
		t.Errorf("first: %+v", out)
	}
	if e.wakes != 1 {
		t.Errorf("wakes = %d, want 1", e.wakes)
	}

	r, _ = call(e.cs, "schedule_collection", map[string]any{"every": "30s", "top_n": 30})
	again := decode[ScheduleOut](t, r)
	if again.Created || again.Job.ID != out.Job.ID || e.wakes != 1 {
		t.Errorf("repeat must return the same job without waking: %+v wakes=%d", again, e.wakes)
	}

	r, _ = call(e.cs, "schedule_collection", map[string]any{"every": "1h30m", "top_n": 10})
	if j := decode[ScheduleOut](t, r).Job; j.Every != "1h30m" || j.TopN != 10 {
		t.Errorf("formatting: %+v", j)
	}

	r, err = call(e.cs, "schedule_collection", map[string]any{"every": "5s"})
	rejected(t, r, err, "between 10s and 24h")
	r, err = call(e.cs, "schedule_collection", map[string]any{"every": "often"})
	rejected(t, r, err, "not a duration")
	r, err = call(e.cs, "schedule_collection", map[string]any{"every": "1m", "top_n": 500})
	rejected(t, r, err, "top_n")
}

func TestListAndCancel(t *testing.T) {
	e := setup(t)
	call(e.cs, "schedule_collection", map[string]any{"every": "1m"})
	call(e.cs, "schedule_collection", map[string]any{"every": "2m"})

	r, _ := call(e.cs, "cancel_job", map[string]any{"job_id": 1})
	if j := decode[Job](t, r); j.Status != "cancelled" || j.NextRunAt != "" {
		t.Errorf("cancelled job: %+v", j)
	}
	if e.wakes != 3 {
		t.Errorf("wakes = %d, want 3", e.wakes)
	}

	r, _ = call(e.cs, "list_jobs", nil)
	l := decode[ListOut](t, r)
	if len(l.Jobs) != 1 || l.Jobs[0].ID != 2 || l.Now != rfc(t0) {
		t.Errorf("active: %+v", l)
	}
	r, _ = call(e.cs, "list_jobs", map[string]any{"include_cancelled": true})
	if l := decode[ListOut](t, r); len(l.Jobs) != 2 {
		t.Errorf("all: %+v", l)
	}

	r, err := call(e.cs, "cancel_job", map[string]any{"job_id": 99})
	rejected(t, r, err, "no job with id 99")
}

func TestSummary(t *testing.T) {
	e := setup(t)
	ctx := context.Background()

	r, _ := call(e.cs, "get_summary", nil)
	if s := decode[store.Summary](t, r); !strings.Contains(s.Note, "no collection is scheduled") {
		t.Errorf("empty, nothing scheduled: note=%q", s.Note)
	}

	call(e.cs, "schedule_collection", map[string]any{"every": "1m"})
	r, _ = call(e.cs, "get_summary", map[string]any{"since": "1h"})
	if s := decode[store.Summary](t, r); !strings.Contains(s.Note, "next collection due at "+rfc(t0)) {
		t.Errorf("empty, scheduled: note=%q", s.Note)
	}

	snap := func(ids ...int64) hn.Snapshot {
		var s hn.Snapshot
		for i, id := range ids {
			s.Stories = append(s.Stories, hn.Story{ID: id, Rank: i + 1, Title: "t", URL: "u"})
		}
		return s
	}
	for i, ids := range [][]int64{{1, 2}, {2, 3}} {
		at := t0.Add(time.Duration(i+1) * time.Minute)
		if _, err := e.st.RecordRun(ctx, store.Run{JobID: 1, StartedAt: at, FinishedAt: at, Snapshot: snap(ids...)}, at); err != nil {
			t.Fatal(err)
		}
	}
	e.now = t0.Add(time.Hour)

	for _, since := range []string{"2h", rfc(t0)} {
		r, _ = call(e.cs, "get_summary", map[string]any{"since": since})
		s := decode[store.Summary](t, r)
		if s.Window.Snapshots != 2 || len(s.NewEntries) != 1 || s.NewEntries[0].ID != 3 || s.Window.From != rfc(t0.Add(time.Hour-2*time.Hour)) && since == "2h" {
			t.Errorf("since %s: %+v", since, s)
		}
	}
	// Window starting after the first snapshot: that snapshot becomes the baseline.
	r, _ = call(e.cs, "get_summary", map[string]any{"since": rfc(t0.Add(90 * time.Second))})
	if s := decode[store.Summary](t, r); s.Window.Snapshots != 1 || s.Window.BaselineAt != rfc(t0.Add(time.Minute)) || len(s.Dropped) != 1 {
		t.Errorf("baseline before window: %+v", s)
	}

	r, err := call(e.cs, "get_summary", map[string]any{"since": "yesterday"})
	rejected(t, r, err, "neither a duration")
	r, err = call(e.cs, "get_summary", map[string]any{"since": rfc(e.now.Add(time.Hour))})
	rejected(t, r, err, "in the future")
	r, err = call(e.cs, "get_summary", map[string]any{"job_id": 7})
	rejected(t, r, err, "no job with id 7")
}

func TestFormatDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		30 * time.Second: "30s", 15 * time.Minute: "15m", time.Hour: "1h", 90 * time.Minute: "1h30m",
		90 * time.Second: "1m30s", 24 * time.Hour: "24h",
	} {
		if got := FormatDuration(d); got != want {
			t.Errorf("%v → %q, want %q", d, got, want)
		}
	}
}

// End to end over the real HTTP transport, with the scheduler running: a
// client schedules a job, the background loop collects without any further
// calls, and the summary sees it.
func TestOverHTTPWithScheduler(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "hn.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sched := &scheduler.Scheduler{Store: st, Collect: func(context.Context, store.Job) (hn.Snapshot, error) {
		return hn.Snapshot{Stories: []hn.Story{{ID: 42, Rank: 1, Title: "The Answer", URL: "u"}}}, nil
	}}
	go sched.Run(ctx)

	server := NewServer(Deps{Store: st, Wake: sched.Wake})
	ts := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	defer ts.Close()

	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, &mcp.StreamableClientTransport{Endpoint: ts.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	if _, err := call(cs, "schedule_collection", map[string]any{"every": "1h"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		r, err := call(cs, "get_summary", map[string]any{"since": "1m"})
		if err != nil {
			t.Fatal(err)
		}
		s := decode[store.Summary](t, r)
		if len(s.CurrentTop) == 1 && s.CurrentTop[0].Title == "The Answer" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the background run never showed up: %+v", s)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
