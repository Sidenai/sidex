package ai

import "strings"

// EffortLevel is the chat UI reasoning control: None / Low / Medium / High / Ultra.
type EffortLevel string

const (
	EffortNone   EffortLevel = "none"
	EffortLow    EffortLevel = "low"
	EffortMedium EffortLevel = "medium"
	EffortHigh   EffortLevel = "high"
	EffortUltra  EffortLevel = "ultra"
)

// ParseEffort maps a UI/API effort string, falling back to the token budget
// the older clients sent as thinking_budget.
func ParseEffort(s string, budget int) EffortLevel {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "none", "off", "0":
		return EffortNone
	case "low":
		return EffortLow
	case "medium", "med":
		return EffortMedium
	case "high":
		return EffortHigh
	case "ultra", "max", "xhigh":
		return EffortUltra
	}
	switch {
	case budget <= 0:
		return EffortNone
	case budget <= 2000:
		return EffortLow
	case budget <= 4000:
		return EffortMedium
	case budget <= 8000:
		return EffortHigh
	default:
		return EffortUltra
	}
}

// Budget is the token budget used on providers that still want a number
// (OpenRouter reasoning.max_tokens, Claude 4.5 extended thinking).
func (e EffortLevel) Budget() int {
	switch e {
	case EffortLow:
		return 2000
	case EffortMedium:
		return 4000
	case EffortHigh:
		return 8000
	case EffortUltra:
		return 16000
	default:
		return 0
	}
}

// OpenAIEffort is the Responses / Chat Completions reasoning.effort value.
func (e EffortLevel) OpenAIEffort() string {
	switch e {
	case EffortLow:
		return "low"
	case EffortMedium:
		return "medium"
	case EffortHigh, EffortUltra:
		return "high"
	default:
		return ""
	}
}

// AnthropicEffort is output_config.effort for models that support it.
func (e EffortLevel) AnthropicEffort(model string) string {
	switch e {
	case EffortNone:
		// Sonnet/Opus 4.6 default to high if we omit this. "None" has to
		// pin a cheap level or the slider does nothing.
		return "low"
	case EffortLow:
		return "low"
	case EffortMedium:
		return "medium"
	case EffortHigh:
		return "high"
	case EffortUltra:
		if anthropicSupportsMaxEffort(model) {
			return "max"
		}
		return "high"
	default:
		return ""
	}
}

func anthropicModelKey(model string) string {
	return strings.ToLower(AnthropicModelID(model))
}

func anthropicSupportsOutputEffort(model string) bool {
	id := anthropicModelKey(model)
	if id == "" || strings.Contains(id, "haiku") {
		return false
	}
	if strings.Contains(id, "sonnet-4-5") {
		return false
	}
	for _, marker := range []string{
		"4-6", "4-7", "4-8", "4-9",
		"opus-4-5", "opus-5", "sonnet-5",
		"fable", "mythos",
	} {
		if strings.Contains(id, marker) {
			return true
		}
	}
	return false
}

func anthropicSupportsMaxEffort(model string) bool {
	id := anthropicModelKey(model)
	for _, marker := range []string{
		"4-6", "4-7", "4-8", "4-9",
		"opus-5", "sonnet-5", "fable", "mythos",
	} {
		if strings.Contains(id, marker) {
			return true
		}
	}
	return false
}

func anthropicUsesAdaptiveThinking(model string) bool {
	id := anthropicModelKey(model)
	if strings.Contains(id, "haiku") || strings.Contains(id, "4-5") {
		return false
	}
	return anthropicSupportsOutputEffort(model)
}

type anthropicOutputConfig struct {
	Effort string `json:"effort,omitempty"`
}

type anthropicThinkingFields struct {
	Thinking     *anthropicThinking
	OutputConfig *anthropicOutputConfig
	MinMaxTokens int
}

func thinkingForAnthropic(model string, opts *StreamOptions) anthropicThinkingFields {
	level := EffortNone
	if opts != nil {
		level = ParseEffort(opts.Effort, opts.ThinkingBudget)
	}

	out := anthropicThinkingFields{}
	if anthropicSupportsOutputEffort(model) {
		if e := level.AnthropicEffort(model); e != "" {
			out.OutputConfig = &anthropicOutputConfig{Effort: e}
		}
	}

	switch {
	case level == EffortNone:
		return out
	case anthropicUsesAdaptiveThinking(model):
		out.Thinking = &anthropicThinking{Type: "adaptive"}
		if level == EffortUltra {
			out.MinMaxTokens = 32000
		}
	default:
		if !ModelSupportsThinking(model) {
			return out
		}
		budget := level.Budget()
		if opts != nil && opts.ThinkingBudget > budget {
			budget = opts.ThinkingBudget
		}
		if budget < 1024 {
			budget = 1024
		}
		out.Thinking = &anthropicThinking{Type: "enabled", BudgetTokens: budget}
		out.MinMaxTokens = budget + defaultAnthropicMaxTokens
	}
	return out
}

func applyAnthropicThinking(body *anthropicRequest, model string, opts *StreamOptions) {
	cfg := thinkingForAnthropic(model, opts)
	body.Thinking = cfg.Thinking
	body.OutputConfig = cfg.OutputConfig
	if cfg.MinMaxTokens > body.MaxTokens {
		body.MaxTokens = cfg.MinMaxTokens
	}
}

func reasoningForOpenAI(model string, opts *StreamOptions) map[string]interface{} {
	if opts == nil {
		return nil
	}
	level := ParseEffort(opts.Effort, opts.ThinkingBudget)
	if level == EffortNone {
		return nil
	}
	if !ModelSupportsThinking(model) {
		return nil
	}
	effort := level.OpenAIEffort()
	if effort == "" {
		return nil
	}
	return map[string]interface{}{
		"effort":     effort,
		"max_tokens": level.Budget(),
	}
}
