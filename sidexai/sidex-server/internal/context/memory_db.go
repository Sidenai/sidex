package context

import (
	"database/sql"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// MemoryDB is the SQLite-backed memory store with FTS5 full-text search.
// It uses WAL mode for concurrent reads during streaming and FTS5 for
// production-grade BM25 retrieval.
type MemoryDB struct {
	db *sql.DB
	mu sync.RWMutex
}

// Memory represents a single memory record.
type Memory struct {
	ID          string     `json:"id"`
	Key         string     `json:"key"`
	Value       string     `json:"value"`
	Category    string     `json:"category"`   // user, project, feedback, reference
	Tier        string     `json:"tier"`       // permanent, stable, active, session, checkpoint
	Importance  float64    `json:"importance"` // 0.0–10.0 scoring
	CreatedAt   time.Time  `json:"created_at"`
	AccessedAt  time.Time  `json:"accessed_at"`
	AccessCount int        `json:"access_count"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	Embedding   []float32  `json:"embedding,omitempty"` // optional 1024-dim vector
}

// OpenMemoryDB opens or creates a SQLite database at the given path.
// WAL mode is enabled for concurrent read access.
func OpenMemoryDB(dbPath string) (*MemoryDB, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	mdb := &MemoryDB{db: db}
	if err := mdb.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return mdb, nil
}

func (m *MemoryDB) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS memories (
		id TEXT PRIMARY KEY,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		category TEXT NOT NULL DEFAULT 'project',
		tier TEXT NOT NULL DEFAULT 'active',
		importance REAL NOT NULL DEFAULT 1.0,
		created_at INTEGER NOT NULL,
		accessed_at INTEGER NOT NULL,
		access_count INTEGER NOT NULL DEFAULT 0,
		expires_at INTEGER,
		embedding BLOB
	);

	CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
	CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
	CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
	CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC);
	`

	if _, err := m.db.Exec(schema); err != nil {
		return fmt.Errorf("create tables: %w", err)
	}

	// FTS5 virtual table for full-text search with BM25 ranking
	fts := `
	CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
		key,
		value,
		category,
		content=memories,
		content_rowid=rowid,
		tokenize='porter unicode61'
	);
	`
	if _, err := m.db.Exec(fts); err != nil {
		return fmt.Errorf("create fts: %w", err)
	}

	// Triggers to keep FTS in sync with the main table
	triggers := `
	CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
		INSERT INTO memories_fts(rowid, key, value, category)
		VALUES (new.rowid, new.key, new.value, new.category);
	END;

	CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
		INSERT INTO memories_fts(memories_fts, rowid, key, value, category)
		VALUES ('delete', old.rowid, old.key, old.value, old.category);
	END;

	CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
		INSERT INTO memories_fts(memories_fts, rowid, key, value, category)
		VALUES ('delete', old.rowid, old.key, old.value, old.category);
		INSERT INTO memories_fts(rowid, key, value, category)
		VALUES (new.rowid, new.key, new.value, new.category);
	END;
	`
	if _, err := m.db.Exec(triggers); err != nil {
		return fmt.Errorf("create triggers: %w", err)
	}

	return nil
}

// Close closes the database connection.
func (m *MemoryDB) Close() error {
	return m.db.Close()
}

// Store inserts or updates a memory entry.
func (m *MemoryDB) Store(mem Memory) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().Unix()
	if mem.CreatedAt.IsZero() {
		mem.CreatedAt = time.Now()
	}
	if mem.AccessedAt.IsZero() {
		mem.AccessedAt = time.Now()
	}
	if mem.Category == "" {
		mem.Category = "project"
	}
	if mem.Tier == "" {
		mem.Tier = "active"
	}
	if mem.Importance == 0 {
		mem.Importance = 1.0
	}

	var expiresAt *int64
	if mem.ExpiresAt != nil {
		t := mem.ExpiresAt.Unix()
		expiresAt = &t
	}

	var embeddingBlob []byte
	if len(mem.Embedding) > 0 {
		embeddingBlob = encodeEmbedding(mem.Embedding)
	}

	_, err := m.db.Exec(`
		INSERT INTO memories (id, key, value, category, tier, importance, created_at, accessed_at, access_count, expires_at, embedding)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			key = excluded.key,
			value = excluded.value,
			category = excluded.category,
			tier = excluded.tier,
			importance = excluded.importance,
			accessed_at = excluded.accessed_at,
			access_count = access_count + 1,
			expires_at = excluded.expires_at,
			embedding = excluded.embedding
	`, mem.ID, mem.Key, mem.Value, mem.Category, mem.Tier, mem.Importance,
		mem.CreatedAt.Unix(), now, mem.AccessCount, expiresAt, embeddingBlob)
	return err
}

