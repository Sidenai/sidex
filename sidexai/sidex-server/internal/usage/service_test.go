package usage

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigratesAuth0ColumnSoUsageRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.db")
	db, err := sql.Open("sqlite3", path+"?_multi_statements=true")
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			auth0_id TEXT UNIQUE NOT NULL,
			email TEXT NOT NULL,
			name TEXT,
			plan_tier TEXT NOT NULL DEFAULT 'hobby',
			credits_remaining REAL DEFAULT 0,
			billing_period_start TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE usage_records (
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
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE usage_daily (
			user_id TEXT NOT NULL,
			date TEXT NOT NULL,
			total_input INTEGER DEFAULT 0,
			total_output INTEGER DEFAULT 0,
			total_cost REAL DEFAULT 0,
			request_count INTEGER DEFAULT 0,
			PRIMARY KEY (user_id, date)
		);
	`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}

	svc, err := NewService(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	svc.RecordLocalTurn("local", "s1", "anthropic/claude-sonnet-4.6", "agent", 42, 7, 0, 0, 0.0012)
	uid, err := svc.ResolveAccount("local")
	if err != nil {
		t.Fatal(err)
	}
	sum, err := svc.GetUserSummary(uid, BillingPeriodStart())
	if err != nil {
		t.Fatal(err)
	}
	if sum.TotalInputTokens != 42 || sum.TotalOutputTokens != 7 {
		t.Fatalf("in=%d out=%d", sum.TotalInputTokens, sum.TotalOutputTokens)
	}
}

func TestRecordLocalTurnShowsInSummary(t *testing.T) {
	dir := t.TempDir()
	svc, err := NewService(filepath.Join(dir, "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	svc.RecordLocalTurn("", "sess-1", "anthropic/claude-sonnet-4.6", "agent", 1000, 200, 100, 0, 0.012)
	svc.RecordLocalTurn("local", "sess-1", "anthropic/claude-sonnet-4.6", "agent", 500, 50, 0, 50, 0.004)

	uid, err := svc.ResolveAccount("local")
	if err != nil {
		t.Fatal(err)
	}
	sum, err := svc.GetUserSummary(uid, BillingPeriodStart())
	if err != nil {
		t.Fatal(err)
	}
	// in = uncached + cache write + cache read
	if sum.TotalInputTokens != 1650 || sum.TotalOutputTokens != 250 {
		t.Fatalf("tokens in=%d out=%d", sum.TotalInputTokens, sum.TotalOutputTokens)
	}
	if sum.RequestCount != 2 {
		t.Fatalf("requests = %d", sum.RequestCount)
	}
	if sum.TotalCost < 0.015 || sum.TotalCost > 0.017 {
		t.Fatalf("cost = %v", sum.TotalCost)
	}
}

func TestResolveAccountIsStable(t *testing.T) {
	dir := t.TempDir()
	svc, err := NewService(filepath.Join(dir, "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	a, err := svc.ResolveAccount("local")
	if err != nil {
		t.Fatal(err)
	}
	b, err := svc.ResolveAccount("")
	if err != nil {
		t.Fatal(err)
	}
	if a == "" || a != b {
		t.Fatalf("ids %q vs %q", a, b)
	}
}

func TestGetProviderBreakdownGroupsByPrefix(t *testing.T) {
	dir := t.TempDir()
	svc, err := NewService(filepath.Join(dir, "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	svc.RecordLocalTurn("local", "s", "anthropic/claude-sonnet-4.6", "agent", 100, 10, 0, 0, 0.01)
	svc.RecordLocalTurn("local", "s", "openai/gpt-5.4-mini", "agent", 50, 5, 0, 0, 0.002)
	svc.RecordLocalTurn("local", "s", "anthropic/claude-opus-4.6", "agent", 20, 2, 0, 0, 0.02)

	uid, err := svc.ResolveAccount("local")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := svc.GetProviderBreakdown(uid, BillingPeriodStart())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %#v", rows)
	}
	by := map[string]ProviderUsage{}
	for _, r := range rows {
		by[r.Provider] = r
	}
	if by["anthropic"].InputTokens != 120 || by["openai"].InputTokens != 50 {
		t.Fatalf("by provider %#v", by)
	}
}
