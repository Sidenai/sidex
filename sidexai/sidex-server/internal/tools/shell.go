package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/sidex-ai/sidex-server/internal/compress"
)

func init_shell(r *Registry) {
	r.tools["shell"] = Tool{
		Name: "shell",
		Description: `Execute a shell command in the session's working directory and return its combined stdout/stderr.

Usage:
- Reserve this tool for actual system commands: running tests, building, invoking git beyond the dedicated git tools, running npm/pip/cargo, etc.
- Do NOT use shell to read files (use read_file), edit files (use edit_file/multi_edit), create files (use write_file), search files (use grep/glob), or discover the cwd (use cwd). Using dedicated tools makes changes reviewable in the IDE.
- Commands time out after "timeout" seconds (default 30, max 300). For longer-running commands use run_background instead so the call doesn't block the conversation.
- If you need to change directory, pass "working_directory" rather than chaining ` + "`cd X && ...`" + ` so the session cwd stays stable.
- working_directory must be a real directory. If it doesn't exist, the tool returns an error — do not keep retrying with variations. Ask the user which directory they meant.
- Quote paths that contain spaces. Use ` + "`&&`" + ` to chain dependent commands; use separate shell calls (or parallel calls) for independent commands.
- Never use interactive flags (e.g. ` + "`git rebase -i`" + `, ` + "`git add -i`" + `) — no TTY is attached.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"command":           map[string]interface{}{"type": "string", "description": "The command to execute. Passed to sh -c."},
				"timeout":           map[string]interface{}{"type": "integer", "description": "Seconds before the command is killed (default 30, max 300)."},
				"working_directory": map[string]interface{}{"type": "string", "description": "Directory to run in. Must exist. Defaults to the session cwd."},
			},
			"required": []string{"command"},
		},
	}
}

func (r *Registry) shell(args map[string]interface{}) ExecutionResult {
	command := str(args, "command")
	if command == "" {
		return ExecutionResult{Error: "command is required"}
	}
	timeoutSec := intOr(args, "timeout", 30)
	if timeoutSec > 300 {
		timeoutSec = 300
	}
	workDir := strOr(args, "working_directory", r.cwd)
	// Skip local path validation when sandbox is active (paths are inside the sandbox)
	if r.Sandbox == nil || !r.Sandbox.Active {
		if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
			return ExecutionResult{Error: fmt.Sprintf("working_directory %q does not exist on this server. Session cwd is %q. Try running this command with a working_directory that actually exists, or use pwd/ls to discover real directories first.", workDir, r.cwd)}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	var result string

	if r.Sandbox != nil && r.Sandbox.Active {
		// Route through sandbox — prepend cd to workdir for proper context
		sandboxCwd := r.Sandbox.WorkDir
		if wd := strOr(args, "working_directory", ""); wd != "" && wd != r.cwd {
			sandboxCwd = wd
		}
		// Prepend cd to ensure command runs in the right directory (graceful if dir doesn't exist yet)
		sandboxCommand := command
		if sandboxCwd != "" {
			sandboxCommand = fmt.Sprintf("cd %s 2>/dev/null || true; %s", sandboxCwd, command)
		}
		type execResult struct {
			stdout   string
			stderr   string
			exitCode int
			err      error
		}
		done := make(chan execResult, 1)
		go func() {
			stdout, stderr, code, err := r.Sandbox.Exec(sandboxCommand, "")
			done <- execResult{stdout, stderr, code, err}
		}()

		select {
		case <-ctx.Done():
			result = fmt.Sprintf("[timed out after %ds]", timeoutSec)
		case res := <-done:
			if res.err != nil {
				return ExecutionResult{Error: fmt.Sprintf("sandbox exec error: %v", res.err)}
			}
			result = res.stdout
			if res.stderr != "" {
				result += res.stderr
			}
			if res.exitCode != 0 {
				result += fmt.Sprintf("\nexit code: %d", res.exitCode)
			}
		}
	} else {
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "cmd", "/C", command)
		} else {
			cmd = exec.CommandContext(ctx, "sh", "-c", command)
		}
		cmd.Dir = workDir

		out, err := cmd.CombinedOutput()
		result = string(out)
		if ctx.Err() == context.DeadlineExceeded {
			result += fmt.Sprintf("\n[timed out after %ds]", timeoutSec)
		} else if err != nil {
			result += "\nexit code: " + err.Error()
		}
	}

	if result == "" {
		result = "(command produced no output)"
	}
	if len(result) > 100000 {
		result = compress.SummarizeToolOutput(result, 100000)
	}
	return ExecutionResult{Output: result}
}
