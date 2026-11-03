package agent

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/cost"
)

// DefaultRaceModels are the default model pair used for racing (OpenRouter IDs).
var DefaultRaceModels = []string{
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-haiku-4.5",
}

// RaceConfig controls when and how model racing activates.
type RaceConfig struct {
	Enabled       bool     `json:"enabled"`
	Models        []string `json:"models"`
	MaxRacers     int      `json:"max_racers"`
	TriggerAfter  int      `json:"trigger_after"`
	AlwaysRaceFor []string `json:"always_race_for"`
	TimeoutSec    int      `json:"timeout_sec"`
}

// DefaultRaceConfig returns a sensible default racing configuration.
func DefaultRaceConfig() RaceConfig {
	return RaceConfig{
		Enabled:       false,
		Models:        DefaultRaceModels,
		MaxRacers:     2,
		TriggerAfter:  1,
		AlwaysRaceFor: []string{"edit_file", "multi_edit"},
		TimeoutSec:    120,
	}
}

// RaceResult holds one model's complete response from a race.
type RaceResult struct {
	ModelID   string        `json:"model_id"`
	Content   string        `json:"content"`
	ToolCalls []ai.ToolCall `json:"tool_calls,omitempty"`
	Tokens    int           `json:"tokens"`
	Latency   time.Duration `json:"latency"`
	Cost      float64       `json:"cost"`
	Error     error         `json:"-"`
	Score     float64       `json:"score"`
}

// RaceOutcome is the full result of a race: winner + all participants.
type RaceOutcome struct {
	Winner   *RaceResult  `json:"winner"`
	All      []RaceResult `json:"all"`
	Reason   string       `json:"reason"`
	RaceCost float64      `json:"race_cost"`
}

// RaceTrigger evaluates whether the current turn should trigger racing.
type RaceTrigger struct {
	ReflexionFailures int
	PendingToolNames  []string
	UserRequestedHard bool
}

// ShouldRace determines if racing should activate for the current turn.
func ShouldRace(cfg RaceConfig, trigger RaceTrigger) bool {
	if !cfg.Enabled {
		return false
	}

	if trigger.UserRequestedHard {
		return true
	}

	if cfg.TriggerAfter > 0 && trigger.ReflexionFailures >= cfg.TriggerAfter {
		return true
	}

	for _, toolName := range trigger.PendingToolNames {
		for _, raceTool := range cfg.AlwaysRaceFor {
			if toolName == raceTool {
				return true
			}
		}
	}

	return false
}

// Race dispatches the same messages to multiple models in parallel and picks
// the best response. It collects all results (including errors), scores them,
// and returns the winner along with the full set for logging/cost tracking.
func Race(
	ctx context.Context,
	client *ai.Client,
	messages []ai.Message,
	system string,
	tools []ai.ToolDef,
	cfg RaceConfig,
	tracker *cost.Tracker,
) (*RaceOutcome, error) {
	models := cfg.Models
	if len(models) == 0 {
		models = DefaultRaceModels
	}
	if cfg.MaxRacers > 0 && len(models) > cfg.MaxRacers {
		models = models[:cfg.MaxRacers]
	}
	if len(models) < 2 {
		return nil, fmt.Errorf("racing requires at least 2 models, got %d", len(models))
	}

	timeout := time.Duration(cfg.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 120 * time.Second
	}

	raceCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	results := make([]RaceResult, len(models))
	var wg sync.WaitGroup

	for i, modelID := range models {
		wg.Add(1)
		go func(idx int, model string) {
			defer wg.Done()
			results[idx] = runRacer(raceCtx, client, model, messages, system, tools, tracker)
		}(i, modelID)
	}

	wg.Wait()

	var bestIdx int
	var bestScore float64 = -100
	for i := range results {
		results[i].Score = scoreResponse(results[i], messages)
		if results[i].Score > bestScore {
			bestScore = results[i].Score
			bestIdx = i
		}
	}

	var totalCost float64
	for _, r := range results {
		totalCost += r.Cost
	}

	reason := buildWinReason(results, bestIdx)
	winner := results[bestIdx]

	log.Printf("race: winner=%s score=%.2f reason=%q racers=%d total_cost=$%.4f",
		winner.ModelID, winner.Score, reason, len(models), totalCost)

	return &RaceOutcome{
		Winner:   &winner,
		All:      results,
		Reason:   reason,
		RaceCost: totalCost,
	}, nil
}

