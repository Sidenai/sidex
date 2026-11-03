package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func init_search_files(r *Registry) {
	r.tools["search_files"] = Tool{
		Name: "search_files",
		Description: `Find files by filename pattern, searching recursively and skipping noise directories (.git, node_modules, target, __pycache__, .next). Returns relative paths capped at 200 results.

Use this for simple filename matches (e.g. '*.go', 'Dockerfile', 'Makefile'). Unlike glob, this tool automatically skips common build/dependency directories. For searching file contents, use grep instead.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"pattern": map[string]interface{}{"type": "string", "description": "Filename glob, e.g. '*.go' or 'Dockerfile'."},
				"path":    map[string]interface{}{"type": "string", "description": "Start directory (defaults to cwd)."},
			},
			"required": []string{"pattern"},
		},
	}
}

func (r *Registry) searchFiles(args map[string]interface{}) ExecutionResult {
	pattern := str(args, "pattern")
	dir := r.resolvePath(strOr(args, "path", "."))

	var matches []string
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			name := info.Name()
			if name == ".git" || name == "node_modules" || name == "target" || name == "__pycache__" || name == ".next" {
				return filepath.SkipDir
			}
			return nil
		}
		matched, _ := filepath.Match(pattern, info.Name())
		if matched {
			rel, _ := filepath.Rel(r.cwd, path)
			matches = append(matches, rel)
		}
		if len(matches) > 200 {
			return fmt.Errorf("too many matches")
		}
		return nil
	})
	return ExecutionResult{Output: strings.Join(matches, "\n")}
}
