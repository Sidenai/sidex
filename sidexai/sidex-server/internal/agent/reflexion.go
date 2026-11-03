package agent

import (
	"fmt"
	"strings"
)

const maxReflexionAttempts = 3

// DetectTestFailure checks if a tool result looks like a failed test run.
// Supports pytest, go test, jest, mocha, cargo test, and similar frameworks.
func DetectTestFailure(toolName, output string) bool {
	if toolName != "shell" {
		return false
	}

	lower := strings.ToLower(output)

	if strings.Contains(lower, "exit code:") || strings.Contains(output, "exit status") {
		testIndicators := []string{
			"failed", "failure", "fail",
			"error", "errors",
			"pytest", "test_", "_test.go",
			"jest", "mocha",
			"cargo test",
		}
		for _, ind := range testIndicators {
			if strings.Contains(lower, ind) {
				return true
			}
		}
	}

	failurePatterns := []string{
		"FAILED",
		"FAIL\t",
		"failures=",
		"tests failed",
		"test failed",
		"AssertionError",
		"assertion failed",
		"expected",
		"--- FAIL:",
		"FAILURES",
		"Error: expect(",
		"✗",
		"✕",
	}
	for _, pattern := range failurePatterns {
		if strings.Contains(output, pattern) {
			return true
		}
	}

	return false
}

// BuildReflexionPrompt creates a prompt that forces the agent to analyze
// a test failure before retrying. This implements the reflexion pattern:
// self-critique on failure to avoid repeating the same mistake.
func BuildReflexionPrompt(testOutput string, attempt int) string {
	truncated := truncateForReflexion(testOutput, 2000)
	return fmt.Sprintf(`## Reflexion Required (Attempt %d/%d)

The tests failed. Before trying again, analyze:
1. WHAT specific test(s) failed?
2. WHY did they fail? (read the error carefully)
3. Was your previous fix incorrect or incomplete?
4. What DIFFERENT approach should you try?

Test output:
%s

Think step by step about the root cause before making changes.`, attempt, maxReflexionAttempts, truncated)
}

// truncateForReflexion keeps the most relevant parts of test output within a
// character budget: the first portion (setup/context) and the last portion
// (actual failure messages and summaries).
func truncateForReflexion(output string, maxChars int) string {
	if len(output) <= maxChars {
		return output
	}
	head := maxChars * 2 / 5
	tail := maxChars * 3 / 5
	return output[:head] +
		"\n\n... [truncated] ...\n\n" +
		output[len(output)-tail:]
}

// ReflexionTracker tracks test failure attempts within a single agent loop run.
type ReflexionTracker struct {
	attempts int
}

// NewReflexionTracker creates a new tracker.
func NewReflexionTracker() *ReflexionTracker {
	return &ReflexionTracker{}
}

// RecordFailure increments the attempt counter and returns whether a reflexion
// prompt should be injected (true if under the max attempts threshold).
func (rt *ReflexionTracker) RecordFailure() (shouldReflect bool) {
	rt.attempts++
	return rt.attempts < maxReflexionAttempts
}

// Attempt returns the current attempt number.
func (rt *ReflexionTracker) Attempt() int {
	return rt.attempts
}

// Reset clears the tracker (e.g. when tests pass).
func (rt *ReflexionTracker) Reset() {
	rt.attempts = 0
}
