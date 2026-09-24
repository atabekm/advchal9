// Package hn reads the Hacker News Firebase API: the current top-stories
// ranking and the items it points at.
package hn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	DefaultBaseURL = "https://hacker-news.firebaseio.com/v0"
	itemPageURL    = "https://news.ycombinator.com/item?id="
	workers        = 8
)

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient() *Client {
	return &Client{BaseURL: DefaultBaseURL, HTTP: &http.Client{Timeout: 10 * time.Second}}
}

// Story is one ranked entry of a top-stories snapshot.
type Story struct {
	ID       int64
	Rank     int // 1-based position in the top list
	Title    string
	URL      string // the discussion page when the story has no link (Ask HN, text posts)
	By       string
	Score    int
	Comments int
	PostedAt time.Time
}

// Snapshot is the top list as seen at one moment. Skipped counts items that
// were dead, deleted or failed to load; the ranks of the others are kept, so
// a gap in ranks is visible rather than silently closed up.
type Snapshot struct {
	Stories []Story
	Skipped int
}

type item struct {
	ID          int64  `json:"id"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	URL         string `json:"url"`
	By          string `json:"by"`
	Score       int    `json:"score"`
	Descendants int    `json:"descendants"`
	Time        int64  `json:"time"`
	Deleted     bool   `json:"deleted"`
	Dead        bool   `json:"dead"`
}

// Top fetches the first n entries of the top-stories list with their items.
// The ranking request failing fails the snapshot; a single item failing only
// skips that item.
func (c *Client) Top(ctx context.Context, n int) (Snapshot, error) {
	var ids []int64
	if err := c.get(ctx, "/topstories.json", &ids); err != nil {
		return Snapshot{}, fmt.Errorf("top stories: %w", err)
	}
	if len(ids) > n {
		ids = ids[:n]
	}

	slots := make([]*Story, len(ids))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for range min(workers, len(ids)) {
		wg.Go(func() {
			for i := range jobs {
				slots[i] = c.story(ctx, ids[i], i+1)
			}
		})
	}
	for i := range ids {
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	snap := Snapshot{Stories: make([]Story, 0, len(slots))}
	for _, s := range slots {
		if s == nil {
			snap.Skipped++
			continue
		}
		snap.Stories = append(snap.Stories, *s)
	}
	if len(snap.Stories) == 0 && len(ids) > 0 {
		return Snapshot{}, errors.New("no item of the top list could be loaded")
	}
	return snap, nil
}

// story loads one item; nil means skip it (unreachable, null, deleted, dead).
func (c *Client) story(ctx context.Context, id int64, rank int) *Story {
	var it *item
	if err := c.get(ctx, "/item/"+strconv.FormatInt(id, 10)+".json", &it); err != nil || it == nil {
		return nil
	}
	if it.Deleted || it.Dead || it.Title == "" {
		return nil
	}
	s := &Story{
		ID: it.ID, Rank: rank, Title: it.Title, URL: it.URL, By: it.By,
		Score: it.Score, Comments: it.Descendants, PostedAt: time.Unix(it.Time, 0).UTC(),
	}
	if s.URL == "" {
		s.URL = PageURL(it.ID)
	}
	return s
}

// PageURL is the discussion page of an item on news.ycombinator.com.
func PageURL(id int64) string { return itemPageURL + strconv.FormatInt(id, 10) }

func (c *Client) get(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(v)
}
