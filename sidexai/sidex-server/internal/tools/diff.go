package tools

import "os/exec"

func init_diff(r *Registry) {
	r.tools["diff"] = Tool{
		Name:        "diff",
		Description: `Show the full git diff of all uncommitted changes against HEAD for a repository. Use this to review everything that has changed in the working directory at once. For per-file diffs, use git_diff_file instead. Output is standard unified diff format.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{"type": "string", "description": "Repository path (default cwd)."},
			},
		},
	}
}

func (r *Registry) diff(args map[string]interface{}) ExecutionResult {
	path := r.resolvePath(strOr(args, "path", "."))
	cmd := exec.Command("git", "diff", "HEAD")
	cmd.Dir = path
	out, _ := cmd.CombinedOutput()
	if len(out) == 0 {
		return ExecutionResult{Output: "no changes detected"}
	}
	return ExecutionResult{Output: string(out)}
}
