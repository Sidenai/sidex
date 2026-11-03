package tools

import (
	"fmt"
	"strings"
)

func init_tool_search(r *Registry) {
	r.tools["tool_search"] = Tool{
		Name: "tool_search",
		Description: `Search for available tools by keyword. Returns matching tools with their names and descriptions.

Use this when you're unsure which tool to use for a specific task. Search by what you want to do (e.g., "find files", "run command", "edit code").`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string", "description": "Search keyword or phrase."},
			},
			"required": []string{"query"},
		},
	}
}

func (r *Registry) toolSearch(args map[string]interface{}) ExecutionResult {
	query := strings.ToLower(str(args, "query"))
	if query == "" {
		return ExecutionResult{Error: "query is required"}
	}

	var matches []string
	for _, tool := range r.List() {
		if strings.Contains(strings.ToLower(tool.Name), query) ||
			strings.Contains(strings.ToLower(tool.Description), query) {
			desc := tool.Description
			if len(desc) > 100 {
				desc = desc[:100] + "..."
			}
			matches = append(matches, fmt.Sprintf("- %s: %s", tool.Name, desc))
		}
	}

	if len(matches) == 0 {
		return ExecutionResult{Output: fmt.Sprintf("No tools found matching %q. Available tools: %s", query, r.toolNames())}
	}
	return ExecutionResult{Output: fmt.Sprintf("Found %d matching tools:\n%s", len(matches), strings.Join(matches, "\n"))}
}

func (r *Registry) toolNames() string {
	var names []string
	for _, t := range r.List() {
		names = append(names, t.Name)
	}
	return strings.Join(names, ", ")
}
