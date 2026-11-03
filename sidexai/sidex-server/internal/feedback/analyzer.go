package feedback

import (
	"fmt"
	"sort"
	"strings"
)

// Analyzer examines accumulated signals to produce actionable guidance.
type Analyzer struct {
	store *Store
}

// FailurePattern describes a recurring failure context.
type FailurePattern struct {
	ToolName    string  `json:"tool_name"`
	Context     string  `json:"context"`
	Frequency   int     `json:"frequency"`
	FailureRate float64 `json:"failure_rate"`
	LastError   string  `json:"last_error,omitempty"`
}

// SuccessPattern describes a pattern from successful task completions.
type SuccessPattern struct {
	ToolName    string  `json:"tool_name"`
	Context     string  `json:"context"`
	SuccessRate float64 `json:"success_rate"`
	UsageCount  int     `json:"usage_count"`
}

// NewAnalyzer creates an analyzer backed by the given store.
func NewAnalyzer(store *Store) *Analyzer {
	return &Analyzer{store: store}
}

// ToolEffectiveness returns the success rate (0.0-1.0) for each tool
// that has at least 3 signal observations.
func (a *Analyzer) ToolEffectiveness() map[string]float64 {
	rates, err := a.store.ToolSuccessRates()
	if err != nil {
		return nil
	}
	return rates
}

// CommonFailurePatterns returns the top recurring failure contexts.
func (a *Analyzer) CommonFailurePatterns(limit int) []FailurePattern {
	if limit <= 0 {
		limit = 10
	}

	signals, err := a.store.RecentSignals(500)
	if err != nil {
		return nil
	}

	type patternKey struct {
		tool    string
		context string
	}
	counts := make(map[patternKey]*FailurePattern)
	totalByTool := make(map[string]int)

	for _, sig := range signals {
		if sig.ToolName == "" {
			continue
		}
		totalByTool[sig.ToolName]++

		if sig.Outcome != OutcomeNegative {
			continue
		}

		ctx := normalizeContext(sig.TaskContext)
		key := patternKey{tool: sig.ToolName, context: ctx}

		if _, ok := counts[key]; !ok {
			counts[key] = &FailurePattern{
				ToolName: sig.ToolName,
				Context:  ctx,
			}
		}
		counts[key].Frequency++
		if errStr, ok := sig.Metadata["error"].(string); ok && errStr != "" {
			counts[key].LastError = errStr
		}
	}

	var patterns []FailurePattern
	for key, p := range counts {
		if p.Frequency >= 2 {
			total := totalByTool[key.tool]
			if total > 0 {
				p.FailureRate = float64(p.Frequency) / float64(total)
			}
			patterns = append(patterns, *p)
		}
	}

	sort.Slice(patterns, func(i, j int) bool {
		return patterns[i].Frequency > patterns[j].Frequency
	})

	if len(patterns) > limit {
		patterns = patterns[:limit]
	}
	return patterns
}

// SuccessfulApproaches returns patterns from successful tool uses.
func (a *Analyzer) SuccessfulApproaches(limit int) []SuccessPattern {
	if limit <= 0 {
		limit = 10
	}

	signals, err := a.store.RecentSignals(500)
	if err != nil {
		return nil
	}

	type patternKey struct {
		tool    string
		context string
	}
	successCounts := make(map[patternKey]int)
	totalCounts := make(map[patternKey]int)

	for _, sig := range signals {
		if sig.ToolName == "" {
			continue
		}
		ctx := normalizeContext(sig.TaskContext)
		key := patternKey{tool: sig.ToolName, context: ctx}
		totalCounts[key]++
		if sig.Outcome == OutcomePositive {
			successCounts[key]++
		}
	}

	var patterns []SuccessPattern
	for key, total := range totalCounts {
		successes := successCounts[key]
		if total >= 3 && successes > 0 {
			rate := float64(successes) / float64(total)
			if rate >= 0.8 {
				patterns = append(patterns, SuccessPattern{
					ToolName:    key.tool,
					Context:     key.context,
					SuccessRate: rate,
					UsageCount:  total,
				})
			}
		}
	}

	sort.Slice(patterns, func(i, j int) bool {
		return patterns[i].UsageCount > patterns[j].UsageCount
	})

	if len(patterns) > limit {
		patterns = patterns[:limit]
	}
	return patterns
}

