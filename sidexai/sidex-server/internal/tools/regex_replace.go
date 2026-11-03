package tools

import (
	"fmt"
	"os"
	"regexp"
)

func init_regex_replace(r *Registry) {
	r.tools["regex_replace"] = Tool{
		Name: "regex_replace",
		Description: `Find-and-replace across a file using Go regex syntax. Supports capture group references ($1, $2, …) in the replacement string. Use this for bulk pattern-based transformations that edit_file/multi_edit can't express — e.g., renaming all occurrences of a pattern, updating import paths, or reformatting repeated structures.

Prefer edit_file for simple targeted changes. Only reach for regex_replace when the transformation is genuinely pattern-based. If no matches are found, reports "no matches found" and the file is unchanged.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":        map[string]interface{}{"type": "string", "description": "File path."},
				"pattern":     map[string]interface{}{"type": "string", "description": "Go regex pattern."},
				"replacement": map[string]interface{}{"type": "string", "description": "Replacement (supports $1 capture references)."},
			},
			"required": []string{"path", "pattern", "replacement"},
		},
	}
}

func (r *Registry) regexReplace(args map[string]interface{}) ExecutionResult {
	path := r.resolvePath(str(args, "path"))
	pattern := str(args, "pattern")
	replacement := str(args, "replacement")

	data, err := os.ReadFile(path)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return ExecutionResult{Error: "invalid regex: " + err.Error()}
	}

	content := string(data)
	result := re.ReplaceAllString(content, replacement)
	if result == content {
		return ExecutionResult{Output: "no matches found"}
	}

	matches := len(re.FindAllString(content, -1))
	if err := os.WriteFile(path, []byte(result), 0644); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: fmt.Sprintf("replaced %d matches in %s", matches, path)}
}
