package apply

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/sidex-ai/sidex-server/internal/ai"
)

const (
	// Fast, cheap model for edit application — OpenRouter ID.
	defaultFastModel = "anthropic/claude-haiku-4.5"
	defaultMaxFile   = 256 * 1024 // 256 KB
)

// ApplyModel handles fast, low-latency edit application.
// Instead of the reasoning model writing exact diffs, it outputs edit intents
// and this module applies them at high speed using a fast model.
type ApplyModel struct {
	client  *ai.Client
	config  ApplyConfig
	metrics *Metrics
	mu      sync.RWMutex
}

// ApplyConfig controls fast-apply behavior.
type ApplyConfig struct {
	Enabled         bool   `json:"enabled"`
	FastModel       string `json:"fast_model"`
	MaxFileSize     int    `json:"max_file_size"`
	FallbackToExact bool   `json:"fallback_to_exact"`
}

// DefaultConfig returns a sensible default configuration.
func DefaultConfig() ApplyConfig {
	return ApplyConfig{
		Enabled:         true,
		FastModel:       defaultFastModel,
		MaxFileSize:     defaultMaxFile,
		FallbackToExact: true,
	}
}

// EditIntent is what the reasoning model outputs (high-level description).
type EditIntent struct {
	FilePath    string `json:"file_path"`
	Description string `json:"description"`
	Context     string `json:"context"`
	OldCode     string `json:"old_code"`
	NewCode     string `json:"new_code"`
}

// ApplyResult reports the outcome of a fast-apply attempt.
type ApplyResult struct {
	NewContent string
	Method     string // "exact", "whitespace_normalized", "fast_model", "failed"
	Duration   time.Duration
	ModelUsed  string
}

// New creates an ApplyModel from an existing AI client and config.
func New(client *ai.Client, cfg ApplyConfig) *ApplyModel {
	if cfg.FastModel == "" {
		cfg.FastModel = defaultFastModel
	}
	if cfg.MaxFileSize <= 0 {
		cfg.MaxFileSize = defaultMaxFile
	}
	return &ApplyModel{
		client:  client.WithModel(cfg.FastModel),
		config:  cfg,
		metrics: NewMetrics(),
	}
}

// ApplyEdit uses the fast model to merge an edit intent into the actual file.
func (a *ApplyModel) ApplyEdit(ctx context.Context, intent EditIntent, currentFileContent string) (ApplyResult, error) {
	start := time.Now()

	if !a.config.Enabled {
		return ApplyResult{Method: "disabled"}, fmt.Errorf("fast-apply is disabled")
	}

	if len(currentFileContent) > a.config.MaxFileSize {
		return ApplyResult{Method: "skipped_too_large"}, fmt.Errorf("file exceeds max size for fast-apply (%d > %d)", len(currentFileContent), a.config.MaxFileSize)
	}

	// Try exact replacement first (cheapest path).
	if intent.OldCode != "" && strings.Contains(currentFileContent, intent.OldCode) {
		result := strings.Replace(currentFileContent, intent.OldCode, intent.NewCode, 1)
		a.metrics.Record("exact", true, time.Since(start))
		return ApplyResult{
			NewContent: result,
			Method:     "exact",
			Duration:   time.Since(start),
		}, nil
	}

	// Try whitespace-normalized match.
	if intent.OldCode != "" {
		if result, ok := a.tryWhitespaceNormalized(currentFileContent, intent.OldCode, intent.NewCode); ok {
			a.metrics.Record("whitespace_normalized", true, time.Since(start))
			return ApplyResult{
				NewContent: result,
				Method:     "whitespace_normalized",
				Duration:   time.Since(start),
			}, nil
		}
	}

	// Route through the fast model for fuzzy application.
	result, err := a.callFastModel(ctx, intent, currentFileContent)
	if err != nil {
		a.metrics.Record("fast_model", false, time.Since(start))
		return ApplyResult{Method: "failed", Duration: time.Since(start)}, err
	}

	a.metrics.Record("fast_model", true, time.Since(start))
	return ApplyResult{
		NewContent: result,
		Method:     "fast_model",
		Duration:   time.Since(start),
		ModelUsed:  a.config.FastModel,
	}, nil
}