// runRacer executes a single model call, collecting the full non-streaming
// response. Racing uses non-streaming collection because we need the complete
// response to score it before choosing a winner.
func runRacer(
	ctx context.Context,
	client *ai.Client,
	modelID string,
	messages []ai.Message,
	system string,
	tools []ai.ToolDef,
	tracker *cost.Tracker,
) RaceResult {
	start := time.Now()
	result := RaceResult{ModelID: modelID}

	modelClient := client.WithModel(modelID)

	done := make(chan struct{})
	go func() {
		defer close(done)

		var content strings.Builder
		var toolCalls []ai.ToolCall
		var totalTokens int

		err := modelClient.StreamChat(messages, tools, system, func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				content.WriteString(chunk.Content)
			case "tool_call":
				toolCalls = append(toolCalls, chunk.ToolCalls...)
			case "usage":
				if chunk.TokensUsed != nil {
					tokens := chunk.TokensUsed.PromptTokens + chunk.TokensUsed.CompletionTokens
					totalTokens += tokens
					turnCost := tracker.Add(
						modelID,
						chunk.TokensUsed.PromptTokens,
						chunk.TokensUsed.CompletionTokens,
						chunk.TokensUsed.CacheCreationInputTokens,
						chunk.TokensUsed.CacheReadInputTokens,
					)
					result.Cost += turnCost
				}
			}
		})

		result.Content = content.String()
		result.ToolCalls = toolCalls
		result.Tokens = totalTokens
		result.Latency = time.Since(start)
		result.Error = err
	}()

	select {
	case <-done:
	case <-ctx.Done():
		result.Error = fmt.Errorf("race timeout after %s", time.Since(start).Round(time.Millisecond))
		result.Latency = time.Since(start)
	}

	return result
}

// scoreResponse evaluates the quality of a model response for ranking.
func scoreResponse(result RaceResult, messages []ai.Message) float64 {
	if result.Error != nil {
		return -10.0
	}

	score := 0.0

	// Prefer responses that use tools (action-oriented agents are better)
	if len(result.ToolCalls) > 0 {
		score += 2.0
		// Bonus for edit tools (high-value actions)
		for _, tc := range result.ToolCalls {
			if isEditTool(tc.Function.Name) {
				score += 1.0
				break
			}
		}
	}

	// Prefer concise responses (focused = better)
	contentLen := len(result.Content)
	switch {
	case contentLen > 0 && contentLen < 500:
		score += 1.0
	case contentLen >= 500 && contentLen < 2000:
		score += 0.5
	}

	// Prefer lower latency (bounded contribution)
	score += 1.0 / (1.0 + result.Latency.Seconds()/10.0)

	// Prefer responses that reference specific files/functions
	if containsCodeReference(result.Content) {
		score += 1.5
	}

	// Prefer responses that reference context from the conversation
	if referencesConversationContext(result.Content, messages) {
		score += 1.0
	}

	return score
}

