package agent

import (
	"fmt"
	"strings"
)

// RecoveryAction indicates what the agent loop should do after an API error.
type RecoveryAction int

const (
	RecoveryNone           RecoveryAction = iota
	RecoveryRetry                         // retry the same request
	RecoveryCompact                       // compact context and retry
	RecoveryEscalateTokens                // increase max_tokens and retry
	RecoveryFallbackModel                 // switch to a cheaper model and retry
	RecoveryAbort                         // give up
)

func (a RecoveryAction) String() string {
	switch a {
	case RecoveryNone:
		return "none"
	case RecoveryRetry:
		return "retry"
	case RecoveryCompact:
		return "compact"
	case RecoveryEscalateTokens:
		return "escalate_tokens"
	case RecoveryFallbackModel:
		return "fallback_model"
	case RecoveryAbort:
		return "abort"
	default:
		return fmt.Sprintf("unknown(%d)", int(a))
	}
}

// RecoveryState tracks retry budgets across recovery attempts within a single
// agent turn so the loop doesn't retry forever.
type RecoveryState struct {
	Retries          int
	TokenEscalations int
	ModelFallbacks   int
}

const (
	maxRetries          = 2
	maxTokenEscalations = 3
	maxModelFallbacks   = 2
)

// RecoverFromError inspects an API error and returns the appropriate
// recovery action. It mutates state to track retry budgets.
func RecoverFromError(err error, state *RecoveryState) RecoveryAction {
	if err == nil {
		return RecoveryNone
	}

	msg := err.Error()

	// 1. Prompt too long / 413 → compact context
	if containsAny(msg, "prompt is too long", "maximum context length", "413", "too many tokens", "Request too large") {
		return RecoveryCompact
	}

	// 2. Output truncated / max_tokens → escalate output limit
	if containsAny(msg, "max_tokens", "output truncated", "maximum output") {
		if state.TokenEscalations < maxTokenEscalations {
			state.TokenEscalations++
			return RecoveryEscalateTokens
		}
		return RecoveryAbort
	}

	// 3. Model overloaded / 529 / 503 → fallback to cheaper model
	if containsAny(msg, "529", "overloaded", "503", "service unavailable", "capacity") {
		if state.ModelFallbacks < maxModelFallbacks {
			state.ModelFallbacks++
			return RecoveryFallbackModel
		}
		return RecoveryAbort
	}

	// 4. Connection / timeout / 5xx transient errors → retry
	if containsAny(msg, "timeout", "connection reset", "connection refused", "EOF", "502", "504") {
		if state.Retries < maxRetries {
			state.Retries++
			return RecoveryRetry
		}
		return RecoveryAbort
	}

	// 5. Rate limit / 429 → retry (with the assumption the caller backs off)
	if containsAny(msg, "429", "rate limit", "throttl") {
		if state.Retries < maxRetries {
			state.Retries++
			return RecoveryRetry
		}
		return RecoveryAbort
	}

	return RecoveryAbort
}

func containsAny(s string, substrs ...string) bool {
	lower := strings.ToLower(s)
	for _, sub := range substrs {
		if strings.Contains(lower, strings.ToLower(sub)) {
			return true
		}
	}
	return false
}
