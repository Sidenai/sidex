package usage

import (
	"database/sql"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

// RemoteUsageEvent is the payload for each LLM usage event written to Postgres.
type RemoteUsageEvent struct {
	UserID          string  `json:"userId"`
	Model           string  `json:"model"`
	RequestType     string  `json:"requestType"`
	TokensIn        int     `json:"tokensIn"`
	TokensOut       int     `json:"tokensOut"`
	CreditsConsumed float64 `json:"creditsConsumed"`
	DurationMs      int64   `json:"durationMs,omitempty"`
	Source          string  `json:"source"`
}

var (
	pgDB *sql.DB
	pgMu sync.Mutex
)

// InitPostgres sets the Postgres connection used for recording usage events
// and applies idempotent, additive schema migrations the server depends on.
func InitPostgres(db *sql.DB) {
	pgMu.Lock()
	defer pgMu.Unlock()
	pgDB = db

	// Safe additive migration: older databases were created before the
	// extra_credits column existed. Without it, profile reads and credit
	// deduction would fail on every request after deploy.
	if _, err := db.Exec(
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_credits NUMERIC(10, 2) NOT NULL DEFAULT 0`,
	); err != nil {
		log.Printf("usage/postgres: extra_credits migration failed: %v", err)
	}
}

// GetPostgres returns the shared Postgres connection (may be nil).
func GetPostgres() *sql.DB {
	pgMu.Lock()
	defer pgMu.Unlock()
	return pgDB
}

// RecordUsageRemote writes a usage event directly to the Postgres usage_events table.
// It never blocks the caller; errors are logged and discarded.
func RecordUsageRemote(event RemoteUsageEvent) {
	go func() {
		pgMu.Lock()
		db := pgDB
		pgMu.Unlock()

		if db == nil {
			return
		}

		id := uuid.New().String()
		now := time.Now().UTC()

		// Resolve internal user ID from WorkOS ID
		var internalUserID string
		err := db.QueryRow(`SELECT id FROM users WHERE workos_id = $1`, event.UserID).Scan(&internalUserID)
		if err != nil {
			log.Printf("usage/postgres: failed to resolve user_id %s: %v", event.UserID, err)
			return
		}

		// Record the usage event first and independently: billing history
		// must never be lost because a later credit deduction fails (a failed
		// statement aborts a Postgres transaction, so these are kept separate).
		_, err = db.Exec(
			`INSERT INTO usage_events (id, user_id, model, request_type, tokens_in, tokens_out, credits_consumed, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			id, internalUserID, event.Model, event.RequestType,
			event.TokensIn, event.TokensOut, event.CreditsConsumed, now,
		)
		if err != nil {
			log.Printf("usage/postgres: failed to insert event: %v", err)
			return
		}

		if event.CreditsConsumed > 0 {
			_, err = db.Exec(
				`UPDATE users 
				 SET extra_credits = GREATEST(extra_credits - GREATEST($1 - credits_remaining, 0), 0),
				     credits_remaining = GREATEST(credits_remaining - $1, 0),
				     updated_at = NOW()
				 WHERE id = $2`,
				event.CreditsConsumed, internalUserID,
			)
			if err != nil {
				log.Printf("usage/postgres: failed to deduct credits (event still recorded): %v", err)
			}
		}
	}()
}
