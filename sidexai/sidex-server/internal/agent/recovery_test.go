package agent

import (
	"fmt"
	"testing"
)

func TestRecoverFromError_PromptTooLong(t *testing.T) {
	state := &RecoveryState{}
	for _, msg := range []string{
		"prompt is too long",
		"provider API error 413: Request too large",
		"maximum context length exceeded",
	} {
		action := RecoverFromError(fmt.Errorf("%s", msg), state)
		if action != RecoveryCompact {
			t.Errorf("error %q → %s, want compact", msg, action)
		}
	}
}

func TestRecoverFromError_MaxTokens(t *testing.T) {
	state := &RecoveryState{}
	action := RecoverFromError(fmt.Errorf("max_tokens limit reached"), state)
	if action != RecoveryEscalateTokens {
		t.Errorf("got %s, want escalate_tokens", action)
	}
	if state.TokenEscalations != 1 {
		t.Errorf("escalations = %d, want 1", state.TokenEscalations)
	}

	// Exhaust the budget.
	for i := 0; i < maxTokenEscalations; i++ {
		RecoverFromError(fmt.Errorf("max_tokens"), state)
	}
	action = RecoverFromError(fmt.Errorf("max_tokens"), state)
	if action != RecoveryAbort {
		t.Errorf("after budget exhausted, got %s, want abort", action)
	}
}

func TestRecoverFromError_ModelOverloaded(t *testing.T) {
	state := &RecoveryState{}
	action := RecoverFromError(fmt.Errorf("provider API error 529: model overloaded"), state)
	if action != RecoveryFallbackModel {
		t.Errorf("got %s, want fallback_model", action)
	}

	// Exhaust fallback budget.
	for i := 0; i < maxModelFallbacks; i++ {
		RecoverFromError(fmt.Errorf("529 overloaded"), state)
	}
	action = RecoverFromError(fmt.Errorf("529 overloaded"), state)
	if action != RecoveryAbort {
		t.Errorf("after fallback exhausted, got %s, want abort", action)
	}
}

func TestRecoverFromError_Timeout(t *testing.T) {
	state := &RecoveryState{}
	action := RecoverFromError(fmt.Errorf("connection timeout"), state)
	if action != RecoveryRetry {
		t.Errorf("got %s, want retry", action)
	}
	if state.Retries != 1 {
		t.Errorf("retries = %d, want 1", state.Retries)
	}

	// Second retry.
	action = RecoverFromError(fmt.Errorf("connection timeout"), state)
	if action != RecoveryRetry {
		t.Errorf("got %s, want retry", action)
	}

	// Exhausted.
	action = RecoverFromError(fmt.Errorf("connection timeout"), state)
	if action != RecoveryAbort {
		t.Errorf("after retries exhausted, got %s, want abort", action)
	}
}

func TestRecoverFromError_RateLimit(t *testing.T) {
	state := &RecoveryState{}
	action := RecoverFromError(fmt.Errorf("429 rate limit exceeded"), state)
	if action != RecoveryRetry {
		t.Errorf("got %s, want retry", action)
	}
}

func TestRecoverFromError_UnknownError(t *testing.T) {
	state := &RecoveryState{}
	action := RecoverFromError(fmt.Errorf("some completely unknown error"), state)
	if action != RecoveryAbort {
		t.Errorf("got %s, want abort", action)
	}
}

func TestRecoverFromError_Nil(t *testing.T) {
	state := &RecoveryState{}
	action := RecoverFromError(nil, state)
	if action != RecoveryNone {
		t.Errorf("got %s, want none", action)
	}
}

func TestRecoveryActionString(t *testing.T) {
	cases := map[RecoveryAction]string{
		RecoveryNone:           "none",
		RecoveryRetry:          "retry",
		RecoveryCompact:        "compact",
		RecoveryEscalateTokens: "escalate_tokens",
		RecoveryFallbackModel:  "fallback_model",
		RecoveryAbort:          "abort",
	}
	for action, want := range cases {
		if got := action.String(); got != want {
			t.Errorf("%d.String() = %q, want %q", int(action), got, want)
		}
	}
}
