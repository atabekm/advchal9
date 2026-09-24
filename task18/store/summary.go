package store

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"

	"task18/hn"
)

// Entry is one story in a summary list.
type Entry struct {
	ID           int64  `json:"id"`
	Title        string `json:"title"`
	URL          string `json:"url" jsonschema:"The story's link (the discussion page for Ask HN and text posts)."`
	Discussion   string `json:"discussion" jsonschema:"The Hacker News discussion page."`
	Rank         int    `json:"rank" jsonschema:"Position in the latest snapshot; for dropped stories, the last position they held."`
	Score        int    `json:"score"`
	Comments     int    `json:"comments"`
	RankFrom     int    `json:"rank_from,omitempty" jsonschema:"Position at the start of the comparison (risers only)."`
	PointsGained int    `json:"points_gained,omitempty" jsonschema:"Score gained since the story was first seen in the comparison."`
}

type Window struct {
	From       string `json:"from" jsonschema:"Start of the requested window (RFC 3339)."`
	To         string `json:"to"`
	BaselineAt string `json:"baseline_at,omitempty" jsonschema:"The snapshot changes are measured from: the last one before the window, or else the first one in it."`
	LatestAt   string `json:"latest_at,omitempty" jsonschema:"The most recent snapshot in the window."`
	Snapshots  int    `json:"snapshots" jsonschema:"Successful collections inside the window."`
	FailedRuns int    `json:"failed_runs"`
}

type Counts struct {
	NewEntries  int `json:"new_entries"`
	Risers      int `json:"risers"`
	Dropped     int `json:"dropped"`
	CameAndWent int `json:"came_and_went"`
}

// Summary aggregates a job's snapshots over a time window. Lists are cut to
// the requested limit; Counts holds their full lengths.
type Summary struct {
	JobID          int64   `json:"job_id,omitempty"`
	Window         Window  `json:"window"`
	StoriesTracked int     `json:"stories_tracked" jsonschema:"Distinct stories seen in the window's snapshots."`
	Counts         Counts  `json:"counts"`
	NewEntries     []Entry `json:"new_entries" jsonschema:"On the list now, not at the baseline."`
	Risers         []Entry `json:"risers" jsonschema:"On the list at both ends, climbed the most places."`
	Dropped        []Entry `json:"dropped" jsonschema:"On the list at the baseline, gone now."`
	CameAndWent    []Entry `json:"came_and_went" jsonschema:"Appeared and disappeared within the window."`
	PointsGained   []Entry `json:"top_points_gained" jsonschema:"Stories on the list now that gained the most points."`
	MostDiscussed  []Entry `json:"most_discussed" jsonschema:"Stories on the list now with the most comments."`
	CurrentTop     []Entry `json:"current_top" jsonschema:"The top of the latest snapshot."`
	Note           string  `json:"note,omitempty"`
}

type SummaryQuery struct {
	JobID    int64 // 0: the job with the most recent successful run
	From, To time.Time
	Limit    int
}

type point struct{ rank, score, comments int }

type track struct {
	id                int64
	first, last, best point
	inBaseline        bool
	inLatest          bool
}

