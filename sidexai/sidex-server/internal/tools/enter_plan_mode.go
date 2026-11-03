package tools

func init_enter_plan_mode(r *Registry) {
	r.tools["enter_plan_mode"] = Tool{
		Name: "enter_plan_mode",
		Description: `Switch to Plan mode for research and design before making changes. In Plan mode, only read-only tools are available (read files, search, grep, git status) — no writes, no shell commands that mutate state.

Use this when the task is complex, ambiguous, or has multiple valid approaches and you want to propose a plan before executing. Call exit_plan_mode when you're ready to start implementing.`,
		Parameters: map[string]interface{}{
			"type": "object", "properties": map[string]interface{}{},
		},
	}
}

func (r *Registry) enterPlanMode(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "MODE_SWITCH:plan"}
}
