package feedback

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

type SignalType string

const (
	SignalToolSuccess   SignalType = "tool_success"
	SignalToolFailure   SignalType = "tool_failure"
	SignalEditAccepted  SignalType = "edit_accepted"
	SignalEditReverted  SignalType = "edit_reverted"
	SignalTaskComplete  SignalType = "task_complete"
	SignalTaskAbandoned SignalType = "task_abandoned"
	SignalFollowUp      SignalType = "follow_up"
)

type Outcome string

const (
	OutcomePositive Outcome = "positive"
	OutcomeNegative Outcome = "negative"
	OutcomeNeutral  Outcome = "neutral"
)

// Signal represents a single feedback event from user behavior or tool outcomes.
type Signal struct {
	ID          string         `json:"id"`
	SessionID   string         `json:"session_id"`
	TurnNumber  int            `json:"turn_number"`
	Type        SignalType     `json:"type"`
	ToolName    string         `json:"tool_name"`
	TaskContext string         `json:"task_context"`
	Outcome     Outcome        `json:"outcome"`
	Timestamp   time.Time      `json:"timestamp"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

// Tracker collects feedback signals during a session and flushes to persistent storage.
type Tracker struct {
	mu            sync.Mutex
	sessionID     string
	store         *Store
	pending       []Signal
	turnCount     int
	followUpCount int
	toolCounts    map[string]*toolStats
}

type toolStats struct {
	successes int
	failures  int
}

func NewTracker(sessionID string, store *Store) *Tracker {
	return &Tracker{
		sessionID:  sessionID,
		store:      store,
		toolCounts: make(map[string]*toolStats),
	}
}

// RecordToolOutcome records whether a tool call succeeded or failed.
func (t *Tracker) RecordToolOutcome(toolName, taskContext string, turnNumber int, errStr string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	var sigType SignalType
	var outcome Outcome
	if errStr == "" {
		sigType = SignalToolSuccess
		outcome = OutcomePositive
	} else {
		sigType = SignalToolFailure
		outcome = OutcomeNegative
	}

	if _, ok := t.toolCounts[toolName]; !ok {
		t.toolCounts[toolName] = &toolStats{}
	}
	if outcome == OutcomePositive {
		t.toolCounts[toolName].successes++
	} else {
		t.toolCounts[toolName].failures++
	}

	meta := map[string]any{}
	if errStr != "" {
		meta["error"] = truncate(errStr, 500)
	}

	sig := Signal{
		ID:          uuid.New().String(),
		SessionID:   t.sessionID,
		TurnNumber:  turnNumber,
		Type:        sigType,
		ToolName:    toolName,
		TaskContext: truncate(taskContext, 200),
		Outcome:     outcome,
		Timestamp:   time.Now(),
		Metadata:    meta,
	}
	t.pending = append(t.pending, sig)
	t.turnCount = turnNumber
}

// RecordEditFeedback records user accept/revert of an edit.
func (t *Tracker) RecordEditFeedback(toolName string, turnNumber int, accepted bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	var sigType SignalType
	var outcome Outcome
	if accepted {
		sigType = SignalEditAccepted
		outcome = OutcomePositive
	} else {
		sigType = SignalEditReverted
		outcome = OutcomeNegative
	}

	sig := Signal{
		ID:         uuid.New().String(),
		SessionID:  t.sessionID,
		TurnNumber: turnNumber,
		Type:       sigType,
		ToolName:   toolName,
		Outcome:    outcome,
		Timestamp:  time.Now(),
	}
	t.pending = append(t.pending, sig)
}

// RecordFollowUp records that the user sent a follow-up message,
// which may indicate the agent's previous response was insufficient.
func (t *Tracker) RecordFollowUp(turnNumber int) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.followUpCount++
	if t.followUpCount >= 3 {
		sig := Signal{
			ID:         uuid.New().String(),
			SessionID:  t.sessionID,
			TurnNumber: turnNumber,
			Type:       SignalFollowUp,
			Outcome:    OutcomeNegative,
			Timestamp:  time.Now(),
			Metadata:   map[string]any{"follow_up_count": t.followUpCount},
		}
		t.pending = append(t.pending, sig)
	}
}

// RecordSessionEnd records a task_complete or task_abandoned signal
// based on the session's follow-up pattern.
func (t *Tracker) RecordSessionEnd() {
	t.mu.Lock()
	defer t.mu.Unlock()

	var sigType SignalType
	var outcome Outcome
	if t.followUpCount <= 1 {
		sigType = SignalTaskComplete
		outcome = OutcomePositive
	} else {
		sigType = SignalTaskAbandoned
		outcome = OutcomeNegative
	}

	sig := Signal{
		ID:         uuid.New().String(),
		SessionID:  t.sessionID,
		TurnNumber: t.turnCount,
		Type:       sigType,
		Outcome:    outcome,
		Timestamp:  time.Now(),
		Metadata: map[string]any{
			"total_turns": t.turnCount,
			"follow_ups":  t.followUpCount,
			"tool_stats":  t.toolStatsSnapshot(),
		},
	}
	t.pending = append(t.pending, sig)
}

// Flush persists all pending signals to the store.
func (t *Tracker) Flush() error {
	t.mu.Lock()
	signals := make([]Signal, len(t.pending))
	copy(signals, t.pending)
	t.pending = t.pending[:0]
	t.mu.Unlock()

	if len(signals) == 0 {
		return nil
	}
	return t.store.BatchInsert(signals)
}

func (t *Tracker) toolStatsSnapshot() map[string]any {
	stats := make(map[string]any, len(t.toolCounts))
	for tool, s := range t.toolCounts {
		stats[tool] = map[string]int{
			"successes": s.successes,
			"failures":  s.failures,
		}
	}
	return stats
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
