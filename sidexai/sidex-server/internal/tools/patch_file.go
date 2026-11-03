package tools

import (
	"fmt"
	"os/exec"
	"strings"
)

func init_patch_file(r *Registry) {
	r.tools["patch_file"] = Tool{
		Name: "patch_file",
		Description: `Apply a unified diff patch to a file using the system 'patch' command. Use this ONLY when you have an actual unified diff (e.g., the user pasted one, or you got it from git diff) and want to apply it as-is.

Prefer edit_file or multi_edit for virtually all file modifications — they are more reliable and produce clearer diffs. Only use patch_file when you have pre-formatted patch content that would be tedious to decompose into individual edits.`,
		Dangerous: true,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":  map[string]interface{}{"type": "string", "description": "File to patch."},
				"patch": map[string]interface{}{"type": "string", "description": "Unified diff content."},
			},
			"required": []string{"path", "patch"},
		},
	}
}

func (r *Registry) patchFile(args map[string]interface{}) ExecutionResult {
	path := r.resolvePath(str(args, "path"))
	patch := str(args, "patch")
	if patch == "" {
		return ExecutionResult{Error: "patch content is required"}
	}

	cmd := exec.Command("patch", "-p0", path)
	cmd.Stdin = strings.NewReader(patch)
	cmd.Dir = r.cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ExecutionResult{Error: fmt.Sprintf("patch failed: %s\n%s", err, string(out))}
	}
	return ExecutionResult{Output: fmt.Sprintf("patched %s\n%s", path, string(out))}
}
