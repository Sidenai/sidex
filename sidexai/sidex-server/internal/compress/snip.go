package compress

import (
	"fmt"
)

const snipThresholdTokens = 4000

// Snip is Layer 2 of the compression pipeline. For any single message whose
// content exceeds snipThresholdTokens, it hard-truncates to head+tail with a
// marker in between. The most recent user message and most recent assistant
// response are never snipped. This is a free operation (no API calls).
func Snip(messages []Message, maxTokens int) []Message {
	lastUser := -1
	lastAssistant := -1
	for i := len(messages) - 1; i >= 0; i-- {
		if lastUser < 0 && messages[i].Role == "user" {
			lastUser = i
		}
		if lastAssistant < 0 && messages[i].Role == "assistant" {
			lastAssistant = i
		}
		if lastUser >= 0 && lastAssistant >= 0 {
			break
		}
	}

	result := make([]Message, len(messages))
	copy(result, messages)

	for i := range result {
		if i == lastUser || i == lastAssistant {
			continue
		}
		content := result[i].Content
		if EstimateTokens(content) <= snipThresholdTokens {
			continue
		}

		headSize := 1500
		tailSize := 1500
		runes := []rune(content)
		if len(runes) <= headSize+tailSize {
			continue
		}

		snipped := len(runes) - headSize - tailSize
		result[i].Content = string(runes[:headSize]) +
			fmt.Sprintf("\n...[snipped %d chars]...\n", snipped) +
			string(runes[len(runes)-tailSize:])
	}

	return result
}
