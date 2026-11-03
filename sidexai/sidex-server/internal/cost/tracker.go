package cost

import (
	"fmt"
	"sync"
	"time"
)

type Usage struct {
	InputTokens      int
	OutputTokens     int
	CacheWriteTokens int
	CacheReadTokens  int
}

type ModelUsage struct {
	Model string
	Usage Usage
	Cost  float64
}

type Tracker struct {
	mu        sync.Mutex
	model     string
	startTime time.Time
	total     Usage
	perModel  map[string]*Usage
	totalCost float64
	raceCost  float64
	raceCount int
}

func NewTracker(model string) *Tracker {
	return &Tracker{
		model:     model,
		startTime: time.Now(),
		perModel:  make(map[string]*Usage),
	}
}

func (t *Tracker) Add(model string, input, output, cacheWrite, cacheRead int) float64 {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.total.InputTokens += input
	t.total.OutputTokens += output
	t.total.CacheWriteTokens += cacheWrite
	t.total.CacheReadTokens += cacheRead

	if _, ok := t.perModel[model]; !ok {
		t.perModel[model] = &Usage{}
	}
	t.perModel[model].InputTokens += input
	t.perModel[model].OutputTokens += output
	t.perModel[model].CacheWriteTokens += cacheWrite
	t.perModel[model].CacheReadTokens += cacheRead

	turnCost := TurnCost(model, input, output, cacheWrite, cacheRead)
	t.totalCost += turnCost
	return turnCost
}

func (t *Tracker) TotalCost() float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.totalCost
}

func (t *Tracker) TotalUsage() Usage {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.total
}

// RecordRace tracks that a race occurred and how much it cost in total
// (including tokens spent on losing models).
func (t *Tracker) RecordRace(raceTotalCost float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.raceCost += raceTotalCost
	t.raceCount++
}

// RaceCost returns the total cost attributable to racing (all racers, not just winners).
func (t *Tracker) RaceCost() float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.raceCost
}

func (t *Tracker) Summary() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	elapsed := time.Since(t.startTime)
	summary := fmt.Sprintf(
		"Cost: $%.4f | Tokens: %d in / %d out | Duration: %s",
		t.totalCost, t.total.InputTokens, t.total.OutputTokens,
		elapsed.Round(time.Second),
	)
	if t.raceCount > 0 {
		summary += fmt.Sprintf(" | Races: %d ($%.4f)", t.raceCount, t.raceCost)
	}
	return summary
}

// ToJSON returns a map suitable for sending in a WebSocket frame.
func (t *Tracker) ToJSON() map[string]interface{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	result := map[string]interface{}{
		"total_cost":         t.totalCost,
		"input_tokens":       t.total.InputTokens,
		"output_tokens":      t.total.OutputTokens,
		"cache_write_tokens": t.total.CacheWriteTokens,
		"cache_read_tokens":  t.total.CacheReadTokens,
		"elapsed_ms":         time.Since(t.startTime).Milliseconds(),
	}
	if t.raceCount > 0 {
		result["race_cost"] = t.raceCost
		result["race_count"] = t.raceCount
	}
	return result
}