// GenerateGuidance produces context to inject into the system prompt based
// on accumulated feedback signals. This is the "online RL" approximation:
// not weight updates, but behavioral steering via context injection.
func (a *Analyzer) GenerateGuidance(taskContext string) string {
	var parts []string

	// Tool effectiveness warnings
	rates := a.ToolEffectiveness()
	var warnings []string
	var recommendations []string
	for tool, rate := range rates {
		if rate < 0.5 {
			warnings = append(warnings, fmt.Sprintf("- %s has a %.0f%% failure rate — consider alternatives or double-check arguments", tool, (1-rate)*100))
		} else if rate >= 0.9 {
			recommendations = append(recommendations, tool)
		}
	}

	// Context-specific failure patterns
	if taskContext != "" {
		keywords := extractKeywords(taskContext)
		for _, kw := range keywords {
			failures, _ := a.store.FailuresByContext(kw, 5)
			for _, f := range failures {
				if errStr, ok := f.Metadata["error"].(string); ok && errStr != "" {
					warnings = append(warnings, fmt.Sprintf("- Previous failure with %s on similar task: %s", f.ToolName, truncate(errStr, 100)))
				}
			}
		}
	}

	// Tool preference guidance based on comparative rates
	toolPrefs := a.buildToolPreferences(rates)
	if len(toolPrefs) > 0 {
		parts = append(parts, "## Tool Preferences (from feedback)")
		parts = append(parts, toolPrefs...)
	}

	if len(warnings) > 0 {
		// Dedupe
		seen := make(map[string]bool)
		var unique []string
		for _, w := range warnings {
			if !seen[w] {
				seen[w] = true
				unique = append(unique, w)
			}
		}
		if len(unique) > 5 {
			unique = unique[:5]
		}
		parts = append(parts, "## Feedback Warnings")
		parts = append(parts, strings.Join(unique, "\n"))
	}

	// Successful approaches
	successes := a.SuccessfulApproaches(5)
	if len(successes) > 0 {
		var hints []string
		for _, s := range successes {
			if s.Context != "" {
				hints = append(hints, fmt.Sprintf("- %s works well for %s (%.0f%% success over %d uses)", s.ToolName, s.Context, s.SuccessRate*100, s.UsageCount))
			}
		}
		if len(hints) > 0 {
			parts = append(parts, "## Successful Patterns")
			parts = append(parts, strings.Join(hints, "\n"))
		}
	}

	if len(parts) == 0 {
		return ""
	}

	return "# Behavioral Guidance (learned from feedback)\n\n" + strings.Join(parts, "\n\n")
}

// buildToolPreferences compares tools that serve similar purposes.
func (a *Analyzer) buildToolPreferences(rates map[string]float64) []string {
	var prefs []string

	editRate := rates["edit_file"]
	writeRate := rates["write_file"]
	if editRate > 0 && writeRate > 0 && editRate > writeRate+0.15 {
		prefs = append(prefs, fmt.Sprintf("- Prefer edit_file over write_file (%.0f%% vs %.0f%% success rate)", editRate*100, writeRate*100))
	} else if writeRate > 0 && editRate > 0 && writeRate > editRate+0.15 {
		prefs = append(prefs, fmt.Sprintf("- Prefer write_file over edit_file (%.0f%% vs %.0f%% success rate)", writeRate*100, editRate*100))
	}

	grepRate := rates["grep"]
	searchRate := rates["search_files"]
	if grepRate > 0 && searchRate > 0 && grepRate > searchRate+0.15 {
		prefs = append(prefs, fmt.Sprintf("- Prefer grep over search_files (%.0f%% vs %.0f%% success rate)", grepRate*100, searchRate*100))
	}

	return prefs
}

func normalizeContext(ctx string) string {
	ctx = strings.TrimSpace(ctx)
	if len(ctx) > 100 {
		ctx = ctx[:100]
	}
	return strings.ToLower(ctx)
}

func extractKeywords(taskContext string) []string {
	words := strings.Fields(strings.ToLower(taskContext))
	var keywords []string
	for _, w := range words {
		w = strings.Trim(w, ".,!?;:'\"()[]{}/-")
		if len(w) >= 4 && !isStopWord(w) {
			keywords = append(keywords, w)
		}
	}
	if len(keywords) > 5 {
		keywords = keywords[:5]
	}
	return keywords
}

func isStopWord(w string) bool {
	stops := map[string]bool{
		"that": true, "this": true, "with": true, "from": true, "have": true,
		"will": true, "been": true, "they": true, "than": true, "then": true,
		"also": true, "into": true, "some": true, "when": true, "what": true,
		"make": true, "like": true, "just": true, "over": true, "such": true,
		"would": true, "about": true, "which": true, "their": true, "there": true,
		"should": true, "could": true,
	}
	return stops[w]
}
