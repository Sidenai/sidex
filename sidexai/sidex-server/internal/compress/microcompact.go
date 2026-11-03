package compress

import (
	"fmt"
	"strings"
)

// Microcompact is Layer 3 of the compression pipeline. It replaces tool result
// content older than the last keepRecentTurns turn-pairs with a deterministic
// 1-line summary. No AI call — just preserves what tool was called and a hint
// of the result. This is a free operation.
func Microcompact(messages []Message) []Message {
	const keepRecentTurns = 3

	turnBoundary := findTurnBoundary(messages, keepRecentTurns)

	result := make([]Message, len(messages))
	copy(result, messages)

	for i := 0; i < turnBoundary; i++ {
		m := &result[i]
		if m.Role != "tool" {
			continue
		}
		if len(m.Content) < 100 {
			continue
		}

		firstLine := firstNonEmptyLine(m.Content)
		if len(firstLine) > 80 {
			firstLine = firstLine[:80] + "…"
		}

		name := m.Name
		if name == "" {
			name = "unknown"
		}

		m.Content = fmt.Sprintf("[tool: %s] %s (%d chars original)", name, firstLine, len(m.Content))
	}

	return result
}

// findTurnBoundary returns the message index where the last N assistant turns begin.
func findTurnBoundary(messages []Message, keepTurns int) int {
	turnCount := 0
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "assistant" {
			turnCount++
			if turnCount >= keepTurns {
				return i
			}
		}
	}
	return 0
}

func firstNonEmptyLine(s string) string {
	for _, line := range strings.SplitN(s, "\n", 10) {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			return trimmed
		}
	}
	return "(empty)"
}
