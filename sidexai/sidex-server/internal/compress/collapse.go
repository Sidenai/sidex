package compress

import (
	"strings"
)

// Collapse is Layer 4 of the compression pipeline. It merges consecutive
// tool-result messages into a single message with combined content. User
// messages and the most recent assistant message are never collapsed.
// This is a free operation (no API calls).
func Collapse(messages []Message) []Message {
	if len(messages) < 2 {
		return messages
	}

	lastAssistant := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "assistant" {
			lastAssistant = i
			break
		}
	}

	result := make([]Message, 0, len(messages))
	for i, m := range messages {
		if i == lastAssistant {
			result = append(result, m)
			continue
		}
		if m.Role == "user" {
			result = append(result, m)
			continue
		}

		if len(result) > 0 && canCollapse(result[len(result)-1], m) {
			prev := &result[len(result)-1]
			var b strings.Builder
			b.WriteString(prev.Content)
			b.WriteString("\n---\n")
			b.WriteString(m.Content)
			prev.Content = b.String()
			continue
		}

		result = append(result, m)
	}

	return result
}

func canCollapse(prev, cur Message) bool {
	if prev.Role != cur.Role {
		return false
	}
	// Never collapse tool messages — each must retain its unique ToolCallID
	// to match the corresponding tool_use block in the assistant message.
	if prev.Role == "tool" {
		return false
	}
	return false
}
