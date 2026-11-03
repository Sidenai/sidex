package feedback

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const maxSignals = 1000

// Store persists feedback signals in SQLite with FIFO retention.
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// OpenStore opens or creates the feedback SQLite database at the given path.
func OpenStore(dbPath string) (*Store, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("feedback: create dir: %w", err)
	}

	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL")
	if err != nil {
		return nil, fmt.Errorf("feedback: open sqlite: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("feedback: ping: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("feedback: migrate: %w", err)
	}
	return s, nil
}

func (s *Store) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS feedback_signals (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		turn_number INTEGER NOT NULL,
		type TEXT NOT NULL,
		tool_name TEXT NOT NULL DEFAULT '',
		task_context TEXT NOT NULL DEFAULT '',
		outcome TEXT NOT NULL,
		timestamp INTEGER NOT NULL,
		metadata TEXT NOT NULL DEFAULT '{}'
	);

	CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_signals(session_id);
	CREATE INDEX IF NOT EXISTS idx_feedback_tool ON feedback_signals(tool_name);
	CREATE INDEX IF NOT EXISTS idx_feedback_outcome ON feedback_signals(outcome);
	CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback_signals(timestamp DESC);
	CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback_signals(type);
	`
	_, err := s.db.Exec(schema)
	return err
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// Insert persists a single signal.
func (s *Store) Insert(sig Signal) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	metaJSON := "{}"
	if sig.Metadata != nil {
		if b, err := marshalJSON(sig.Metadata); err == nil {
			metaJSON = string(b)
		}
	}

	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO feedback_signals
			(id, session_id, turn_number, type, tool_name, task_context, outcome, timestamp, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, sig.ID, sig.SessionID, sig.TurnNumber, string(sig.Type),
		sig.ToolName, sig.TaskContext, string(sig.Outcome),
		sig.Timestamp.Unix(), metaJSON)
	if err != nil {
		return err
	}

	return s.enforceRetention()
}

// BatchInsert persists multiple signals in a single transaction.
func (s *Store) BatchInsert(signals []Signal) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO feedback_signals
			(id, session_id, turn_number, type, tool_name, task_context, outcome, timestamp, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, sig := range signals {
		metaJSON := "{}"
		if sig.Metadata != nil {
			if b, err := marshalJSON(sig.Metadata); err == nil {
				metaJSON = string(b)
			}
		}
		_, err = stmt.Exec(sig.ID, sig.SessionID, sig.TurnNumber, string(sig.Type),
			sig.ToolName, sig.TaskContext, string(sig.Outcome),
			sig.Timestamp.Unix(), metaJSON)
		if err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	return s.enforceRetentionUnlocked()
}

// enforceRetention keeps only the most recent maxSignals rows.
func (s *Store) enforceRetention() error {
	return s.enforceRetentionUnlocked()
}

func (s *Store) enforceRetentionUnlocked() error {
	_, err := s.db.Exec(`
		DELETE FROM feedback_signals WHERE id IN (
			SELECT id FROM feedback_signals
			ORDER BY timestamp DESC
			LIMIT -1 OFFSET ?
		)
	`, maxSignals)
	return err
}

// ToolSuccessRates returns the success rate (0.0-1.0) per tool.
func (s *Store) ToolSuccessRates() (map[string]float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(`
		SELECT tool_name,
			SUM(CASE WHEN outcome = 'positive' THEN 1 ELSE 0 END) as successes,
			COUNT(*) as total
		FROM feedback_signals
		WHERE tool_name != '' AND type IN ('tool_success', 'tool_failure')
		GROUP BY tool_name
		HAVING total >= 3
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rates := make(map[string]float64)
	for rows.Next() {
		var tool string
		var successes, total int
		if err := rows.Scan(&tool, &successes, &total); err != nil {
			continue
		}
		if total > 0 {
			rates[tool] = float64(successes) / float64(total)
		}
	}
	return rates, rows.Err()
}

// RecentSignals returns the most recent n signals.
func (s *Store) RecentSignals(limit int) ([]Signal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if limit <= 0 {
		limit = 50
	}

	rows, err := s.db.Query(`
		SELECT id, session_id, turn_number, type, tool_name, task_context, outcome, timestamp, metadata
		FROM feedback_signals
		ORDER BY timestamp DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSignals(rows)
}

// SignalsByTool returns signals for a specific tool.
func (s *Store) SignalsByTool(toolName string, limit int) ([]Signal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if limit <= 0 {
		limit = 50
	}

	rows, err := s.db.Query(`
		SELECT id, session_id, turn_number, type, tool_name, task_context, outcome, timestamp, metadata
		FROM feedback_signals
		WHERE tool_name = ?
		ORDER BY timestamp DESC
		LIMIT ?
	`, toolName, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSignals(rows)
}

// FailuresByContext returns failure signals matching a keyword in task_context.
func (s *Store) FailuresByContext(keyword string, limit int) ([]Signal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if limit <= 0 {
		limit = 20
	}

	rows, err := s.db.Query(`
		SELECT id, session_id, turn_number, type, tool_name, task_context, outcome, timestamp, metadata
		FROM feedback_signals
		WHERE outcome = 'negative' AND task_context LIKE '%' || ? || '%'
		ORDER BY timestamp DESC
		LIMIT ?
	`, keyword, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSignals(rows)
}

// SessionOutcome returns aggregate stats for a session.
func (s *Store) SessionOutcome(sessionID string) (*SessionStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var stats SessionStats
	stats.SessionID = sessionID

	row := s.db.QueryRow(`
		SELECT
			COUNT(*) as total,
			SUM(CASE WHEN outcome = 'positive' THEN 1 ELSE 0 END) as positive,
			SUM(CASE WHEN outcome = 'negative' THEN 1 ELSE 0 END) as negative
		FROM feedback_signals
		WHERE session_id = ?
	`, sessionID)

	if err := row.Scan(&stats.TotalSignals, &stats.Positive, &stats.Negative); err != nil {
		return nil, err
	}
	if stats.TotalSignals > 0 {
		stats.SuccessRate = float64(stats.Positive) / float64(stats.TotalSignals)
	}
	return &stats, nil
}

// Count returns the total number of stored signals.
func (s *Store) Count() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM feedback_signals`).Scan(&count)
	return count, err
}

// SessionStats holds aggregate feedback for a session.
type SessionStats struct {
	SessionID    string  `json:"session_id"`
	TotalSignals int     `json:"total_signals"`
	Positive     int     `json:"positive"`
	Negative     int     `json:"negative"`
	SuccessRate  float64 `json:"success_rate"`
}

func scanSignals(rows *sql.Rows) ([]Signal, error) {
	var signals []Signal
	for rows.Next() {
		var sig Signal
		var ts int64
		var sigType, outcome, metaJSON string

		err := rows.Scan(&sig.ID, &sig.SessionID, &sig.TurnNumber,
			&sigType, &sig.ToolName, &sig.TaskContext, &outcome, &ts, &metaJSON)
		if err != nil {
			continue
		}
		sig.Type = SignalType(sigType)
		sig.Outcome = Outcome(outcome)
		sig.Timestamp = time.Unix(ts, 0)
		if metaJSON != "" && metaJSON != "{}" {
			sig.Metadata = make(map[string]any)
			unmarshalJSON([]byte(metaJSON), &sig.Metadata)
		}
		signals = append(signals, sig)
	}
	return signals, rows.Err()
}
