package tools

import "encoding/json"

func init_ask_user(r *Registry) {
	r.tools["ask_user"] = Tool{
		Name: "ask_user",
		Description: `Ask the user a clarifying question when you need input to proceed. Use this when a decision requires user preference, when you've narrowed options but can't determine the right one, or when requirements are ambiguous.

Present clear options when possible — the user can pick from a list rather than typing a freeform answer. Do NOT ask when you can figure it out from context, code, or docs. Investigate first, then ask only if genuinely stuck.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"question": map[string]interface{}{"type": "string", "description": "The question to ask the user."},
				"options": map[string]interface{}{
					"type":        "array",
					"description": "Optional list of choices to present.",
					"items": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"id":    map[string]interface{}{"type": "string"},
							"label": map[string]interface{}{"type": "string"},
						},
						"required": []string{"id", "label"},
					},
				},
				"allow_multiple": map[string]interface{}{"type": "boolean", "description": "If true, allow selecting multiple options (default false)."},
			},
			"required": []string{"question"},
		},
	}
}

func (r *Registry) askUser(args map[string]interface{}) ExecutionResult {
	question := str(args, "question")
	if question == "" {
		return ExecutionResult{Error: "question is required"}
	}

	payload := map[string]interface{}{
		"type":     "ask_user",
		"question": question,
	}

	if opts, ok := args["options"]; ok {
		payload["options"] = opts
	}

	payload["allow_multiple"] = boolOr(args, "allow_multiple", false)

	out, err := json.Marshal(payload)
	if err != nil {
		return ExecutionResult{Error: "failed to marshal question: " + err.Error()}
	}
	return ExecutionResult{Output: string(out)}
}
