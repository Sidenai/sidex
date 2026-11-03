package context

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// MemoryStore manages persistent facts learned across sessions.
// It sits on top of the existing MemoryDB (SQLite+FTS5) and provides
// higher-level learning, recall, and forgetting operations.
type MemoryStore struct {
	db *MemoryDB
}

// AutoMemory represents a learned convention or fact.
type AutoMemory struct {
	ID         string    `json:"id"`
	Content    string    `json:"content"`    // "This project uses Tailwind CSS for styling"
	Category   string    `json:"category"`   // "convention", "architecture", "preference", "pattern"
	Confidence float64   `json:"confidence"` // 0-1, how sure we are this is correct
	Source     string    `json:"source"`     // what triggered learning this (file path, user correction, etc.)
	CreatedAt  time.Time `json:"created_at"`
	UsedCount  int       `json:"used_count"` // how many times this memory influenced context
}

// NewMemoryStore creates a MemoryStore backed by the given MemoryDB.
func NewMemoryStore(db *MemoryDB) *MemoryStore {
	return &MemoryStore{db: db}
}

// Learn extracts potential memories from agent interactions.
// Called after each successful agent turn — analyzes what the agent learned.
// It looks for patterns like coding conventions, architecture decisions,
// project structure facts, and user preferences.
func (ms *MemoryStore) Learn(messages []Message, toolResults []string) []AutoMemory {
	var learned []AutoMemory

	for _, msg := range messages {
		if msg.Role != "user" && msg.Role != "assistant" {
			continue
		}
		extracted := ms.extractPatterns(msg.Content, msg.Role)
		learned = append(learned, extracted...)
	}

	for _, result := range toolResults {
		extracted := ms.extractFromToolResult(result)
		learned = append(learned, extracted...)
	}

	// Deduplicate against existing memories before storing
	var deduplicated []AutoMemory
	for i := range learned {
		if ms.isDuplicate(learned[i]) {
			continue
		}
		deduplicated = append(deduplicated, learned[i])
		mem := Memory{
			ID:         learned[i].ID,
			Key:        learned[i].Category + ":" + contentKey(learned[i].Content),
			Value:      learned[i].Content,
			Category:   learned[i].Category,
			Tier:       "permanent",
			Importance: learned[i].Confidence * 8.0,
			CreatedAt:  learned[i].CreatedAt,
		}
		_ = ms.db.Store(mem)
	}

	return deduplicated
}

// Recall retrieves relevant memories for the current context.
func (ms *MemoryStore) Recall(query string, activeFiles []string, limit int) []AutoMemory {
	if limit <= 0 {
		limit = 10
	}

	// Build a combined query from the explicit query + active file paths
	searchQuery := query
	for _, f := range activeFiles {
		parts := strings.Split(f, "/")
		if len(parts) > 0 {
			searchQuery += " " + parts[len(parts)-1]
		}
	}

	results, err := ms.db.Search(searchQuery, limit*2)
	if err != nil || len(results) == 0 {
		return nil
	}

	// Filter to convention-tier memories and convert
	var memories []AutoMemory
	for _, m := range results {
		if m.Category != "convention" && m.Tier != "permanent" {
			continue
		}
		memories = append(memories, AutoMemory{
			ID:         m.ID,
			Content:    m.Value,
			Category:   inferAutoCategory(m.Key),
			Confidence: m.Importance / 8.0,
			Source:     m.Key,
			CreatedAt:  m.CreatedAt,
			UsedCount:  m.AccessCount,
		})
		if len(memories) >= limit {
			break
		}
	}

	// Bump access counts for returned memories
	for _, am := range memories {
		_ = ms.db.RefreshAccess(am.ID)
	}

	return memories
}

// Forget removes a memory by ID (user can dismiss).
func (ms *MemoryStore) Forget(id string) error {
	return ms.db.Delete(id)
}

