package tools

import "fmt"

func init_todo_write(r *Registry) {
	r.tools["todo_write"] = Tool{
		Name: "todo_write",
		Description: `Create or update the task list for the current session. Use this to track progress and signal the plan to the user.

When to use:
- Any task with 3+ distinct steps.
- The user gave a numbered or comma-separated list of things to do.
- Multi-file refactors, migrations, or feature work with several sub-parts.
- You want to show the user you've understood the scope.

When NOT to use:
- Single trivial tasks (add a comment, rename one variable).
- Pure Q&A or explanations.

Rules:
- Exactly ONE item should be in_progress at any time. Mark items completed the moment they're done — do not batch completions.
- Never mark something completed while tests are failing, implementation is partial, or a blocker exists.
- If a task becomes irrelevant, remove it from the list entirely rather than leaving it pending.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"todos": map[string]interface{}{
					"type": "array",
					"items": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"id":         map[string]interface{}{"type": "string", "description": "Unique task ID."},
							"content":    map[string]interface{}{"type": "string", "description": "Imperative form: 'Run tests', 'Add config'."},
							"activeForm": map[string]interface{}{"type": "string", "description": "Present-continuous form shown while running: 'Running tests', 'Adding config'."},
							"status":     map[string]interface{}{"type": "string", "description": "pending | in_progress | completed | cancelled"},
						},
						"required": []string{"id", "content", "status"},
					},
					"description": "Full desired state of the todo list.",
				},
			},
			"required": []string{"todos"},
		},
	}
}

func (r *Registry) todoWrite(args map[string]interface{}) ExecutionResult {
	todosRaw, ok := args["todos"].([]interface{})
	if !ok {
		return ExecutionResult{Error: "todos must be an array"}
	}

	var todos []TodoItem
	for _, t := range todosRaw {
		item, ok := t.(map[string]interface{})
		if !ok {
			continue
		}
		todos = append(todos, TodoItem{
			ID:         str(item, "id"),
			Content:    str(item, "content"),
			ActiveForm: str(item, "activeForm"),
			Status:     str(item, "status"),
		})
	}
	r.Todos = todos

	var out string
	for _, t := range todos {
		marker := "[ ]"
		display := t.Content
		switch t.Status {
		case "in_progress":
			marker = "[~]"
			if t.ActiveForm != "" {
				display = t.ActiveForm
			}
		case "completed":
			marker = "[x]"
		case "cancelled":
			marker = "[-]"
		}
		out += fmt.Sprintf("%s %s: %s\n", marker, t.ID, display)
	}
	return ExecutionResult{Output: out}
}