// FuzzyApply attempts to apply an edit even when old_str doesn't match exactly.
// Handles whitespace diffs, minor reformatting, moved lines.
func (a *ApplyModel) FuzzyApply(ctx context.Context, filePath, oldStr, newStr, fileContent string) (ApplyResult, error) {
	start := time.Now()

	if !a.config.Enabled {
		return ApplyResult{Method: "disabled"}, fmt.Errorf("fast-apply is disabled")
	}

	// Step 1: Normalize whitespace and retry.
	if result, ok := a.tryWhitespaceNormalized(fileContent, oldStr, newStr); ok {
		a.metrics.Record("fuzzy_whitespace", true, time.Since(start))
		return ApplyResult{
			NewContent: result,
			Method:     "whitespace_normalized",
			Duration:   time.Since(start),
		}, nil
	}

	// Step 2: Try line-trimmed matching (handles indentation drift).
	if result, ok := a.tryLineTrimmed(fileContent, oldStr, newStr); ok {
		a.metrics.Record("fuzzy_line_trimmed", true, time.Since(start))
		return ApplyResult{
			NewContent: result,
			Method:     "whitespace_normalized",
			Duration:   time.Since(start),
		}, nil
	}

	// Step 3: Use the fast model to find closest match and apply.
	if len(fileContent) > a.config.MaxFileSize {
		a.metrics.Record("fuzzy_skipped", false, time.Since(start))
		return ApplyResult{Method: "failed"}, fmt.Errorf("file too large for fast-model fuzzy apply")
	}

	intent := EditIntent{
		FilePath:    filePath,
		Description: "Apply the following edit (the old code may not match exactly due to whitespace/formatting differences)",
		OldCode:     oldStr,
		NewCode:     newStr,
	}

	result, err := a.callFastModel(ctx, intent, fileContent)
	if err != nil {
		a.metrics.Record("fuzzy_model", false, time.Since(start))
		return ApplyResult{Method: "failed", Duration: time.Since(start)}, err
	}

	a.metrics.Record("fuzzy_model", true, time.Since(start))
	return ApplyResult{
		NewContent: result,
		Method:     "fast_model",
		Duration:   time.Since(start),
		ModelUsed:  a.config.FastModel,
	}, nil
}

// GetMetrics returns current fast-apply performance metrics.
func (a *ApplyModel) GetMetrics() MetricsSnapshot {
	return a.metrics.Snapshot()
}

func (a *ApplyModel) callFastModel(ctx context.Context, intent EditIntent, fileContent string) (string, error) {
	prompt := buildApplyPrompt(intent, fileContent)

	var resultBuilder strings.Builder
	var streamErr error

	messages := []ai.Message{
		{Role: ai.RoleUser, Content: prompt},
	}

	systemPrompt := `You are a fast code-apply model. Your ONLY job is to take a file and an edit intent, then return the complete updated file content. Rules:
- Return ONLY the file content, no markdown fences, no explanations
- Preserve all code that isn't being edited
- Apply the edit precisely as described
- Match the existing code style (indentation, spacing)
- If you cannot determine where to apply the edit, return the original file unchanged`

	done := make(chan struct{})
	go func() {
		defer close(done)
		streamErr = a.client.StreamChat(messages, nil, systemPrompt, func(chunk ai.StreamChunk) {
			if chunk.Type == "text" {
				resultBuilder.WriteString(chunk.Content)
			}
		})
	}()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-done:
	}

	if streamErr != nil {
		return "", fmt.Errorf("fast model error: %w", streamErr)
	}

	result := resultBuilder.String()
	if result == "" {
		return "", fmt.Errorf("fast model returned empty response")
	}

	// Strip markdown fences if the model included them despite instructions.
	result = stripCodeFences(result)

	if result == fileContent {
		log.Printf("[fast-apply] model returned unchanged file; edit may have failed silently")
	}

	return result, nil
}

