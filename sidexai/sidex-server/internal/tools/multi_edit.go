package tools

import (
	"fmt"
	"os"
	"strings"
)

func init_multi_edit(r *Registry) {
	r.tools["multi_edit"] = Tool{
		Name: "multi_edit",
		Description: `Apply multiple independent find/replace edits to a single file in one atomic operation.

Usage:
- Prefer this over several edit_file calls to the same file; it's atomic and faster.
- You MUST have read the file at least once this session.
- Each entry has ` + "`old`" + ` and ` + "`new`" + ` strings. ` + "`old`" + ` must match the file exactly (including whitespace) and must be unique at the point it is applied.
- Edits are applied in order, so later edits can reference text produced by earlier edits.
- The operation is ALL-OR-NOTHING: if any edit fails to match, nothing is written and the tool reports exactly which edits failed so you can correct them.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":  map[string]interface{}{"type": "string", "description": "Absolute or cwd-relative path."},
				"edits": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object", "properties": map[string]interface{}{"old": map[string]interface{}{"type": "string"}, "new": map[string]interface{}{"type": "string"}}, "required": []string{"old", "new"}}, "description": "Array of {old, new} pairs applied in order."},
			},
			"required": []string{"path", "edits"},
		},
	}
}

func (r *Registry) multiEdit(args map[string]interface{}) ExecutionResult {
	path, perr := r.resolvePathChecked(str(args, "path"))
	if perr != nil {
		return ExecutionResult{Error: perr.Error()}
	}
	r.AutoCheckpoint(str(args, "path"))

	// Soft guard: warn when test files are edited before any source change.
	testWarning := r.testFileGuard(path, "modifying")

	sandboxed := r.Sandbox != nil && r.Sandbox.Active

	// Same safety contract as edit_file: require a prior read and reject
	// stale writes (skip when sandboxed — files live inside the container).
	if !sandboxed {
		if err := r.checkStale(path); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	}

	var content string
	if sandboxed {
		data, err := r.Sandbox.ReadFile(path)
		if err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		content = data
	} else {
		data, err := os.ReadFile(path)
		if err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		content = string(data)
	}

	editsRaw, ok := args["edits"].([]interface{})
	if !ok {
		return ExecutionResult{Error: "edits must be an array of {old, new} objects"}
	}
	if len(editsRaw) == 0 {
		return ExecutionResult{Error: "edits array is empty"}
	}

	// Apply all edits to an in-memory copy. ALL must succeed or nothing is
	// written ("atomic" as promised by the tool description).
	updated := content
	var failures []string
	applied := 0
	for i, e := range editsRaw {
		edit, ok := e.(map[string]interface{})
		if !ok {
			failures = append(failures, fmt.Sprintf("edit %d: not an object", i+1))
			continue
		}
		old := str(edit, "old")
		new := str(edit, "new")
		if old == "" {
			failures = append(failures, fmt.Sprintf("edit %d: old is empty", i+1))
			continue
		}
		if old == new {
			failures = append(failures, fmt.Sprintf("edit %d: old and new are identical", i+1))
			continue
		}
		n := strings.Count(updated, old)
		switch {
		case n == 0:
			failures = append(failures, fmt.Sprintf("edit %d: old string not found: %s", i+1, truncate(old, 120)))
		case n > 1:
			failures = append(failures, fmt.Sprintf("edit %d: old string matches %d locations — provide a larger, unique snippet: %s", i+1, n, truncate(old, 120)))
		default:
			updated = strings.Replace(updated, old, new, 1)
			applied++
		}
	}

	if len(failures) > 0 {
		return ExecutionResult{Error: fmt.Sprintf(
			"multi_edit is atomic: %d of %d edits failed, so NOTHING was written. Fix these and retry:\n%s",
			len(failures), len(editsRaw), strings.Join(failures, "\n"))}
	}

	if sandboxed {
		if err := r.Sandbox.WriteFile(path, updated); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	} else {
		if err := os.WriteFile(path, []byte(updated), 0644); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	}
	r.trackRead(path)
	return ExecutionResult{Output: fmt.Sprintf("applied %d edits to %s", applied, path) + testWarning}
}
