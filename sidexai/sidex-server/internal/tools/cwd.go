package tools

import (
	"fmt"
	"os"
	"path/filepath"
)

func init_cwd(r *Registry) {
	r.tools["cwd"] = Tool{
		Name: "cwd",
		Description: `Return the session's current working directory. This is the SINGLE SOURCE OF TRUTH for where the server is operating.
MUST use this for: "what folder am I in", "what directory", "where are we", "pwd", or any orientation question. Call it ONCE — its answer is final. Do NOT follow it with pwd / ls / env shell commands.
The IDE may also have sent workspace folders in the system prompt under "# IDE context". Those are the user's workspace on their machine; the cwd returned here is what the server can actually read and write. If they differ, say so plainly and ask the user which one they want to operate on — do not keep probing.`,
		Parameters: map[string]interface{}{
			"type": "object", "properties": map[string]interface{}{},
		},
	}
}

func (r *Registry) getCwd(args map[string]interface{}) ExecutionResult {
	// When sandbox is active, report the sandbox working directory
	if r.Sandbox != nil && r.Sandbox.Active {
		return ExecutionResult{Output: fmt.Sprintf("cwd: %s\nabsolute: %s\nexists: true", r.Sandbox.WorkDir, r.Sandbox.WorkDir)}
	}
	info, err := os.Stat(r.cwd)
	exists := err == nil && info.IsDir()
	abs, _ := filepath.Abs(r.cwd)
	return ExecutionResult{Output: fmt.Sprintf("cwd: %s\nabsolute: %s\nexists: %v", r.cwd, abs, exists)}
}
