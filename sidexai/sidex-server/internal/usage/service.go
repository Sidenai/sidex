package usage

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
)

type Service struct {
	db *sql.DB
}

type UsageRecord struct {
	ID               string
	UserID           string
	SessionID        string
	Model            string
	InputTokens      int
	OutputTokens     int
	CacheWriteTokens int
	CacheReadTokens  int
	Cost             float64
	Timestamp        time.Time
	RequestType      string // "agent", "completion", "inline_edit"
}

type UsageSummary struct {
	TotalCost         float64   `json:"total_cost"`
	TotalInputTokens  int       `json:"total_input_tokens"`
	TotalOutputTokens int       `json:"total_output_tokens"`
	RequestCount      int       `json:"request_count"`
	CreditsRemaining  float64   `json:"credits_remaining"`
	PeriodStart       time.Time `json:"period_start"`
	PeriodEnd         time.Time `json:"period_end"`
}

type DailyUsage struct {
	Date         string  `json:"date"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	Cost         float64 `json:"cost"`
	RequestCount int     `json:"request_count"`
}

type ModelUsage struct {
	Model        string  `json:"model"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	Cost         float64 `json:"cost"`
	RequestCount int     `json:"request_count"`
}

func NewService(dbPath string) (*Service, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("usage: failed to open database: %w", err)
	}

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("usage: migration failed: %w", err)
	}

	return &Service{db: db}, nil
}

func migrate(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		workos_id TEXT UNIQUE NOT NULL,
		email TEXT NOT NULL,
		name TEXT,
		plan_tier TEXT NOT NULL DEFAULT 'hobby',
		credits_remaining REAL DEFAULT 0,
		billing_period_start TEXT,
		created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		updated_at TEXT DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS usage_records (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		session_id TEXT,
		model TEXT NOT NULL,
		input_tokens INTEGER DEFAULT 0,
		output_tokens INTEGER DEFAULT 0,
		cache_write_tokens INTEGER DEFAULT 0,
		cache_read_tokens INTEGER DEFAULT 0,
		cost REAL DEFAULT 0,
		request_type TEXT DEFAULT 'agent',
		created_at TEXT DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id)
	);

	CREATE TABLE IF NOT EXISTS usage_daily (
		user_id TEXT NOT NULL,
		date TEXT NOT NULL,
		total_input INTEGER DEFAULT 0,
		total_output INTEGER DEFAULT 0,
		total_cost REAL DEFAULT 0,
		request_count INTEGER DEFAULT 0,
		PRIMARY KEY (user_id, date),
		FOREIGN KEY (user_id) REFERENCES users(id)
	);

	CREATE INDEX IF NOT EXISTS idx_usage_records_user ON usage_records(user_id, created_at);
	CREATE INDEX IF NOT EXISTS idx_usage_daily_user ON usage_daily(user_id, date);
	`
	for _, stmt := range splitSQL(schema) {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	return migrateUsersAccountColumn(db)
}

func splitSQL(schema string) []string {
	parts := strings.Split(schema, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func tableHasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if strings.EqualFold(name, column) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// migrateUsersAccountColumn upgrades databases created when the column was
// still called auth0_id. CREATE TABLE IF NOT EXISTS will not rename it, and
// every RecordLocalTurn then fails with "no such column: workos_id" — which
// is why Settings → Usage stayed at zero on existing installs.
func migrateUsersAccountColumn(db *sql.DB) error {
	hasWorkos, err := tableHasColumn(db, "users", "workos_id")
	if err != nil {
		return err
	}
	if hasWorkos {
		return nil
	}
	hasAuth0, err := tableHasColumn(db, "users", "auth0_id")
	if err != nil {
		return err
	}
	if hasAuth0 {
		if _, err = db.Exec(`ALTER TABLE users RENAME COLUMN auth0_id TO workos_id`); err != nil {
			return err
		}
	} else if _, err = db.Exec(`ALTER TABLE users ADD COLUMN workos_id TEXT`); err != nil {
		return err
	}
	return ensureColumn(db, "users", "billing_period_start", "TEXT")
}

func ensureColumn(db *sql.DB, table, column, decl string) error {
	has, err := tableHasColumn(db, table, column)
	if err != nil || has {
		return err
	}
	_, err = db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + decl)
	return err
}

func (s *Service) Close() error {
	return s.db.Close()
}

// DB exposes the underlying database connection for use by other packages
// that need to store data in the same SQLite database (e.g., API keys).
func (s *Service) DB() *sql.DB {
	return s.db
}

// EnsureUser creates a user record if one doesn't exist for the given account
// id. The underlying column is still named workos_id: it predates the removal
// of accounts and renaming it would break existing local databases.
// Returns the internal user ID.
func (s *Service) EnsureUser(accountID, email, planTier string) (string, error) {
	var id string
	err := s.db.QueryRow("SELECT id FROM users WHERE workos_id = ?", accountID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}

	id = uuid.New().String()
	now := time.Now().UTC().Format(time.RFC3339)
	periodStart := billingPeriodStart(time.Now()).Format(time.RFC3339)

	_, err = s.db.Exec(
		`INSERT INTO users (id, workos_id, email, plan_tier, billing_period_start, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, accountID, email, planTier, periodStart, now, now,
	)
	if err != nil {
		return "", fmt.Errorf("usage: failed to create user: %w", err)
	}
	return id, nil
}