func buildApplyPrompt(intent EditIntent, fileContent string) string {
	var b strings.Builder
	b.WriteString("Apply the following edit to the file below.\n\n")

	if intent.Description != "" {
		b.WriteString("## Edit Description\n")
		b.WriteString(intent.Description)
		b.WriteString("\n\n")
	}

	if intent.OldCode != "" {
		b.WriteString("## Code to Find (approximate — may differ in whitespace/formatting)\n```\n")
		b.WriteString(intent.OldCode)
		b.WriteString("\n```\n\n")
	}

	if intent.NewCode != "" {
		b.WriteString("## Replacement Code\n```\n")
		b.WriteString(intent.NewCode)
		b.WriteString("\n```\n\n")
	}

	if intent.Context != "" {
		b.WriteString("## Additional Context\n")
		b.WriteString(intent.Context)
		b.WriteString("\n\n")
	}

	b.WriteString("## Current File Content\n```\n")
	b.WriteString(fileContent)
	b.WriteString("\n```\n\n")
	b.WriteString("Return the COMPLETE updated file content with the edit applied. No explanations, no fences.")

	return b.String()
}

// tryWhitespaceNormalized collapses runs of whitespace and attempts matching.
func (a *ApplyModel) tryWhitespaceNormalized(fileContent, oldStr, newStr string) (string, bool) {
	normFile := normalizeWhitespace(fileContent)
	normOld := normalizeWhitespace(oldStr)

	if !strings.Contains(normFile, normOld) {
		return "", false
	}

	// Find the position in normalized space, then map back to original.
	normIdx := strings.Index(normFile, normOld)
	origStart, origEnd := mapNormToOrig(fileContent, normIdx, len(normOld))
	if origStart < 0 || origEnd < 0 {
		return "", false
	}

	result := fileContent[:origStart] + newStr + fileContent[origEnd:]
	return result, true
}

// tryLineTrimmed splits into lines, trims each, and checks for a contiguous match.
func (a *ApplyModel) tryLineTrimmed(fileContent, oldStr, newStr string) (string, bool) {
	fileLines := strings.Split(fileContent, "\n")
	oldLines := strings.Split(oldStr, "\n")

	if len(oldLines) == 0 {
		return "", false
	}

	trimmedOld := make([]string, len(oldLines))
	for i, l := range oldLines {
		trimmedOld[i] = strings.TrimSpace(l)
	}

	for i := 0; i <= len(fileLines)-len(oldLines); i++ {
		match := true
		for j, tl := range trimmedOld {
			if strings.TrimSpace(fileLines[i+j]) != tl {
				match = false
				break
			}
		}
		if match {
			before := strings.Join(fileLines[:i], "\n")
			after := strings.Join(fileLines[i+len(oldLines):], "\n")
			result := before
			if before != "" {
				result += "\n"
			}
			result += newStr
			if after != "" {
				result += "\n" + after
			}
			return result, true
		}
	}

	return "", false
}

func normalizeWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
		} else {
			b.WriteRune(r)
			prevSpace = false
		}
	}
	return b.String()
}

// mapNormToOrig maps a (start, length) in normalized space back to the range in original text.
func mapNormToOrig(orig string, normStart, normLen int) (int, int) {
	normPos := 0
	origStart := -1
	origEnd := -1
	prevSpace := false

	for i, r := range orig {
		if unicode.IsSpace(r) {
			if !prevSpace {
				if normPos == normStart {
					origStart = i
				}
				normPos++
				if normPos == normStart+normLen {
					origEnd = i + 1
					break
				}
				prevSpace = true
			}
		} else {
			if normPos == normStart {
				origStart = i
			}
			normPos++
			if normPos == normStart+normLen {
				origEnd = i + len(string(r))
				break
			}
			prevSpace = false
		}
	}

	if origEnd == -1 && normPos == normStart+normLen {
		origEnd = len(orig)
	}

	return origStart, origEnd
}

func stripCodeFences(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		firstNewline := strings.Index(s, "\n")
		if firstNewline >= 0 {
			s = s[firstNewline+1:]
		}
	}
	if strings.HasSuffix(s, "```") {
		s = s[:len(s)-3]
		s = strings.TrimRight(s, "\n")
	}
	return s
}

// MarshalConfig returns the current config as JSON.
func (a *ApplyModel) MarshalConfig() ([]byte, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return json.Marshal(a.config)
}
