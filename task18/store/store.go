// Package store keeps jobs, runs and top-list snapshots in SQLite.
//
// The store never reads the clock: every time it records is passed in, so
// the scheduler and the tests decide what "now" is.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"

	"task18/hn"
)

// KindHNTop is the only job kind so far: snapshot the HN top list.
const KindHNTop = "hn_top"

var ErrNotFound = errors.New("not found")

const schema = `
CREATE TABLE IF NOT EXISTS jobs (
	id           INTEGER PRIMARY KEY,
	kind         TEXT    NOT NULL,
	top_n        INTEGER NOT NULL,
	interval_sec INTEGER NOT NULL,
	enabled      INTEGER NOT NULL DEFAULT 1,
	created_at   INTEGER NOT NULL,
	next_run_at  INTEGER NOT NULL,
	last_run_at  INTEGER,
	last_error   TEXT
);
CREATE TABLE IF NOT EXISTS runs (
	id          INTEGER PRIMARY KEY,
	job_id      INTEGER NOT NULL REFERENCES jobs(id),
	started_at  INTEGER NOT NULL,
	finished_at INTEGER NOT NULL,
	ok          INTEGER NOT NULL,
	error       TEXT,
	items       INTEGER NOT NULL DEFAULT 0,
	skipped     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_job_time ON runs(job_id, finished_at);
CREATE TABLE IF NOT EXISTS stories (
	id            INTEGER PRIMARY KEY,
	title         TEXT    NOT NULL,
	url           TEXT    NOT NULL,
	by            TEXT    NOT NULL,
	posted_at     INTEGER NOT NULL,
	first_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
	run_id   INTEGER NOT NULL REFERENCES runs(id),
	story_id INTEGER NOT NULL REFERENCES stories(id),
	rank     INTEGER NOT NULL,
	score    INTEGER NOT NULL,
	comments INTEGER NOT NULL,
	PRIMARY KEY (run_id, story_id)
);
`

type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// One connection: writes are rare and small, and a single connection
	// rules out SQLITE_BUSY between our own goroutines.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("creating schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Job is a scheduled collection.
type Job struct {
	ID        int64
	Kind      string
	TopN      int
	Interval  time.Duration
	Enabled   bool
	CreatedAt time.Time
	NextRunAt time.Time
	LastRunAt time.Time // zero until the first run
	LastError string    // from the most recent run; empty when it succeeded
	Runs      int
}

const jobColumns = `j.id, j.kind, j.top_n, j.interval_sec, j.enabled, j.created_at, j.next_run_at,
	j.last_run_at, j.last_error, (SELECT count(*) FROM runs r WHERE r.job_id = j.id)`

func scanJob(row interface{ Scan(...any) error }) (Job, error) {
	var (
		j                 Job
		interval, created int64
		next              int64
		lastRun           sql.NullInt64
		lastErr           sql.NullString
		enabled           int
	)
	err := row.Scan(&j.ID, &j.Kind, &j.TopN, &interval, &enabled, &created, &next, &lastRun, &lastErr, &j.Runs)
	if err != nil {
		return Job{}, err
	}
	j.Interval = time.Duration(interval) * time.Second
	j.Enabled = enabled == 1
	j.CreatedAt, j.NextRunAt = unix(created), unix(next)
	if lastRun.Valid {
		j.LastRunAt = unix(lastRun.Int64)
	}
	j.LastError = lastErr.String
	return j, nil
}

