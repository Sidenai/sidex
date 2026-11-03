package compress

// EstimateMessagesTokens returns a fast, approximate token count for a slice
// of messages. It counts content plus tool-call arguments.
func EstimateMessagesTokens(messages []Message) int {
	total := 0
	for _, m := range messages {
		total += EstimateTokens(m.Content)
		for _, tc := range m.ToolCalls {
			total += EstimateTokens(tc.Function.Arguments)
		}
	}
	return total
}

// FixedOverheadTokens approximates the per-request tokens that are NOT in the
// message list: system prompt (~5k) plus tool definitions (~15k). Compression
// thresholds must account for them or every layer fires ~10% too late.
const FixedOverheadTokens = 20000

// RunPipeline applies all 5 compression layers sequentially before a model
// call. Cheapest layers run first; each layer re-checks the token count
// and only activates when the budget threshold for that layer is exceeded.
//
// Layers 1-4 are free (no API calls). Layer 5 (Autocompact) costs no API
// calls either — it's a deterministic summary that's the last resort.
func RunPipeline(messages []Message, maxTokens int) []Message {
	if len(messages) == 0 {
		return messages
	}

	// Reserve headroom for the system prompt and tool definitions.
	if maxTokens > FixedOverheadTokens*2 {
		maxTokens -= FixedOverheadTokens
	}

	currentTokens := EstimateMessagesTokens(messages)
	if currentTokens <= int(float64(maxTokens)*0.5) {
		return messages
	}

	// Layer 1: Budget Reduction — trim tool outputs exceeding per-output budget
	messages = BudgetReduce(messages, maxTokens)

	// Layer 2: Snip — hard-truncate large individual messages with head/tail
	if EstimateMessagesTokens(messages) > int(float64(maxTokens)*0.6) {
		messages = Snip(messages, maxTokens)
	}

	// Layer 3: Microcompact — replace old tool outputs with 1-line summaries
	if EstimateMessagesTokens(messages) > int(float64(maxTokens)*0.7) {
		messages = Microcompact(messages)
	}

	// Layer 4: Collapse — merge sequential same-role messages
	if EstimateMessagesTokens(messages) > int(float64(maxTokens)*0.8) {
		messages = Collapse(messages)
	}

	// Layer 5: Autocompact — full conversation summary (deterministic, last resort)
	if EstimateMessagesTokens(messages) > int(float64(maxTokens)*0.9) {
		compacted, did := AutoCompactIfNeeded(messages, int(float64(maxTokens)*0.9), EstimateTokens)
		if did {
			messages = compacted
		}
	}

	return messages
}
