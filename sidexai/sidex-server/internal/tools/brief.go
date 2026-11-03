package tools

func init_brief(r *Registry) {
	r.tools["brief"] = Tool{
		Name: "brief",
		Description: `Set a short status message (3-5 words) displayed in the IDE while you work. Use this at the START of each significant action to keep the user informed of progress without verbose output.

Good examples: "Fixing auth middleware", "Running test suite", "Analyzing dependencies". Call this frequently during autonomous/proactive work — the user sees this as your current activity indicator.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"message": map[string]interface{}{"type": "string", "description": "3-5 word progress summary."},
			},
			"required": []string{"message"},
		},
	}
}

func (r *Registry) brief(args map[string]interface{}) ExecutionResult {
	message := str(args, "message")
	if message == "" {
		return ExecutionResult{Error: "message is required"}
	}
	return ExecutionResult{Output: "BRIEF:" + message}
}
