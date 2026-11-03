package apply

import (
	"sync"
	"time"
)

// Metrics tracks fast-apply performance over a session.
type Metrics struct {
	mu      sync.Mutex
	entries []metricEntry
}

type metricEntry struct {
	Method    string
	Success   bool
	Duration  time.Duration
	Timestamp time.Time
}

// MetricsSnapshot is a point-in-time view of fast-apply statistics.
type MetricsSnapshot struct {
	TotalAttempts   int            `json:"total_attempts"`
	SuccessCount    int            `json:"success_count"`
	FailureCount    int            `json:"failure_count"`
	SuccessRate     float64        `json:"success_rate"`
	AvgDuration     time.Duration  `json:"avg_duration_ns"`
	MethodBreakdown map[string]int `json:"method_breakdown"`
	TimeSaved       time.Duration  `json:"time_saved_ns"`
}

// NewMetrics creates a fresh metrics tracker.
func NewMetrics() *Metrics {
	return &Metrics{}
}

// Record logs a single fast-apply attempt.
func (m *Metrics) Record(method string, success bool, duration time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = append(m.entries, metricEntry{
		Method:    method,
		Success:   success,
		Duration:  duration,
		Timestamp: time.Now(),
	})
}

// Snapshot computes aggregate statistics.
func (m *Metrics) Snapshot() MetricsSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()

	snap := MetricsSnapshot{
		MethodBreakdown: make(map[string]int),
	}

	if len(m.entries) == 0 {
		return snap
	}

	var totalDuration time.Duration
	for _, e := range m.entries {
		snap.TotalAttempts++
		if e.Success {
			snap.SuccessCount++
			snap.MethodBreakdown[e.Method]++
			totalDuration += e.Duration

			// Estimate time saved: assume the reasoning model would take ~3s
			// to produce exact diffs, vs fast-apply actual time.
			const reasoningModelBaseline = 3 * time.Second
			if e.Duration < reasoningModelBaseline {
				snap.TimeSaved += reasoningModelBaseline - e.Duration
			}
		} else {
			snap.FailureCount++
		}
	}

	if snap.TotalAttempts > 0 {
		snap.SuccessRate = float64(snap.SuccessCount) / float64(snap.TotalAttempts)
	}
	if snap.SuccessCount > 0 {
		snap.AvgDuration = totalDuration / time.Duration(snap.SuccessCount)
	}

	return snap
}

// Reset clears all recorded metrics.
func (m *Metrics) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries = nil
}
