package index

import (
	"math"
	"sync"
	"time"
)

// RecencyTracker monitors file edit/read activity to provide recency-based
// score boosting during retrieval. Recently edited or read files are far more
// likely to be relevant to the current task (the same signal Cursor uses).
//
// Signals are recorded automatically:
//   - edits: every file in a workspace sync's changed set (the user just
//     modified it in the IDE)
//   - reads: every file the agent reads via read_file in that workspace
type RecencyTracker struct {
	mu    sync.RWMutex
	edits map[string]time.Time // "namespace\x00path" → last edit time
	reads map[string]time.Time // "namespace\x00path" → last read time
}

// NewRecencyTracker creates a tracker with empty state.
func NewRecencyTracker() *RecencyTracker {
	return &RecencyTracker{
		edits: make(map[string]time.Time),
		reads: make(map[string]time.Time),
	}
}

const recencyMaxEntries = 8192

func recencyKey(namespace, path string) string {
	return namespace + "\x00" + path
}

// RecordEdit marks a file as recently edited.
func (r *RecencyTracker) RecordEdit(namespace, path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictIfFullLocked(r.edits)
	r.edits[recencyKey(namespace, path)] = time.Now()
}

// RecordRead marks a file as recently read by the agent.
func (r *RecencyTracker) RecordRead(namespace, path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evictIfFullLocked(r.reads)
	r.reads[recencyKey(namespace, path)] = time.Now()
}

// evictIfFullLocked drops the oldest half of a map when it grows past the
// cap. Caller must hold the write lock.
func (r *RecencyTracker) evictIfFullLocked(m map[string]time.Time) {
	if len(m) < recencyMaxEntries {
		return
	}
	// Find the median age and drop everything older. O(n) but rare.
	cutoff := time.Now().Add(-6 * time.Hour)
	for k, t := range m {
		if t.Before(cutoff) {
			delete(m, k)
		}
	}
	// Degenerate case: everything is recent — drop arbitrary entries.
	for k := range m {
		if len(m) < recencyMaxEntries/2 {
			break
		}
		delete(m, k)
	}
}

// Score computes a composite recency multiplier for a file path.
// Returns a value in [0.85, 1.5]:
//   - ~1.5  = edited within the last minute (maximum boost)
//   - ~1.25 = read by the agent within the last few minutes
//   - 1.0  = no recency information (neutral — unknown files are NOT
//     penalized; most of a repo is legitimately cold)
//   - 0.85 = known activity but very stale (>48h) — mild demotion only
func (r *RecencyTracker) Score(namespace, path string) float64 {
	r.mu.RLock()
	defer r.mu.RUnlock()

	key := recencyKey(namespace, path)
	now := time.Now()

	boost := 1.0
	hasSignal := false

	if t, ok := r.edits[key]; ok {
		hasSignal = true
		// Half-life of 30 minutes: 1.5 at t=0 → 1.25 at 30m → ~1.0 at 2h.
		age := now.Sub(t).Minutes()
		boost = math.Max(boost, 1.0+0.5*math.Exp(-age/43.3))
	}
	if t, ok := r.reads[key]; ok {
		hasSignal = true
		// Half-life of 15 minutes, weaker ceiling: 1.25 at t=0.
		age := now.Sub(t).Minutes()
		boost = math.Max(boost, 1.0+0.25*math.Exp(-age/21.6))
	}

	if !hasSignal {
		return 1.0
	}
	// Stale known files get a mild demotion floor rather than a cliff.
	return math.Max(boost, 0.85)
}

// ApplyRecency multiplies each result's score by its file's recency factor
// and re-sorts. Called after reranking so fresh edits can win ties against
// semantically similar but stale code.
func (r *RecencyTracker) ApplyRecency(namespace string, results []SearchResult) {
	for i := range results {
		results[i].Score *= r.Score(namespace, results[i].File)
	}
	// Stable re-sort by adjusted score.
	for i := 1; i < len(results); i++ {
		for j := i; j > 0 && results[j].Score > results[j-1].Score; j-- {
			results[j], results[j-1] = results[j-1], results[j]
		}
	}
}
