package scheduler

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"task18/hn"
	"task18/store"
)

var t0 = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time          { return c.now }
func (c *clock) advance(d time.Duration) { c.now = c.now.Add(d) }

func setup(t *testing.T) (*store.Store, *clock) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hn.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st, &clock{now: t0}
}

func snapshot(ids ...int64) hn.Snapshot {
	var s hn.Snapshot
	for i, id := range ids {
		s.Stories = append(s.Stories, hn.Story{ID: id, Rank: i + 1, Title: "t", URL: "u"})
	}
	return s
}

func TestTickRunsDueJobsAndReschedules(t *testing.T) {
	st, clk := setup(t)
	ctx := context.Background()
	var calls int
	var events []Event
	s := &Scheduler{Store: st, Now: clk.Now,
		Collect: func(ctx context.Context, j store.Job) (hn.Snapshot, error) {
			calls++
			clk.advance(2 * time.Second) // the run takes time
			return snapshot(1, 2), nil
		},
		OnRun: func(e Event) { events = append(events, e) },
	}

	next, err := s.Tick(ctx)
	if err != nil || !next.IsZero() || calls != 0 {
		t.Fatalf("no jobs: next=%v calls=%d err=%v", next, calls, err)
	}

	j, _, _ := st.EnsureJob(ctx, store.KindHNTop, 30, time.Minute, clk.Now())
	next, err = s.Tick(ctx)
	if err != nil || calls != 1 {
		t.Fatalf("new job is due at once: calls=%d err=%v", calls, err)
	}
	if want := t0.Add(2*time.Second + time.Minute); !next.Equal(want) {
		t.Errorf("next = %v, want finish + interval = %v", next, want)
	}
	if len(events) != 1 || events[0].Stories != 2 || events[0].New != 2 || events[0].Duration != 2*time.Second {
		t.Errorf("event: %+v", events)
	}

	clk.advance(30 * time.Second)
	s.Tick(ctx)
	if calls != 1 {
		t.Error("ran before it was due")
	}
	clk.advance(30 * time.Second)
	s.Tick(ctx)
	if calls != 2 {
		t.Error("did not run when due")
	}
	got, _ := st.Job(ctx, j.ID)
	if got.Runs != 2 || events[1].New != 0 {
		t.Errorf("runs=%d new on second run=%d", got.Runs, events[1].New)
	}
}

func TestMissedRunsCollapse(t *testing.T) {
	st, clk := setup(t)
	ctx := context.Background()
	var calls int
	s := &Scheduler{Store: st, Now: clk.Now, Collect: func(context.Context, store.Job) (hn.Snapshot, error) {
		calls++
		return snapshot(1), nil
	}}
	st.EnsureJob(ctx, store.KindHNTop, 30, time.Minute, clk.Now())
	s.Tick(ctx)

	clk.advance(3 * time.Hour) // "server was down"
	next, _ := s.Tick(ctx)
	if calls != 2 {
		t.Fatalf("calls = %d, want 2: 180 missed slots collapse into one run", calls)
	}
	if !next.Equal(clk.Now().Add(time.Minute)) {
		t.Errorf("next = %v, want one interval from now", next)
	}
}

func TestFailedRunIsRecordedAndRescheduled(t *testing.T) {
	st, clk := setup(t)
	ctx := context.Background()
	var gotErr error
	s := &Scheduler{Store: st, Now: clk.Now,
		Collect: func(context.Context, store.Job) (hn.Snapshot, error) { return hn.Snapshot{}, errors.New("HN down") },
		OnRun:   func(e Event) { gotErr = e.Err },
	}
	j, _, _ := st.EnsureJob(ctx, store.KindHNTop, 30, time.Minute, clk.Now())
	next, err := s.Tick(ctx)
	if err != nil {
		t.Fatalf("a failing job must not fail the tick: %v", err)
	}
	if gotErr == nil || !next.Equal(t0.Add(time.Minute)) {
		t.Errorf("err=%v next=%v", gotErr, next)
	}
	got, _ := st.Job(ctx, j.ID)
	if got.LastError != "HN down" || got.Runs != 1 {
		t.Errorf("job: %+v", got)
	}
}

func TestCancelledJobDoesNotRun(t *testing.T) {
	st, clk := setup(t)
	ctx := context.Background()
	var calls int
	s := &Scheduler{Store: st, Now: clk.Now, Collect: func(context.Context, store.Job) (hn.Snapshot, error) {
		calls++
		return snapshot(1), nil
	}}
	j, _, _ := st.EnsureJob(ctx, store.KindHNTop, 30, time.Minute, clk.Now())
	st.CancelJob(ctx, j.ID)
	if next, _ := s.Tick(ctx); calls != 0 || !next.IsZero() {
		t.Errorf("cancelled job ran (calls=%d) or is still scheduled (next=%v)", calls, next)
	}
}

func TestShutdownMidRunRecordsNothing(t *testing.T) {
	st, clk := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	s := &Scheduler{Store: st, Now: clk.Now, Collect: func(ctx context.Context, _ store.Job) (hn.Snapshot, error) {
		cancel()
		return hn.Snapshot{}, ctx.Err()
	}}
	j, _, _ := st.EnsureJob(context.Background(), store.KindHNTop, 30, time.Minute, clk.Now())
	s.Tick(ctx)
	got, _ := st.Job(context.Background(), j.ID)
	if got.Runs != 0 || !got.NextRunAt.Equal(t0) {
		t.Errorf("interrupted run left a trace: runs=%d next=%v", got.Runs, got.NextRunAt)
	}
}

// Run with the real clock: an idle loop must pick up a job added later as
// soon as it is woken, not at some poll interval.
func TestRunWakesForNewJob(t *testing.T) {
	st, _ := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ran := make(chan struct{}, 1)
	var calls atomic.Int32
	s := &Scheduler{Store: st, Collect: func(context.Context, store.Job) (hn.Snapshot, error) {
		if calls.Add(1) == 1 {
			ran <- struct{}{}
		}
		return snapshot(1), nil
	}}
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()

	time.Sleep(50 * time.Millisecond) // let it go idle
	st.EnsureJob(ctx, store.KindHNTop, 30, time.Hour, time.Now())
	s.Wake()
	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("woken loop did not run the new job")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
