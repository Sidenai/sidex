package tools

import (
	"fmt"
	"os/exec"
	"strings"
)

func init_git(r *Registry) {
	r.tools["git_status"] = Tool{
		Name:        "git_status",
		Description: `Show the current git branch and working tree status in short format. Use this to see which files are modified, staged, or untracked before committing. Also confirms what branch you're on. Output uses git's porcelain short format: M=modified, A=added, ??=untracked, D=deleted.`,
		Parameters: map[string]interface{}{
			"type": "object", "properties": map[string]interface{}{},
		},
	}

	r.tools["git_log"] = Tool{
		Name:        "git_log",
		Description: `Show recent commit history in one-line format with decorations. Use this to understand the project's recent changes, learn the commit message style before writing your own, or find a specific commit hash. Returns the N most recent commits (default 10).`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"count": map[string]interface{}{"type": "integer", "description": "Number of commits to show (default 10)."},
			},
		},
	}

	r.tools["git_commit"] = Tool{
		Name: "git_commit",
		Description: `Create a git commit. Only do this when the user explicitly asks — never auto-commit work in progress.

Rules:
- NEVER use --no-verify or skip hooks unless the user asked.
- NEVER commit .env, credentials, or other secrets. Warn if the user asks to.
- Draft the message based on the actual diff — explain the "why", not just the "what".
- If a hook fails, do NOT amend — fix the issue and create a new commit.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"message": map[string]interface{}{"type": "string", "description": "Commit message."},
				"files":   map[string]interface{}{"type": "string", "description": "Comma-separated files to stage, or '.' for all staged+tracked."},
			},
			"required": []string{"message"},
		},
	}

	r.tools["git_diff_file"] = Tool{
		Name:        "git_diff_file",
		Description: `Show the git diff for a specific file, or all uncommitted changes if no path is given. Use this to see exactly what changed before committing, to review your own edits, or to understand what the user modified. Output is standard unified diff format.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{"type": "string", "description": "File path, or omit for all changes."},
			},
		},
	}
}

func (r *Registry) gitStatus(args map[string]interface{}) ExecutionResult {
	cmd := exec.Command("git", "status", "--short", "--branch")
	cmd.Dir = r.cwd
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return ExecutionResult{Error: "not a git repo or git not available"}
	}
	return ExecutionResult{Output: string(out)}
}

func (r *Registry) gitLog(args map[string]interface{}) ExecutionResult {
	n := intOr(args, "count", 10)
	cmd := exec.Command("git", "log", fmt.Sprintf("-%d", n), "--oneline", "--decorate")
	cmd.Dir = r.cwd
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return ExecutionResult{Error: err.Error()}
	}
	return ExecutionResult{Output: string(out)}
}

func (r *Registry) gitCommit(args map[string]interface{}) ExecutionResult {
	message := str(args, "message")
	if message == "" {
		return ExecutionResult{Error: "commit message required"}
	}

	files := str(args, "files")
	if files == "" || files == "." {
		cmd := exec.Command("git", "add", "-A")
		cmd.Dir = r.cwd
		if out, err := cmd.CombinedOutput(); err != nil {
			return ExecutionResult{Error: string(out)}
		}
	} else {
		for _, f := range strings.Split(files, ",") {
			f = strings.TrimSpace(f)
			cmd := exec.Command("git", "add", f)
			cmd.Dir = r.cwd
			cmd.CombinedOutput()
		}
	}

	cmd := exec.Command("git", "commit", "-m", message)
	cmd.Dir = r.cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ExecutionResult{Error: string(out)}
	}
	return ExecutionResult{Output: string(out)}
}

func (r *Registry) gitDiffFile(args map[string]interface{}) ExecutionResult {
	file := str(args, "path")
	var cmd *exec.Cmd
	if file != "" {
		cmd = exec.Command("git", "diff", "--", file)
	} else {
		cmd = exec.Command("git", "diff")
	}
	cmd.Dir = r.cwd
	out, _ := cmd.CombinedOutput()
	if len(out) == 0 {
		return ExecutionResult{Output: "no changes"}
	}
	return ExecutionResult{Output: string(out)}
}
