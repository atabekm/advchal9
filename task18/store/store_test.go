package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"task18/hn"
)

var t0 = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "hn.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// st builds a story; score and comments are given, rank comes from position.
type st struct {
	id              int64
	score, comments int
}

// record stores a successful snapshot for job at time at, ranked in order.
func record(t *testing.T, s *Store, job int64, at time.Time, stories ...st) {
	t.Helper()
	snap := hn.Snapshot{}
	for i, x := range stories {
		snap.Stories = append(snap.Stories, hn.Story{
			ID: x.id, Rank: i + 1, Title: fmt.Sprintf("story %d", x.id), URL: fmt.Sprintf("https://example.com/%d", x.id),
			By: "u", Score: x.score, Comments: x.comments, PostedAt: at.Add(-time.Hour),
		})
	}
	if _, err := s.RecordRun(context.Background(), Run{JobID: job, StartedAt: at, FinishedAt: at, Snapshot: snap}, at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
}

func newJob(t *testing.T, s *Store) int64 {
	t.Helper()
	j, _, err := s.EnsureJob(context.Background(), KindHNTop, 30, time.Minute, t0.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return j.ID
}

func ids(es []Entry) []int64 {
	out := []int64{}
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

func eq(t *testing.T, what string, got, want []int64) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func TestEnsureJobIsIdempotent(t *testing.T) {
	s, ctx := open(t), context.Background()
	a, created, err := s.EnsureJob(ctx, KindHNTop, 30, time.Minute, t0)
	if err != nil || !created {
		t.Fatalf("first: created=%v err=%v", created, err)
	}
	b, created, err := s.EnsureJob(ctx, KindHNTop, 30, time.Minute, t0.Add(time.Hour))
	if err != nil || created || b.ID != a.ID {
		t.Fatalf("second: id=%d created=%v err=%v, want id %d reused", b.ID, created, err, a.ID)
	}
	c, created, _ := s.EnsureJob(ctx, KindHNTop, 30, 2*time.Minute, t0)
	if !created || c.ID == a.ID {
		t.Fatal("a different interval must be a different job")
	}
	if !a.NextRunAt.Equal(t0) {
		t.Errorf("new job due at %v, want immediately (%v)", a.NextRunAt, t0)
	}

	if _, err := s.CancelJob(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	d, created, _ := s.EnsureJob(ctx, KindHNTop, 30, time.Minute, t0)
	if !created || d.ID == a.ID {
		t.Fatal("a cancelled job must not be revived")
	}
	jobs, _ := s.Jobs(ctx, false)
	all, _ := s.Jobs(ctx, true)
	if len(jobs) != 2 || len(all) != 3 {
		t.Errorf("enabled=%d all=%d, want 2 and 3", len(jobs), len(all))
	}
	if _, err := s.CancelJob(ctx, 999); !errors.Is(err, ErrNotFound) {
		t.Errorf("cancel unknown: %v, want ErrNotFound", err)
	}
}

func TestRecordRun(t *testing.T) {
	s, ctx := open(t), context.Background()
	job := newJob(t, s)
	snap := hn.Snapshot{Stories: []hn.Story{{ID: 1, Rank: 1, Title: "a", URL: "u"}, {ID: 2, Rank: 2, Title: "b", URL: "u"}}}
	r, err := s.RecordRun(ctx, Run{JobID: job, StartedAt: t0, FinishedAt: t0, Snapshot: snap}, t0.Add(time.Minute))
	if err != nil || r.NewStories != 2 {
		t.Fatalf("first run: new=%d err=%v, want 2", r.NewStories, err)
	}
	snap.Stories = append(snap.Stories, hn.Story{ID: 3, Rank: 3, Title: "c", URL: "u"})
	snap.Stories[0].Title = "a (edited)"
	r, _ = s.RecordRun(ctx, Run{JobID: job, StartedAt: t0.Add(time.Minute), FinishedAt: t0.Add(time.Minute), Snapshot: snap}, t0.Add(2*time.Minute))
	if r.NewStories != 1 {
		t.Errorf("second run: new=%d, want 1", r.NewStories)
	}

	_, err = s.RecordRun(ctx, Run{JobID: job, StartedAt: t0.Add(2 * time.Minute), FinishedAt: t0.Add(2 * time.Minute),
		Err: errors.New("boom"), Snapshot: snap}, t0.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	j, _ := s.Job(ctx, job)
	if j.Runs != 3 || j.LastError != "boom" || !j.NextRunAt.Equal(t0.Add(3*time.Minute)) {
		t.Errorf("job after failure: runs=%d err=%q next=%v", j.Runs, j.LastError, j.NextRunAt)
	}
	var n int
	s.db.QueryRow(`SELECT count(*) FROM snapshots`).Scan(&n)
	if n != 5 {
		t.Errorf("snapshots rows = %d, want 5 (a failed run stores none)", n)
	}
	var title string
	s.db.QueryRow(`SELECT title FROM stories WHERE id = 1`).Scan(&title)
	if title != "a (edited)" {
		t.Errorf("title = %q, want the latest", title)
	}
}

func TestSummary(t *testing.T) {
	s, ctx := open(t), context.Background()
	job := newJob(t, s)

	// Before the window: the baseline.
	record(t, s, job, t0.Add(-10*time.Minute), st{1, 100, 10}, st{2, 50, 5}, st{3, 40, 90}, st{4, 30, 1})
	// Inside the window.
	record(t, s, job, t0.Add(1*time.Minute), st{1, 110, 12}, st{5, 20, 3}, st{2, 60, 6}, st{3, 45, 95}, st{4, 31, 1})
	record(t, s, job, t0.Add(2*time.Minute), st{1, 120, 14}, st{6, 10, 0}, st{2, 70, 7}, st{5, 25, 4})
	record(t, s, job, t0.Add(3*time.Minute), st{4, 200, 40}, st{1, 130, 15}, st{7, 5, 0}, st{2, 80, 8})
	// After the window: must be ignored.
	record(t, s, job, t0.Add(10*time.Minute), st{9, 1, 1})

	sum, err := s.Summary(ctx, SummaryQuery{From: t0, To: t0.Add(5 * time.Minute), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if sum.JobID != job || sum.Window.Snapshots != 3 || sum.Window.FailedRuns != 0 {
		t.Errorf("window: %+v", sum.Window)
	}
	if sum.Window.BaselineAt != rfc(t0.Add(-10*time.Minute)) || sum.Window.LatestAt != rfc(t0.Add(3*time.Minute)) {
		t.Errorf("baseline/latest = %s / %s", sum.Window.BaselineAt, sum.Window.LatestAt)
	}
	if sum.StoriesTracked != 7 {
		t.Errorf("tracked = %d, want 7", sum.StoriesTracked)
	}
	eq(t, "new", ids(sum.NewEntries), []int64{7})
	eq(t, "risers", ids(sum.Risers), []int64{4}) // 4 → 1
	if r := sum.Risers[0]; r.RankFrom != 4 || r.Rank != 1 {
		t.Errorf("riser ranks %d→%d, want 4→1", r.RankFrom, r.Rank)
	}
	eq(t, "dropped", ids(sum.Dropped), []int64{3})
	if sum.Dropped[0].Rank != 4 {
		t.Errorf("dropped rank = %d, want last seen 4", sum.Dropped[0].Rank)
	}
	eq(t, "came and went", ids(sum.CameAndWent), []int64{5, 6})
	eq(t, "points gained", ids(sum.PointsGained), []int64{4, 1, 2}) // +170, then a +30 tie broken by rank
	eq(t, "most discussed", ids(sum.MostDiscussed), []int64{4, 1, 2, 7})
	eq(t, "current top", ids(sum.CurrentTop), []int64{4, 1, 7, 2})
	if sum.Counts != (Counts{NewEntries: 1, Risers: 1, Dropped: 1, CameAndWent: 2}) {
		t.Errorf("counts = %+v", sum.Counts)
	}
	e := sum.CurrentTop[0]
	if e.Title != "story 4" || e.Discussion != hn.PageURL(4) || e.Score != 200 {
		t.Errorf("entry metadata: %+v", e)
	}
}

func TestSummaryWithoutBaseline(t *testing.T) {
	s, ctx := open(t), context.Background()
	job := newJob(t, s)
	record(t, s, job, t0.Add(time.Minute), st{1, 10, 0}, st{2, 5, 0})

	sum, _ := s.Summary(ctx, SummaryQuery{From: t0, To: t0.Add(time.Hour), Limit: 5})
	if sum.Window.Snapshots != 1 || sum.Note == "" || len(sum.NewEntries) != 0 {
		t.Errorf("single snapshot: %+v", sum)
	}
	eq(t, "current top", ids(sum.CurrentTop), []int64{1, 2})

	record(t, s, job, t0.Add(2*time.Minute), st{2, 9, 0}, st{3, 1, 0})
	sum, _ = s.Summary(ctx, SummaryQuery{From: t0, To: t0.Add(time.Hour), Limit: 5})
	if sum.Window.BaselineAt != rfc(t0.Add(time.Minute)) || sum.Window.Snapshots != 2 || sum.Note != "" {
		t.Errorf("first in-window snapshot is the baseline: %+v", sum.Window)
	}
	eq(t, "new", ids(sum.NewEntries), []int64{3})
	eq(t, "risers", ids(sum.Risers), []int64{2})
	eq(t, "dropped", ids(sum.Dropped), []int64{1})
}

func TestSummaryEmpty(t *testing.T) {
	s, ctx := open(t), context.Background()
	sum, err := s.Summary(ctx, SummaryQuery{From: t0, To: t0.Add(time.Hour), Limit: 5})
	if err != nil || sum.Note == "" || sum.NewEntries == nil {
		t.Fatalf("no runs at all: note=%q err=%v", sum.Note, err)
	}

	job := newJob(t, s)
	record(t, s, job, t0.Add(-time.Hour), st{1, 1, 1})
	s.RecordRun(ctx, Run{JobID: job, StartedAt: t0, FinishedAt: t0.Add(time.Minute), Err: errors.New("x")}, t0)
	sum, err = s.Summary(ctx, SummaryQuery{From: t0, To: t0.Add(time.Hour), Limit: 5})
	if err != nil || sum.Window.Snapshots != 0 || sum.Window.FailedRuns != 1 || sum.Note == "" || sum.Window.BaselineAt != "" {
		t.Errorf("window with only a failure: %+v err=%v", sum, err)
	}

	if _, err := s.Summary(ctx, SummaryQuery{JobID: 42, From: t0, To: t0, Limit: 5}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown job: %v", err)
	}
}

func TestSummaryLimit(t *testing.T) {
	s, ctx := open(t), context.Background()
	job := newJob(t, s)
	var many []st
	for i := range 10 {
		many = append(many, st{int64(i + 1), 100 - i, i})
	}
	record(t, s, job, t0.Add(time.Minute), many...)
	sum, _ := s.Summary(ctx, SummaryQuery{From: t0, To: t0.Add(time.Hour), Limit: 3})
	eq(t, "current top", ids(sum.CurrentTop), []int64{1, 2, 3})
	eq(t, "most discussed", ids(sum.MostDiscussed), []int64{10, 9, 8})
}

func TestEnsureJobConcurrent(t *testing.T) {
	s, ctx := open(t), context.Background()
	var wg sync.WaitGroup
	var created atomic.Int32
	for range 8 {
		wg.Go(func() {
			if _, c, err := s.EnsureJob(ctx, KindHNTop, 30, time.Minute, t0); err != nil {
				t.Error(err)
			} else if c {
				created.Add(1)
			}
		})
	}
	wg.Wait()
	jobs, _ := s.Jobs(ctx, true)
	if created.Load() != 1 || len(jobs) != 1 {
		t.Errorf("created=%d jobs=%d, want exactly one", created.Load(), len(jobs))
	}
}
