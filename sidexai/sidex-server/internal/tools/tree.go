package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func init_tree(r *Registry) {
	r.tools["tree"] = Tool{
		Name: "tree",
		Description: `Show a directory's file structure as an indented tree up to a given depth. Use this as a first step when exploring an unfamiliar codebase to understand its layout and organization.

Automatically skips noise directories (.git, node_modules, target, __pycache__). For large repos, keep depth low (2-3) to avoid overwhelming output. Use list_dir for a single level, or glob/grep to find specific files by name or content.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":  map[string]interface{}{"type": "string", "description": "Root directory (default cwd)."},
				"depth": map[string]interface{}{"type": "integer", "description": "Max depth (default 3)."},
			},
		},
	}
}

func (r *Registry) tree(args map[string]interface{}) ExecutionResult {
	// When sandbox is active, use find inside the sandbox
	if r.Sandbox != nil && r.Sandbox.Active {
		dirPath := strOr(args, "path", "/app")
		depth := intOr(args, "depth", 3)
		stdout, _, _, err := r.Sandbox.Exec(
			fmt.Sprintf("find '%s' -maxdepth %d 2>/dev/null | head -200", dirPath, depth), "")
		if err != nil {
			stdout, _, _, _ = r.Sandbox.Exec("ls /app 2>/dev/null || ls /", "")
		}
		return ExecutionResult{Output: stdout}
	}

	dir := r.resolvePath(strOr(args, "path", "."))
	depth := intOr(args, "depth", 3)

	var out strings.Builder
	r.buildTree(&out, dir, "", 0, depth)
	return ExecutionResult{Output: out.String()}
}

func (r *Registry) buildTree(out *strings.Builder, dir, prefix string, level, maxDepth int) {
	if level >= maxDepth {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for i, e := range entries {
		name := e.Name()
		if name == ".git" || name == "node_modules" || name == "target" || name == "__pycache__" {
			continue
		}
		isLast := i == len(entries)-1
		connector := "├── "
		if isLast {
			connector = "└── "
		}
		fmt.Fprintf(out, "%s%s%s\n", prefix, connector, name)
		if e.IsDir() {
			nextPrefix := prefix + "│   "
			if isLast {
				nextPrefix = prefix + "    "
			}
			r.buildTree(out, filepath.Join(dir, name), nextPrefix, level+1, maxDepth)
		}
	}
}