// buildWinReason explains why the winner was chosen.
func buildWinReason(results []RaceResult, winnerIdx int) string {
	winner := results[winnerIdx]
	var reasons []string

	if winner.Error == nil {
		hasToolCalls := len(winner.ToolCalls) > 0
		othersHaveTools := false
		for i, r := range results {
			if i != winnerIdx && len(r.ToolCalls) > 0 {
				othersHaveTools = true
			}
		}
		if hasToolCalls && !othersHaveTools {
			reasons = append(reasons, "only racer with tool usage")
		} else if hasToolCalls {
			reasons = append(reasons, "higher tool usage score")
		}
	}

	fastest := true
	for i, r := range results {
		if i != winnerIdx && r.Error == nil && r.Latency < winner.Latency {
			fastest = false
		}
	}
	if fastest && winner.Error == nil {
		reasons = append(reasons, "fastest response")
	}

	if containsCodeReference(winner.Content) {
		reasons = append(reasons, "references specific code")
	}

	if len(reasons) == 0 {
		reasons = append(reasons, "highest composite score")
	}

	return strings.Join(reasons, ", ")
}

var codeRefPattern = regexp.MustCompile(`(?m)(\w+\.\w+[:(]|` + "`" + `[^` + "`" + `]+` + "`" + `|/[\w/]+\.\w+|func\s+\w+|class\s+\w+|def\s+\w+)`)

// containsCodeReference checks if text references specific files, functions, or code.
func containsCodeReference(content string) bool {
	return codeRefPattern.MatchString(content)
}

// referencesConversationContext checks if the response references specific
// terms from recent user messages, indicating the model engaged with context.
func referencesConversationContext(content string, messages []ai.Message) bool {
	if content == "" {
		return false
	}
	contentLower := strings.ToLower(content)

	for i := len(messages) - 1; i >= 0 && i >= len(messages)-3; i-- {
		if messages[i].Role != ai.RoleUser {
			continue
		}
		words := strings.Fields(messages[i].Content)
		matches := 0
		for _, w := range words {
			if len(w) > 5 && strings.Contains(contentLower, strings.ToLower(w)) {
				matches++
			}
			if matches >= 2 {
				return true
			}
		}
	}
	return false
}

func isEditTool(name string) bool {
	switch name {
	case "edit_file", "multi_edit", "write_file", "regex_replace", "patch_file":
		return true
	}
	return false
}

// RaceStatusEvent is the WebSocket event sent to the UI to report racing status.
type RaceStatusEvent struct {
	Type    string   `json:"type"`
	Models  []string `json:"models"`
	Winner  string   `json:"winner"`
	Reason  string   `json:"reason"`
	Cost    float64  `json:"race_cost"`
	Latency int64    `json:"latency_ms"`
}

// NewRaceStatusEvent builds a WebSocket event from a race outcome.
func NewRaceStatusEvent(outcome *RaceOutcome) RaceStatusEvent {
	var models []string
	for _, r := range outcome.All {
		models = append(models, shortModelName(r.ModelID))
	}

	return RaceStatusEvent{
		Type:    "race_status",
		Models:  models,
		Winner:  shortModelName(outcome.Winner.ModelID),
		Reason:  outcome.Reason,
		Cost:    outcome.RaceCost,
		Latency: outcome.Winner.Latency.Milliseconds(),
	}
}

// shortModelName extracts a human-readable short name from a model ID.
func shortModelName(modelID string) string {
	for _, m := range cost.Models {
		if m.ID == modelID {
			return m.Name
		}
	}
	// OpenRouter IDs are "provider/model" — show the model part.
	if idx := strings.LastIndex(modelID, "/"); idx >= 0 && idx < len(modelID)-1 {
		return modelID[idx+1:]
	}
	return modelID
}

// DetectThinkHarder checks if the user's latest message requests enhanced effort.
func DetectThinkHarder(messages []ai.Message) bool {
	if len(messages) == 0 {
		return false
	}

	last := messages[len(messages)-1]
	if last.Role != ai.RoleUser {
		return false
	}

	lower := strings.ToLower(last.Content)
	triggers := []string{
		"think harder",
		"try harder",
		"be more careful",
		"really think",
		"take your time",
		"do your best",
		"this is important",
		"critical",
		"high priority",
	}
	for _, t := range triggers {
		if strings.Contains(lower, t) {
			return true
		}
	}
	return false
}
