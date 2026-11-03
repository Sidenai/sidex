package tools

import (
	"fmt"
	"os"
	"path/filepath"
)

func init_write_file(r *Registry) {
	r.tools["write_file"] = Tool{
		Name: "write_file",
		Description: `Create a new file or completely overwrite an existing one.

Usage:
- Prefer edit_file or multi_edit for changes to files that already exist. Only use write_file when you need to create a brand-new file or when the file is tiny and replacing the whole thing is clearly simpler.
- If the file already exists you MUST have read it at least once this session. Writing over an unread file will be rejected.
- Parent directories are created automatically.
- Do not add explanatory comments to files you create unless the logic is non-obvious. Match the project's existing style.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":    map[string]interface{}{"type": "string", "description": "Absolute or cwd-relative path."},
				"content": map[string]interface{}{"type": "string", "description": "Full file contents to write."},
			},
			"required": []string{"path", "content"},
		},
	}
}

func (r *Registry) writeFile(args map[string]interface{}) ExecutionResult {
	path, perr := r.resolvePathChecked(str(args, "path"))
	if perr != nil {
		return ExecutionResult{Error: perr.Error()}
	}
	content := str(args, "content")

	// Soft guard: warn (don't block) when a test file is written before any
	// source change. See testFileGuard for the shared policy.
	testWarning := r.testFileGuard(path, "writing")

	// If sandbox active, write inside container
	if r.Sandbox != nil && r.Sandbox.Active {
		// Mirror the local overwrite protection: require a prior read before
		// blind-overwriting an existing file inside the sandbox.
		if _, tracked := r.readState[path]; !tracked {
			if existing, err := r.Sandbox.ReadFile(path); err == nil && existing != "" {
				return ExecutionResult{Error: fmt.Sprintf("%s already exists in the sandbox — read it with read_file before overwriting", path)}
			}
		}
		if err := r.Sandbox.WriteFile(path, content); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
		r.trackRead(path)
		return ExecutionResult{Output: fmt.Sprintf("wrote %d bytes to %s (sandbox)", len(content), path) + testWarning}
	}

	if _, err := os.Stat(path); err == nil {
		r.AutoCheckpoint(str(args, "path"))
		if err := r.checkStale(path); err != nil {
			return ExecutionResult{Error: err.Error()}
		}
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return ExecutionResult{Error: err.Error()}
	}
	r.trackRead(path)
	return ExecutionResult{Output: fmt.Sprintf("wrote %d bytes to %s", len(content), path) + testWarning}
}
