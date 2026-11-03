package compress

// BudgetReduce is Layer 1 of the compression pipeline. It allocates a per-output
// token budget across all tool results, and trims older results that exceed it.
// Most recent tool results are kept at full size; older ones are compressed more
// aggressively. This is a free operation (no API calls).
func BudgetReduce(messages []Message, maxTokens int) []Message {
	totalBudget := int(float64(maxTokens) * 0.4)

	var toolResultIndices []int
	for i, m := range messages {
		if m.Role == "tool" {
			toolResultIndices = append(toolResultIndices, i)
		}
	}
	if len(toolResultIndices) == 0 {
		return messages
	}

	perResultBudget := totalBudget / len(toolResultIndices)
	if perResultBudget < 200 {
		perResultBudget = 200
	}

	protectedCount := 3
	if protectedCount > len(toolResultIndices) {
		protectedCount = len(toolResultIndices)
	}
	protectedStart := len(toolResultIndices) - protectedCount

	result := make([]Message, len(messages))
	copy(result, messages)

	for rank, idx := range toolResultIndices {
		m := &result[idx]
		tokens := EstimateTokens(m.Content)
		if tokens <= perResultBudget || rank >= protectedStart {
			continue
		}

		ageFactor := 1.0 - (float64(rank) / float64(len(toolResultIndices)))
		adjustedBudget := int(float64(perResultBudget) * (0.5 + 0.5*ageFactor))
		if adjustedBudget < 100 {
			adjustedBudget = 100
		}

		maxChars := adjustedBudget * 3
		m.Content = SummarizeToolOutput(m.Content, maxChars)
	}

	return result
}