// Search performs BM25 full-text search via FTS5.
func (m *MemoryDB) Search(query string, limit int) ([]Memory, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if limit <= 0 {
		limit = 20
	}

	query = sanitizeFTSQuery(query)
	if query == "" {
		return nil, nil
	}

	rows, err := m.db.Query(`
		SELECT m.id, m.key, m.value, m.category, m.tier, m.importance,
		       m.created_at, m.accessed_at, m.access_count, m.expires_at, m.embedding
		FROM memories m
		JOIN memories_fts f ON m.rowid = f.rowid
		WHERE memories_fts MATCH ?
		ORDER BY rank
		LIMIT ?
	`, query, limit)
	if err != nil {
		return nil, fmt.Errorf("fts search: %w", err)
	}
	defer rows.Close()

	return scanMemories(rows)
}

// SemanticSearch performs cosine similarity search against stored embeddings.
// Returns empty if no embeddings are stored.
func (m *MemoryDB) SemanticSearch(queryEmbedding []float32, limit int) ([]Memory, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if limit <= 0 {
		limit = 20
	}

	rows, err := m.db.Query(`
		SELECT id, key, value, category, tier, importance,
		       created_at, accessed_at, access_count, expires_at, embedding
		FROM memories
		WHERE embedding IS NOT NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("semantic search: %w", err)
	}
	defer rows.Close()

	type scored struct {
		mem   Memory
		score float64
	}
	var results []scored

	for rows.Next() {
		mem, err := scanSingleMemory(rows)
		if err != nil {
			continue
		}
		if len(mem.Embedding) == 0 {
			continue
		}
		sim := cosineSimilarity(queryEmbedding, mem.Embedding)
		results = append(results, scored{mem: mem, score: sim})
	}

	// Sort by similarity descending
	for i := 1; i < len(results); i++ {
		key := results[i]
		j := i - 1
		for j >= 0 && results[j].score < key.score {
			results[j+1] = results[j]
			j--
		}
		results[j+1] = key
	}

	if len(results) > limit {
		results = results[:limit]
	}

	mems := make([]Memory, len(results))
	for i, r := range results {
		mems[i] = r.mem
	}
	return mems, nil
}

// HybridSearch combines BM25 and semantic search using Reciprocal Rank Fusion.
func (m *MemoryDB) HybridSearch(query string, embedding []float32, limit int) ([]Memory, error) {
	bm25Results, err := m.Search(query, 50)
	if err != nil {
		return nil, err
	}

	var vecResults []Memory
	if len(embedding) > 0 {
		vecResults, err = m.SemanticSearch(embedding, 50)
		if err != nil {
			return nil, err
		}
	}

	const k = 60.0
	scores := make(map[string]float64)
	memMap := make(map[string]Memory)

	for rank, mem := range bm25Results {
		scores[mem.ID] += 1.0 / (k + float64(rank))
		memMap[mem.ID] = mem
	}
	for rank, mem := range vecResults {
		scores[mem.ID] += 1.0 / (k + float64(rank))
		memMap[mem.ID] = mem
	}

	type scoredID struct {
		id    string
		score float64
	}
	var sortable []scoredID
	for id, score := range scores {
		sortable = append(sortable, scoredID{id: id, score: score})
	}

	for i := 1; i < len(sortable); i++ {
		key := sortable[i]
		j := i - 1
		for j >= 0 && sortable[j].score < key.score {
			sortable[j+1] = sortable[j]
			j--
		}
		sortable[j+1] = key
	}

	if len(sortable) > limit {
		sortable = sortable[:limit]
	}

	mems := make([]Memory, len(sortable))
	for i, s := range sortable {
		mems[i] = memMap[s.id]
	}
	return mems, nil
}

// GetCore returns all permanent and stable tier memories, ordered by importance.
func (m *MemoryDB) GetCore() ([]Memory, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	rows, err := m.db.Query(`
		SELECT id, key, value, category, tier, importance,
		       created_at, accessed_at, access_count, expires_at, embedding
		FROM memories
		WHERE tier IN ('permanent', 'stable')
		ORDER BY importance DESC, accessed_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMemories(rows)
}

// GetByTier returns all memories in a given tier.
func (m *MemoryDB) GetByTier(tier string) ([]Memory, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	rows, err := m.db.Query(`
		SELECT id, key, value, category, tier, importance,
		       created_at, accessed_at, access_count, expires_at, embedding
		FROM memories
		WHERE tier = ?
		ORDER BY importance DESC, accessed_at DESC
	`, tier)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMemories(rows)
}

// RefreshAccess bumps the access timestamp and count for a memory.
func (m *MemoryDB) RefreshAccess(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, err := m.db.Exec(`
		UPDATE memories SET accessed_at = ?, access_count = access_count + 1
		WHERE id = ?
	`, time.Now().Unix(), id)
	return err
}

// Delete removes a memory by ID.
func (m *MemoryDB) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, err := m.db.Exec(`DELETE FROM memories WHERE id = ?`, id)
	return err
}

