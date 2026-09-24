// Package scheduler runs due jobs in the background, independently of any
// MCP client: it reads due times from the store, runs the jobs, records the
// results and sleeps until the next one.
package scheduler

import (
	"context"
	"sync"
	"time"

	"task18/hn"
	"task18/store"
)

// Collector performs one job run.
type Collector func(ctx context.Context, job store.Job) (hn.Snapshot, error)

// Event describes a finished run, for logging.
type Event struct {
	Job      store.Job
	Err      error
	Stories  int
	Skipped  int
	New      int
	Duration time.Duration
}

type Scheduler struct {
	Store   *store.Store
	Collect Collector
	Now     func() time.Time // defaults to time.Now
	OnRun   func(Event)      // optional
	OnError func(error)      // optional: store failures the loop survived

	once sync.Once
	wake chan struct{}
}

// retryAfter is how long the loop waits after the store itself failed.
const retryAfter = 5 * time.Second

func (s *Scheduler) init() {
	s.once.Do(func() {
		s.wake = make(chan struct{}, 1)
		if s.Now == nil {
			s.Now = time.Now
		}
	})
}

// Wake makes a sleeping loop re-read the jobs, e.g. after one was added or
// cancelled. It never blocks.
func (s *Scheduler) Wake() {
	s.init()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run loops until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	s.init()
	for {
		next, err := s.Tick(ctx)
		if ctx.Err() != nil {
			return
		}
		var timer <-chan time.Time
		switch {
		case err != nil:
			if s.OnError != nil {
				s.OnError(err)
			}
			timer = time.After(retryAfter)
		case !next.IsZero():
			timer = time.After(next.Sub(s.Now()))
		}
		// No jobs and no error: timer stays nil, only a wake-up moves us.
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-timer:
		}
	}
}

// Tick runs every enabled job due at Now, one after another, and returns the
// earliest next due time (zero when there are no jobs).
//
// A job's next run is scheduled from when this run finished, so a job that
// was due many times over while the server was down runs once, not once per
// missed slot; and a slow run can never overlap the next one.
func (s *Scheduler) Tick(ctx context.Context) (time.Time, error) {
	s.init()
	jobs, err := s.Store.Jobs(ctx, false)
	if err != nil {
		return time.Time{}, err
	}
	var next time.Time
	for _, j := range jobs {
		due := j.NextRunAt
		if !due.After(s.Now()) {
			if due, err = s.run(ctx, j); err != nil {
				return time.Time{}, err
			}
		}
		if next.IsZero() || due.Before(next) {
			next = due
		}
	}
	return next, nil
}

func (s *Scheduler) run(ctx context.Context, j store.Job) (time.Time, error) {
	started := s.Now()
	snap, runErr := s.Collect(ctx, j)
	if ctx.Err() != nil {
		// Shutting down mid-run: record nothing, so the job is still due and
		// runs first thing after a restart.
		return time.Time{}, ctx.Err()
	}
	finished := s.Now()
	next := finished.Add(j.Interval)
	res, err := s.Store.RecordRun(ctx, store.Run{
		JobID: j.ID, StartedAt: started, FinishedAt: finished, Err: runErr, Snapshot: snap,
	}, next)
	if err != nil {
		return time.Time{}, err
	}
	if s.OnRun != nil {
		ev := Event{Job: j, Err: runErr, Duration: finished.Sub(started)}
		if runErr == nil {
			ev.Stories, ev.Skipped, ev.New = len(snap.Stories), snap.Skipped, res.NewStories
		}
		s.OnRun(ev)
	}
	return next, nil
}