// Record persists a usage record and updates the daily aggregate.
func (s *Service) Record(record UsageRecord) error {
	if record.ID == "" {
		record.ID = uuid.New().String()
	}
	if record.Timestamp.IsZero() {
		record.Timestamp = time.Now().UTC()
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO usage_records (id, user_id, session_id, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost, request_type, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.ID, record.UserID, record.SessionID, record.Model,
		record.InputTokens, record.OutputTokens, record.CacheWriteTokens, record.CacheReadTokens,
		record.Cost, record.RequestType, record.Timestamp.Format(time.RFC3339),
	)
	if err != nil {
		return fmt.Errorf("usage: failed to insert record: %w", err)
	}

	date := record.Timestamp.Format("2006-01-02")
	_, err = tx.Exec(
		`INSERT INTO usage_daily (user_id, date, total_input, total_output, total_cost, request_count)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(user_id, date) DO UPDATE SET
		   total_input = total_input + excluded.total_input,
		   total_output = total_output + excluded.total_output,
		   total_cost = total_cost + excluded.total_cost,
		   request_count = request_count + 1`,
		record.UserID, date, record.InputTokens, record.OutputTokens, record.Cost,
	)
	if err != nil {
		return fmt.Errorf("usage: failed to update daily aggregate: %w", err)
	}

	return tx.Commit()
}

// ResolveAccount maps an account id (WorkOS id, or "local") to the internal
// users.id that usage_records are keyed by.
func (s *Service) ResolveAccount(accountID string) (string, error) {
	if accountID == "" {
		accountID = "local"
	}
	return s.EnsureUser(accountID, accountID, "hobby")
}

// RecordLocalTurn writes one model turn to the on-device store that Settings →
// Usage reads. Postgres recording is separate and optional.
func (s *Service) RecordLocalTurn(accountID, sessionID, model, requestType string, in, out, cacheWrite, cacheRead int, cost float64) {
	if s == nil {
		return
	}
	uid, err := s.ResolveAccount(accountID)
	if err != nil {
		log.Printf("usage: resolve account: %v", err)
		return
	}
	if requestType == "" {
		requestType = "agent"
	}
	if err := s.Record(UsageRecord{
		UserID:           uid,
		SessionID:        sessionID,
		Model:            model,
		InputTokens:      in,
		OutputTokens:     out,
		CacheWriteTokens: cacheWrite,
		CacheReadTokens:  cacheRead,
		Cost:             cost,
		RequestType:      requestType,
	}); err != nil {
		log.Printf("usage: record turn: %v", err)
	}
}

// GetUserSummary returns the usage summary for a user since the given period start.
func (s *Service) GetUserSummary(userID string, periodStart time.Time) (*UsageSummary, error) {
	startStr := periodStart.Format(time.RFC3339)
	periodEnd := periodStart.AddDate(0, 1, 0)

	var totalCost float64
	var totalInput, totalOutput, requestCount int

	err := s.db.QueryRow(
		`SELECT COALESCE(SUM(cost), 0),
		        COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens), 0),
		        COALESCE(SUM(output_tokens), 0),
		        COUNT(*)
		 FROM usage_records WHERE user_id = ? AND created_at >= ?`,
		userID, startStr,
	).Scan(&totalCost, &totalInput, &totalOutput, &requestCount)
	if err != nil {
		return nil, fmt.Errorf("usage: failed to query summary: %w", err)
	}

	var creditsRemaining float64
	err = s.db.QueryRow("SELECT COALESCE(credits_remaining, 0) FROM users WHERE id = ?", userID).Scan(&creditsRemaining)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}

	return &UsageSummary{
		TotalCost:         totalCost,
		TotalInputTokens:  totalInput,
		TotalOutputTokens: totalOutput,
		RequestCount:      requestCount,
		CreditsRemaining:  creditsRemaining,
		PeriodStart:       periodStart,
		PeriodEnd:         periodEnd,
	}, nil
}