// Summary compares the latest snapshot in the window with the baseline and
// ranks what changed. No data is not an error: the result says so in Note.
func (s *Store) Summary(ctx context.Context, q SummaryQuery) (Summary, error) {
	out := Summary{
		Window:     Window{From: rfc(q.From), To: rfc(q.To)},
		NewEntries: []Entry{}, Risers: []Entry{}, Dropped: []Entry{}, CameAndWent: []Entry{},
		PointsGained: []Entry{}, MostDiscussed: []Entry{}, CurrentTop: []Entry{},
	}
	jobID := q.JobID
	if jobID == 0 {
		err := s.db.QueryRowContext(ctx, `SELECT job_id FROM runs WHERE ok = 1 AND finished_at <= ?
			ORDER BY finished_at DESC, id DESC LIMIT 1`, q.To.Unix()).Scan(&jobID)
		if errors.Is(err, sql.ErrNoRows) {
			out.Note = "no collection has completed yet"
			return out, nil
		}
		if err != nil {
			return out, err
		}
	} else if _, err := s.Job(ctx, jobID); err != nil {
		return out, err
	}
	out.JobID = jobID

	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE job_id = ? AND ok = 0
		AND finished_at >= ? AND finished_at <= ?`, jobID, q.From.Unix(), q.To.Unix()).Scan(&out.Window.FailedRuns); err != nil {
		return out, err
	}

	var baselineRun int64 = -1
	var baselineAt int64
	err := s.db.QueryRowContext(ctx, `SELECT id, finished_at FROM runs WHERE job_id = ? AND ok = 1 AND finished_at < ?
		ORDER BY finished_at DESC, id DESC LIMIT 1`, jobID, q.From.Unix()).Scan(&baselineRun, &baselineAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}

	rows, err := s.db.QueryContext(ctx, `SELECT r.id, r.finished_at, s.story_id, s.rank, s.score, s.comments
		FROM snapshots s JOIN runs r ON r.id = s.run_id
		WHERE r.job_id = ? AND r.ok = 1 AND (r.id = ? OR (r.finished_at >= ? AND r.finished_at <= ?))
		ORDER BY r.finished_at, r.id, s.rank`, jobID, baselineRun, q.From.Unix(), q.To.Unix())
	if err != nil {
		return out, err
	}
	defer rows.Close()

	var (
		tracks    = map[int64]*track{}
		order     []int64 // run ids in time order
		firstRun  int64
		latestAt  int64
		inWindow        = map[int64]bool{} // stories seen in a window snapshot
		lastRunID int64 = -1
	)
	for rows.Next() {
		var runID, at, id int64
		var p point
		if err := rows.Scan(&runID, &at, &id, &p.rank, &p.score, &p.comments); err != nil {
			return out, err
		}
		if runID != lastRunID {
			order = append(order, runID)
			if len(order) == 1 {
				// The baseline run when there is one, else the window's first.
				firstRun = runID
				out.Window.BaselineAt = rfc(unix(at))
			}
			if runID != baselineRun {
				out.Window.Snapshots++
			}
			lastRunID, latestAt = runID, at
		}
		t := tracks[id]
		if t == nil {
			t = &track{id: id, first: p, best: p}
			tracks[id] = t
		}
		t.last = p
		if p.rank < t.best.rank {
			t.best = p
		}
		if runID == firstRun {
			t.inBaseline = true
		}
		if runID != baselineRun {
			inWindow[id] = true
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if out.Window.Snapshots == 0 {
		out.Window.BaselineAt = ""
		out.Note = "no successful collection inside this window"
		return out, nil
	}
	out.Window.LatestAt = rfc(unix(latestAt))
	out.StoriesTracked = len(inWindow)
	if len(order) == 1 {
		out.Note = "only one snapshot so far; changes need at least two"
	}

	// Which stories are in the latest snapshot: their last point is from it.
	latest := map[int64]bool{}
	rows2, err := s.db.QueryContext(ctx, `SELECT story_id FROM snapshots WHERE run_id = ?`, lastRunID)
	if err != nil {
		return out, err
	}
	for rows2.Next() {
		var id int64
		if err := rows2.Scan(&id); err != nil {
			rows2.Close()
			return out, err
		}
		latest[id] = true
	}
	rows2.Close()

	var newE, risers, dropped, flashes, now []*track
	for _, t := range tracks {
		t.inLatest = latest[t.id]
		switch {
		case t.inLatest && !t.inBaseline:
			newE = append(newE, t)
		case t.inLatest && t.inBaseline && t.first.rank > t.last.rank:
			risers = append(risers, t)
		case !t.inLatest && t.inBaseline:
			dropped = append(dropped, t)
		case !t.inLatest && !t.inBaseline:
			flashes = append(flashes, t)
		}
		if t.inLatest {
			now = append(now, t)
		}
	}
	out.Counts = Counts{NewEntries: len(newE), Risers: len(risers), Dropped: len(dropped), CameAndWent: len(flashes)}

	byRank := func(a, b *track) int { return cmp.Or(cmp.Compare(a.last.rank, b.last.rank), cmp.Compare(a.id, b.id)) }
	slices.SortFunc(newE, byRank)
	slices.SortFunc(risers, func(a, b *track) int {
		return cmp.Or(cmp.Compare(b.first.rank-b.last.rank, a.first.rank-a.last.rank), byRank(a, b))
	})
	slices.SortFunc(dropped, func(a, b *track) int {
		return cmp.Or(cmp.Compare(a.first.rank, b.first.rank), cmp.Compare(a.id, b.id))
	})
	slices.SortFunc(flashes, func(a, b *track) int {
		return cmp.Or(cmp.Compare(a.best.rank, b.best.rank), cmp.Compare(a.id, b.id))
	})
	gained := slices.Clone(now)
	gained = slices.DeleteFunc(gained, func(t *track) bool { return t.last.score <= t.first.score })
	slices.SortFunc(gained, func(a, b *track) int {
		return cmp.Or(cmp.Compare(b.last.score-b.first.score, a.last.score-a.first.score), byRank(a, b))
	})
	discussed := slices.Clone(now)
	slices.SortFunc(discussed, func(a, b *track) int {
		return cmp.Or(cmp.Compare(b.last.comments, a.last.comments), byRank(a, b))
	})
	slices.SortFunc(now, byRank)

	lim := func(ts []*track) []*track { return ts[:min(len(ts), q.Limit)] }
	newE, risers, dropped, flashes = lim(newE), lim(risers), lim(dropped), lim(flashes)
	gained, discussed, now = lim(gained), lim(discussed), lim(now)

	meta, err := s.storyMeta(ctx, newE, risers, dropped, flashes, gained, discussed, now)
	if err != nil {
		return out, err
	}
	entries := func(ts []*track, f func(*track, *Entry)) []Entry {
		es := make([]Entry, 0, len(ts))
		for _, t := range ts {
			e := meta[t.id]
			e.ID, e.Rank, e.Score, e.Comments = t.id, t.last.rank, t.last.score, t.last.comments
			if f != nil {
				f(t, &e)
			}
			es = append(es, e)
		}
		return es
	}
	out.NewEntries = entries(newE, nil)
	out.Risers = entries(risers, func(t *track, e *Entry) { e.RankFrom = t.first.rank })
	out.Dropped = entries(dropped, nil)
	out.CameAndWent = entries(flashes, func(t *track, e *Entry) { e.Rank = t.best.rank })
	out.PointsGained = entries(gained, func(t *track, e *Entry) { e.PointsGained = t.last.score - t.first.score })
	out.MostDiscussed = entries(discussed, nil)
	out.CurrentTop = entries(now, nil)
	return out, nil
}

// storyMeta loads title and links for every story in the given lists.
func (s *Store) storyMeta(ctx context.Context, lists ...[]*track) (map[int64]Entry, error) {
	var ids []any
	seen := map[int64]bool{}
	for _, l := range lists {
		for _, t := range l {
			if !seen[t.id] {
				seen[t.id] = true
				ids = append(ids, t.id)
			}
		}
	}
	meta := map[int64]Entry{}
	if len(ids) == 0 {
		return meta, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, url FROM stories WHERE id IN (?`+
		strings.Repeat(",?", len(ids)-1)+`)`, ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.Title, &e.URL); err != nil {
			return nil, err
		}
		e.Discussion = hn.PageURL(e.ID)
		meta[e.ID] = e
	}
	return meta, rows.Err()
}

// rfc renders times in the server's zone, with its offset: server and
// agent share a machine, so what the model reads matches the terminal clock.
func rfc(t time.Time) string { return t.Local().Format(time.RFC3339) }