// Count returns the total number of memories.
func (m *MemoryDB) Count() (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var count int
	err := m.db.QueryRow(`SELECT COUNT(*) FROM memories`).Scan(&count)
	return count, err
}

// ExpireOld deletes memories past their expiration time.
func (m *MemoryDB) ExpireOld() (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	result, err := m.db.Exec(`
		DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?
	`, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return int(n), nil
}

// UpdateTier changes the tier of a memory.
func (m *MemoryDB) UpdateTier(id, newTier string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, err := m.db.Exec(`UPDATE memories SET tier = ? WHERE id = ?`, newTier, id)
	return err
}

// All returns all memories.
func (m *MemoryDB) All() ([]Memory, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	rows, err := m.db.Query(`
		SELECT id, key, value, category, tier, importance,
		       created_at, accessed_at, access_count, expires_at, embedding
		FROM memories
		ORDER BY importance DESC, accessed_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMemories(rows)
}

// --- Internal helpers ---

func scanMemories(rows *sql.Rows) ([]Memory, error) {
	var mems []Memory
	for rows.Next() {
		mem, err := scanSingleMemory(rows)
		if err != nil {
			return mems, err
		}
		mems = append(mems, mem)
	}
	return mems, rows.Err()
}

type rowScanner interface {
	Scan(dest ...interface{}) error
}

func scanSingleMemory(rows rowScanner) (Memory, error) {
	var mem Memory
	var createdAt, accessedAt int64
	var expiresAt *int64
	var embeddingBlob []byte

	err := rows.Scan(
		&mem.ID, &mem.Key, &mem.Value, &mem.Category, &mem.Tier,
		&mem.Importance, &createdAt, &accessedAt, &mem.AccessCount,
		&expiresAt, &embeddingBlob,
	)
	if err != nil {
		return mem, err
	}

	mem.CreatedAt = time.Unix(createdAt, 0)
	mem.AccessedAt = time.Unix(accessedAt, 0)
	if expiresAt != nil {
		t := time.Unix(*expiresAt, 0)
		mem.ExpiresAt = &t
	}
	if len(embeddingBlob) > 0 {
		mem.Embedding = decodeEmbedding(embeddingBlob)
	}

	return mem, nil
}

func sanitizeFTSQuery(q string) string {
	q = strings.TrimSpace(q)
	if q == "" {
		return ""
	}
	// Escape FTS5 special characters, convert to OR search for better recall
	words := strings.Fields(q)
	var safe []string
	for _, w := range words {
		w = strings.Map(func(r rune) rune {
			if r == '"' || r == '*' || r == '-' || r == '+' || r == '(' || r == ')' || r == ':' || r == '^' {
				return -1
			}
			return r
		}, w)
		if w != "" {
			safe = append(safe, w)
		}
	}
	if len(safe) == 0 {
		return ""
	}
	return strings.Join(safe, " OR ")
}

func encodeEmbedding(v []float32) []byte {
	buf := make([]byte, len(v)*4)
	for i, f := range v {
		bits := math.Float32bits(f)
		binary.LittleEndian.PutUint32(buf[i*4:], bits)
	}
	return buf
}

func decodeEmbedding(b []byte) []float32 {
	if len(b)%4 != 0 {
		return nil
	}
	v := make([]float32, len(b)/4)
	for i := range v {
		bits := binary.LittleEndian.Uint32(b[i*4:])
		v[i] = math.Float32frombits(bits)
	}
	return v
}

func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		normA += float64(a[i]) * float64(a[i])
		normB += float64(b[i]) * float64(b[i])
	}
	denom := math.Sqrt(normA) * math.Sqrt(normB)
	if denom == 0 {
		return 0
	}
	return dot / denom
}
