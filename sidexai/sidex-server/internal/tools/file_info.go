package tools

import (
	"fmt"
	"os"
)

func init_file_info(r *Registry) {
	r.tools["file_info"] = Tool{
		Name:        "file_info",
		Description: `Get metadata about a file or directory: size, permissions, modification time, and whether it's a directory. Use this to check if a file exists before reading, detect external modifications, or verify file sizes before processing. Lighter than read_file when you only need metadata.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{"type": "string", "description": "File or directory path."},
			},
			"required": []string{"path"},
		},
	}
}

func (r *Registry) fileInfo(args map[string]interface{}) ExecutionResult {
	path := r.resolvePath(str(args, "path"))

	// When sandbox is active, stat the file inside the sandbox
	if r.Sandbox != nil && r.Sandbox.Active {
		sandboxPath := str(args, "path")
		stdout, _, code, err := r.Sandbox.Exec(fmt.Sprintf("stat '%s' 2>&1 && echo IS_DIR:$(test -d '%s' && echo true || echo false)", sandboxPath, sandboxPath), "")
		if err != nil || code != 0 {
			return ExecutionResult{Error: fmt.Sprintf("stat %s: no such file or directory", sandboxPath)}
		}
		return ExecutionResult{Output: stdout}
	}

	info, err := os.Stat(path)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	return ExecutionResult{Output: fmt.Sprintf(
		"name: %s\nsize: %d\nmode: %s\nmodified: %s\nis_dir: %v",
		info.Name(), info.Size(), info.Mode(), info.ModTime().Format("2006-01-02 15:04:05"), info.IsDir(),
	)}
}