// GetDailyBreakdown returns per-day usage for the last N days.
func (s *Service) GetDailyBreakdown(userID string, days int) ([]DailyUsage, error) {
	cutoff := time.Now().AddDate(0, 0, -days).Format("2006-01-02")
	rows, err := s.db.Query(
		`SELECT date, total_input, total_output, total_cost, request_count
		 FROM usage_daily WHERE user_id = ? AND date >= ? ORDER BY date DESC`,
		userID, cutoff,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []DailyUsage
	for rows.Next() {
		var d DailyUsage
		if err := rows.Scan(&d.Date, &d.InputTokens, &d.OutputTokens, &d.Cost, &d.RequestCount); err != nil {
			return nil, err
		}
		results = append(results, d)
	}
	return results, rows.Err()
}

// GetModelBreakdown returns per-model usage since the given period start.
func (s *Service) GetModelBreakdown(userID string, periodStart time.Time) ([]ModelUsage, error) {
	startStr := periodStart.Format(time.RFC3339)
	rows, err := s.db.Query(
		`SELECT model, COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost), 0), COUNT(*)
		 FROM usage_records WHERE user_id = ? AND created_at >= ?
		 GROUP BY model ORDER BY SUM(cost) DESC`,
		userID, startStr,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []ModelUsage
	for rows.Next() {
		var m ModelUsage
		if err := rows.Scan(&m.Model, &m.InputTokens, &m.OutputTokens, &m.Cost, &m.RequestCount); err != nil {
			return nil, err
		}
		results = append(results, m)
	}
	return results, rows.Err()
}

type ProviderUsage struct {
	Provider     string
	InputTokens  int
	OutputTokens int
	Cost         float64
	RequestCount int
}

// GetProviderBreakdown groups recorded turns by the provider prefix of the
// model id (`anthropic/…` → anthropic). Used so Settings can show Claude vs
// Codex spend instead of one blended total.
func (s *Service) GetProviderBreakdown(userID string, periodStart time.Time) ([]ProviderUsage, error) {
	models, err := s.GetModelBreakdown(userID, periodStart)
	if err != nil {
		return nil, err
	}
	by := make(map[string]*ProviderUsage)
	var order []string
	for _, m := range models {
		id := m.Model
		if i := strings.IndexByte(id, '/'); i > 0 {
			id = id[:i]
		}
		if id == "" {
			id = "other"
		}
		p, ok := by[id]
		if !ok {
			p = &ProviderUsage{Provider: id}
			by[id] = p
			order = append(order, id)
		}
		p.InputTokens += m.InputTokens
		p.OutputTokens += m.OutputTokens
		p.Cost += m.Cost
		p.RequestCount += m.RequestCount
	}
	out := make([]ProviderUsage, 0, len(order))
	for _, id := range order {
		out = append(out, *by[id])
	}
	return out, nil
}

// CheckCredits returns the remaining credits for a user in the current billing period.
func (s *Service) CheckCredits(userID string, planCredits float64, periodStart time.Time) (float64, error) {
	startStr := periodStart.Format(time.RFC3339)

	var totalUsed float64
	err := s.db.QueryRow(
		`SELECT COALESCE(SUM(cost), 0) FROM usage_records WHERE user_id = ? AND created_at >= ?`,
		userID, startStr,
	).Scan(&totalUsed)
	if err != nil {
		return 0, err
	}

	remaining := planCredits - totalUsed
	if remaining < 0 {
		remaining = 0
	}
	return remaining, nil
}

// DeductCredits subtracts an amount from the user's credits_remaining field.
func (s *Service) DeductCredits(userID string, amount float64) error {
	_, err := s.db.Exec(
		`UPDATE users SET credits_remaining = credits_remaining - ?, updated_at = ? WHERE id = ?`,
		amount, time.Now().UTC().Format(time.RFC3339), userID,
	)
	return err
}

// GetRequestCount returns the number of requests for a user since the given time.
func (s *Service) GetRequestCount(userID string, since time.Time) (int, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM usage_records WHERE user_id = ? AND created_at >= ?`,
		userID, since.Format(time.RFC3339),
	).Scan(&count)
	return count, err
}

// GetCreditsUsed returns the total cost (credits consumed) for a user since the given time.
func (s *Service) GetCreditsUsed(userID string, since time.Time) (float64, error) {
	var used float64
	err := s.db.QueryRow(
		`SELECT COALESCE(SUM(cost), 0) FROM usage_records WHERE user_id = ? AND created_at >= ?`,
		userID, since.Format(time.RFC3339),
	).Scan(&used)
	return used, err
}

// billingPeriodStart returns the start of the current billing period (first of current month).
func billingPeriodStart(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// BillingPeriodStart is the exported version for use by other packages.
func BillingPeriodStart() time.Time {
	return billingPeriodStart(time.Now())
}
