package tools

func init_exit_plan_mode(r *Registry) {
	r.tools["exit_plan_mode"] = Tool{
		Name:        "exit_plan_mode",
		Description: `Request to leave Plan mode and start implementing. Pass your final plan in the "plan" parameter — the user is shown the plan and must APPROVE it before write tools are re-enabled. If the user rejects, you stay in Plan mode; refine the plan based on their feedback and try again. Only call this when your plan is concrete (specific files and changes), or when the user has already told you to proceed.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"plan": map[string]interface{}{
					"type":        "string",
					"description": "The final plan, as concise markdown (numbered steps with specific files/changes), shown to the user for approval.",
				},
			},
		},
	}
}

func (r *Registry) exitPlanMode(args map[string]interface{}) ExecutionResult {
	return ExecutionResult{Output: "MODE_SWITCH:agent"}
}
