package index

import (
	"testing"
	"time"
)

func TestRecencyNeutralForUnknownFiles(t *testing.T) {
	rt := NewRecencyTracker()
	if got := rt.Score("ns", "never/seen.go"); got != 1.0 {
		t.Errorf("unknown file should score exactly 1.0 (no penalty), got %v", got)
	}
}

func TestRecencyBoostsFreshEdits(t *testing.T) {
	rt := NewRecencyTracker()
	rt.RecordEdit("ns", "hot.go")

	hot := rt.Score("ns", "hot.go")
	if hot <= 1.4 || hot > 1.5 {
		t.Errorf("just-edited file should score ~1.5, got %v", hot)
	}

	// Reads boost less than edits.
	rt.RecordRead("ns", "warm.go")
	warm := rt.Score("ns", "warm.go")
	if warm <= 1.2 || warm >= hot {
		t.Errorf("just-read file should score ~1.25 (less than edited), got %v (edit=%v)", warm, hot)
	}
}

func TestRecencyIsNamespaceScoped(t *testing.T) {
	rt := NewRecencyTracker()
	rt.RecordEdit("ns-a", "file.go")
	if got := rt.Score("ns-b", "file.go"); got != 1.0 {
		t.Errorf("recency must not leak across namespaces, got %v", got)
	}
}

func TestApplyRecencyReorders(t *testing.T) {
	rt := NewRecencyTracker()
	rt.RecordEdit("ns", "fresh.go")

	results := []SearchResult{
		{File: "stale.go", Score: 0.70},
		{File: "fresh.go", Score: 0.65},
	}
	rt.ApplyRecency("ns", results)

	if results[0].File != "fresh.go" {
		t.Errorf("freshly edited file should overtake a slightly higher stale score: got order %s, %s (scores %v, %v)",
			results[0].File, results[1].File, results[0].Score, results[1].Score)
	}
}

func TestRecencyEvictionKeepsFreshEntries(t *testing.T) {
	rt := NewRecencyTracker()
	// Force the map past the cap with stale entries.
	old := time.Now().Add(-24 * time.Hour)
	rt.mu.Lock()
	for i := 0; i < recencyMaxEntries; i++ {
		rt.edits[recencyKey("ns", "old"+string(rune('a'+i%26)))+string(rune(i))] = old
	}
	rt.mu.Unlock()

	rt.RecordEdit("ns", "new.go")
	if got := rt.Score("ns", "new.go"); got <= 1.4 {
		t.Errorf("fresh entry should survive eviction with full boost, got %v", got)
	}
	rt.mu.RLock()
	size := len(rt.edits)
	rt.mu.RUnlock()
	if size > recencyMaxEntries {
		t.Errorf("eviction failed to bound the map: %d entries", size)
	}
}