// extractPatterns detects learnable patterns from message content.
func (ms *MemoryStore) extractPatterns(content string, role string) []AutoMemory {
	var results []AutoMemory
	lower := strings.ToLower(content)

	// Convention detection patterns
	conventionSignals := []struct {
		pattern    string
		category   string
		confidence float64
	}{
		{"we use ", "convention", 0.8},
		{"our project uses ", "architecture", 0.85},
		{"prefer ", "preference", 0.7},
		{"always use ", "preference", 0.8},
		{"never use ", "preference", 0.8},
		{"naming convention", "convention", 0.9},
		{"code style", "convention", 0.85},
		{"the architecture ", "architecture", 0.75},
		{"error handling pattern", "pattern", 0.85},
		{"tests are in ", "architecture", 0.9},
		{"tests go in ", "architecture", 0.9},
		{"imports should ", "convention", 0.8},
		{"file structure", "architecture", 0.7},
	}

	lines := strings.Split(content, "\n")
	for _, line := range lines {
		lineLower := strings.ToLower(strings.TrimSpace(line))
		if len(lineLower) < 10 || len(lineLower) > 300 {
			continue
		}

		for _, sig := range conventionSignals {
			if strings.Contains(lineLower, sig.pattern) {
				trimmed := strings.TrimSpace(line)
				if len(trimmed) > 200 {
					trimmed = trimmed[:200]
				}

				confidence := sig.confidence
				if role == "user" {
					confidence += 0.1 // user statements are more authoritative
				}
				if confidence > 1.0 {
					confidence = 1.0
				}

				results = append(results, AutoMemory{
					ID:         uuid.New().String(),
					Content:    trimmed,
					Category:   sig.category,
					Confidence: confidence,
					Source:     "conversation",
					CreatedAt:  time.Now(),
				})
				break
			}
		}
	}

	// Detect framework/tool mentions from user messages
	if role == "user" {
		frameworks := extractFrameworkMentions(lower)
		for _, fw := range frameworks {
			results = append(results, AutoMemory{
				ID:         uuid.New().String(),
				Content:    fw,
				Category:   "architecture",
				Confidence: 0.7,
				Source:     "user_mention",
				CreatedAt:  time.Now(),
			})
		}
	}

	return results
}

// extractFromToolResult extracts architecture info from tool outputs.
func (ms *MemoryStore) extractFromToolResult(result string) []AutoMemory {
	var results []AutoMemory

	// Detect package.json or go.mod style dependency info
	if strings.Contains(result, "\"dependencies\"") || strings.Contains(result, "module ") {
		if strings.Contains(result, "next") || strings.Contains(result, "Next") {
			results = append(results, AutoMemory{
				ID:         uuid.New().String(),
				Content:    "Project uses Next.js",
				Category:   "architecture",
				Confidence: 0.95,
				Source:     "package.json",
				CreatedAt:  time.Now(),
			})
		}
		if strings.Contains(result, "tailwindcss") {
			results = append(results, AutoMemory{
				ID:         uuid.New().String(),
				Content:    "Project uses Tailwind CSS for styling",
				Category:   "architecture",
				Confidence: 0.95,
				Source:     "package.json",
				CreatedAt:  time.Now(),
			})
		}
	}

	return results
}

// isDuplicate checks if a similar memory already exists.
func (ms *MemoryStore) isDuplicate(am AutoMemory) bool {
	existing, err := ms.db.Search(am.Content, 5)
	if err != nil || len(existing) == 0 {
		return false
	}

	amHash := contentHash(am.Content)
	for _, e := range existing {
		if contentHash(e.Value) == amHash {
			return true
		}
		// Fuzzy match: if the first 50 chars match, consider it a duplicate
		if len(am.Content) > 50 && len(e.Value) > 50 {
			if strings.EqualFold(am.Content[:50], e.Value[:50]) {
				return true
			}
		}
	}
	return false
}

// extractFrameworkMentions detects framework/tool references.
func extractFrameworkMentions(lower string) []string {
	var results []string
	frameworks := map[string]string{
		"next.js":    "Project uses Next.js (React framework)",
		"nextjs":     "Project uses Next.js (React framework)",
		"app router": "Project uses Next.js App Router",
		"tailwind":   "Project uses Tailwind CSS",
		"prisma":     "Project uses Prisma ORM",
		"trpc":       "Project uses tRPC",
		"typescript": "Project is written in TypeScript",
		"rust":       "Project uses Rust",
		"go module":  "Project is a Go module",
		"docker":     "Project uses Docker",
		"kubernetes": "Project deploys to Kubernetes",
		"supabase":   "Project uses Supabase",
		"firebase":   "Project uses Firebase",
	}

	for keyword, description := range frameworks {
		if strings.Contains(lower, keyword) {
			results = append(results, description)
		}
	}
	return results
}

func contentKey(content string) string {
	words := strings.Fields(content)
	if len(words) > 5 {
		words = words[:5]
	}
	return strings.Join(words, "_")
}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(content))))
	return fmt.Sprintf("%x", h[:8])
}

func inferAutoCategory(key string) string {
	parts := strings.SplitN(key, ":", 2)
	if len(parts) == 2 {
		switch parts[0] {
		case "convention", "architecture", "preference", "pattern":
			return parts[0]
		}
	}
	return "convention"
}
