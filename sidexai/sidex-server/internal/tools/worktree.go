package tools

import (
	"crypto/rand"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func init_worktree(r *Registry) {
	r.tools["enter_worktree"] = Tool{
		Name: "enter_worktree",
		Description: `Create an isolated git worktree for safe experimentation. All subsequent tool calls operate in the worktree's directory — changes don't touch the main branch until explicitly merged via exit_worktree.

Use this before risky refactors, prototype attempts, or anything you might want to discard entirely. A new branch is created automatically. Call exit_worktree(action='merge') to bring changes back, or exit_worktree(action='discard') to throw them away.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"branch": map[string]interface{}{"type": "string", "description": "Optional branch name suffix. Auto-generated if empty."},
			},
		},
	}
	r.tools["exit_worktree"] = Tool{
		Name:        "exit_worktree",
		Description: `Leave the current worktree session and return to the original working directory. Use action='merge' to merge the worktree branch back into your original branch (no-ff merge), or action='discard' to delete the worktree branch and throw away all changes. The worktree directory is cleaned up automatically.`,
		Dangerous:   true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"action": map[string]interface{}{"type": "string", "description": "'merge' to merge back, 'discard' to throw away changes."},
			},
			"required": []string{"action"},
		},
	}
	r.tools["list_worktrees"] = Tool{
		Name:        "list_worktrees",
		Description: `List all git worktrees in the current repository. Use this to check what worktrees exist, whether you're already in one, or to find worktree paths for debugging. Shows the active session if one is open.`,
		Parameters: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}
}

func worktreeID() string {
	ts := time.Now().Format("20060102-150405")
	b := make([]byte, 4)
	rand.Read(b)
	return fmt.Sprintf("%s-%x", ts, b)
}

func isGitRepo(dir string) bool {
	cmd := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = dir
	out, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

func gitCurrentBranch(dir string) string {
	cmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = dir
	out, _ := cmd.Output()
	return strings.TrimSpace(string(out))
}

func (r *Registry) enterWorktree(args map[string]interface{}) ExecutionResult {
	if r.Worktree != nil {
		return ExecutionResult{Error: fmt.Sprintf("already in a worktree session (branch %s at %s) — exit first", r.Worktree.Branch, r.Worktree.WorktreeCwd)}
	}

	if !isGitRepo(r.cwd) {
		return ExecutionResult{Error: "current directory is not inside a git repository"}
	}

	id := worktreeID()
	suffix := str(args, "branch")
	branch := "sidex/wt-" + id
	if suffix != "" {
		branch = "sidex/wt-" + suffix + "-" + id
	}

	wtDir := filepath.Join(os.TempDir(), "sidex-worktrees", id)
	if err := os.MkdirAll(filepath.Dir(wtDir), 0o755); err != nil {
		return ExecutionResult{Error: fmt.Sprintf("cannot create worktree parent dir: %s", err)}
	}

	cmd := exec.Command("git", "worktree", "add", wtDir, "-b", branch)
	cmd.Dir = r.cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ExecutionResult{Error: fmt.Sprintf("git worktree add failed: %s\n%s", err, out)}
	}

	origCwd := r.cwd
	r.Worktree = &WorktreeState{
		OriginalCwd: origCwd,
		WorktreeCwd: wtDir,
		Branch:      branch,
	}
	r.cwd = wtDir

	return ExecutionResult{Output: fmt.Sprintf(
		"Worktree created.\n  branch:   %s\n  path:     %s\n  original: %s\n\nAll tool calls now operate in the worktree. Use exit_worktree to merge or discard.",
		branch, wtDir, origCwd,
	)}
}

func (r *Registry) exitWorktree(args map[string]interface{}) ExecutionResult {
	if r.Worktree == nil {
		return ExecutionResult{Error: "not currently in a worktree session"}
	}

	action := str(args, "action")
	if action != "merge" && action != "discard" {
		return ExecutionResult{Error: "action must be 'merge' or 'discard'"}
	}

	wt := r.Worktree
	r.cwd = wt.OriginalCwd
	r.Worktree = nil

	var result strings.Builder

	if action == "merge" {
		origBranch := gitCurrentBranch(wt.OriginalCwd)

		cmd := exec.Command("git", "merge", "--no-ff", wt.Branch, "-m", fmt.Sprintf("Merge worktree branch %s", wt.Branch))
		cmd.Dir = wt.OriginalCwd
		out, err := cmd.CombinedOutput()
		if err != nil {
			result.WriteString(fmt.Sprintf("⚠ merge failed (branch preserved): %s\n%s\n", err, out))
			result.WriteString(fmt.Sprintf("You can manually merge: cd %s && git merge %s\n", wt.OriginalCwd, wt.Branch))
			cleanupWorktree(wt.OriginalCwd, wt.WorktreeCwd)
			return ExecutionResult{Output: result.String()}
		}
		result.WriteString(fmt.Sprintf("Merged %s into %s.\n%s\n", wt.Branch, origBranch, out))
	} else {
		result.WriteString(fmt.Sprintf("Discarding worktree branch %s.\n", wt.Branch))
	}

	cleanupWorktree(wt.OriginalCwd, wt.WorktreeCwd)

	if action == "discard" {
		cmd := exec.Command("git", "branch", "-D", wt.Branch)
		cmd.Dir = wt.OriginalCwd
		out, _ := cmd.CombinedOutput()
		result.WriteString(fmt.Sprintf("Deleted branch %s.\n%s", wt.Branch, out))
	}

	result.WriteString(fmt.Sprintf("Working directory restored to %s.", wt.OriginalCwd))
	return ExecutionResult{Output: result.String()}
}

func cleanupWorktree(repoDir, wtDir string) {
	cmd := exec.Command("git", "worktree", "remove", "--force", wtDir)
	cmd.Dir = repoDir
	cmd.CombinedOutput()
	os.RemoveAll(wtDir)
}

func (r *Registry) listWorktrees(args map[string]interface{}) ExecutionResult {
	dir := r.cwd
	if r.Worktree != nil {
		dir = r.Worktree.OriginalCwd
	}

	if !isGitRepo(dir) {
		return ExecutionResult{Error: "not inside a git repository"}
	}

	cmd := exec.Command("git", "worktree", "list")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ExecutionResult{Error: fmt.Sprintf("git worktree list failed: %s\n%s", err, out)}
	}

	var result strings.Builder
	result.WriteString(string(out))
	if r.Worktree != nil {
		result.WriteString(fmt.Sprintf("\n(active session: branch %s at %s)", r.Worktree.Branch, r.Worktree.WorktreeCwd))
	}
	return ExecutionResult{Output: result.String()}
}