// EnsureJob returns the enabled job with this kind, size and interval,
// creating it (due immediately) when there is none. created reports which.
func (s *Store) EnsureJob(ctx context.Context, kind string, topN int, interval time.Duration, now time.Time) (j Job, created bool, err error) {
	sec := int64(interval / time.Second)
	// Look-up and insert share a transaction: two clients bootstrapping at
	// once must not both create "the" job.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, false, err
	}
	defer tx.Rollback()
	row := tx.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM jobs j
		WHERE j.enabled = 1 AND j.kind = ? AND j.top_n = ? AND j.interval_sec = ? ORDER BY j.id LIMIT 1`,
		kind, topN, sec)
	j, err = scanJob(row)
	if err == nil {
		return j, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO jobs (kind, top_n, interval_sec, created_at, next_run_at)
		VALUES (?, ?, ?, ?, ?)`, kind, topN, sec, now.Unix(), now.Unix())
	if err != nil {
		return Job{}, false, err
	}
	id, _ := res.LastInsertId()
	if err := tx.Commit(); err != nil {
		return Job{}, false, err
	}
	j, err = s.Job(ctx, id)
	return j, true, err
}

func (s *Store) Job(ctx context.Context, id int64) (Job, error) {
	j, err := scanJob(s.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM jobs j WHERE j.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	return j, err
}

// Jobs lists jobs by id; cancelled ones only when all is set.
func (s *Store) Jobs(ctx context.Context, all bool) ([]Job, error) {
	q := `SELECT ` + jobColumns + ` FROM jobs j`
	if !all {
		q += ` WHERE j.enabled = 1`
	}
	rows, err := s.db.QueryContext(ctx, q+` ORDER BY j.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// CancelJob disables a job. Its history stays and can still be summarised.
func (s *Store) CancelJob(ctx context.Context, id int64) (Job, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE jobs SET enabled = 0 WHERE id = ?`, id)
	if err != nil {
		return Job{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Job{}, ErrNotFound
	}
	return s.Job(ctx, id)
}

// Run is the outcome of one execution of a job.
type Run struct {
	JobID      int64
	StartedAt  time.Time
	FinishedAt time.Time
	Err        error // non-nil: the run failed and Snapshot is ignored
	Snapshot   hn.Snapshot
}

// RunResult is what recording a run produced.
type RunResult struct {
	RunID      int64
	NewStories int // stories this database had never seen before
}

// RecordRun stores a run, its snapshot and the job's next due time in one
// transaction: a crash leaves either the whole run or none of it.
func (s *Store) RecordRun(ctx context.Context, r Run, nextRun time.Time) (RunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RunResult{}, err
	}
	defer tx.Rollback()

	ok, errText := 1, sql.NullString{}
	if r.Err != nil {
		ok, errText = 0, sql.NullString{String: r.Err.Error(), Valid: true}
		r.Snapshot = hn.Snapshot{}
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO runs (job_id, started_at, finished_at, ok, error, items, skipped)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, r.JobID, r.StartedAt.Unix(), r.FinishedAt.Unix(), ok, errText,
		len(r.Snapshot.Stories), r.Snapshot.Skipped)
	if err != nil {
		return RunResult{}, err
	}
	out := RunResult{}
	out.RunID, _ = res.LastInsertId()

	for _, st := range r.Snapshot.Stories {
		var known int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM stories WHERE id = ?`, st.ID).Scan(&known); err != nil {
			return RunResult{}, err
		}
		if known == 0 {
			out.NewStories++
		}
		// Titles get edited; keep the latest, but never move first_seen_at.
		if _, err := tx.ExecContext(ctx, `INSERT INTO stories (id, title, url, by, posted_at, first_seen_at)
			VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url`,
			st.ID, st.Title, st.URL, st.By, st.PostedAt.Unix(), r.FinishedAt.Unix()); err != nil {
			return RunResult{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO snapshots (run_id, story_id, rank, score, comments)
			VALUES (?, ?, ?, ?, ?)`, out.RunID, st.ID, st.Rank, st.Score, st.Comments); err != nil {
			return RunResult{}, err
		}
	}

	if _, err := tx.ExecContext(ctx, `UPDATE jobs SET last_run_at = ?, last_error = ?, next_run_at = ? WHERE id = ?`,
		r.FinishedAt.Unix(), errText, nextRun.Unix(), r.JobID); err != nil {
		return RunResult{}, err
	}
	return out, tx.Commit()
}

func unix(sec int64) time.Time { return time.Unix(sec, 0).UTC() }
