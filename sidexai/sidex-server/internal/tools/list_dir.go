package tools

import (
	"fmt"
	"os"
	"strings"
)

func init_list_dir(r *Registry) {
	r.tools["list_dir"] = Tool{
		Name: "list_dir",
		Description: `List the immediate entries of a directory (non-recursive) with type, size, and name. Use this for a quick glance at a folder's contents. Shows file vs directory, byte sizes, and names.

For recursive directory exploration, use tree instead. For finding files by pattern, use glob or search_files.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{"type": "string", "description": "Directory path (absolute or cwd-relative)."},
			},
			"required": []string{"path"},
		},
	}
}

func (r *Registry) listDir(args map[string]interface{}) ExecutionResult {
	// When sandbox is active, list inside the sandbox
	if r.Sandbox != nil && r.Sandbox.Active {
		dirPath := str(args, "path")
		stdout, _, code, err := r.Sandbox.Exec(fmt.Sprintf("ls -la '%s' 2>&1", dirPath), "")
		if err != nil || code != 0 {
			return ExecutionResult{Error: fmt.Sprintf("cannot access '%s': no such file or directory", dirPath)}
		}
		return ExecutionResult{Output: stdout}
	}

	path := r.resolvePath(str(args, "path"))
	entries, err := os.ReadDir(path)
	if err != nil {
		return ExecutionResult{Error: err.Error()}
	}

	var out strings.Builder
	for _, e := range entries {
		info, _ := e.Info()
		kind := "file"
		if e.IsDir() {
			kind = "dir "
		}
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		fmt.Fprintf(&out, "%s  %8d  %s\n", kind, size, e.Name())
	}
	return ExecutionResult{Output: out.String()}
}
